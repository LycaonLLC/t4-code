import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildTailscaleHttpsBaseUrl,
  discoverTailscaleExecutable,
  NodeProcessRunner,
  readTailscaleStatus,
  runProcess,
  suggestTailscaleServe,
  type ProcessRunner,
} from "@t4-code/remote";
import type { PhoneSetupState } from "@t4-code/protocol/desktop-ipc";

const LOCAL_GATEWAY_PORT = 4_194;
const TAILSCALE_HTTPS_PORT = 8_445;

export interface PhoneSetupServiceOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly resourcesPath: string;
  readonly electronExecutable: string;
  readonly runner?: ProcessRunner;
  readonly discoverTailscale?: () => Promise<string>;
}

export class PhoneSetupService {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly resourcesPath: string;
  private readonly electronExecutable: string;
  private readonly runner: ProcessRunner;
  private readonly tailscaleExecutable: () => Promise<string>;
  private operation: Promise<PhoneSetupState> | undefined;

  constructor(options: PhoneSetupServiceOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.resourcesPath = options.resourcesPath;
    this.electronExecutable = options.electronExecutable;
    this.runner = options.runner ?? new NodeProcessRunner();
    this.tailscaleExecutable = options.discoverTailscale ?? (() => discoverTailscaleExecutable({ platform: this.platform }));
  }

  inspect(): Promise<PhoneSetupState> {
    return this.inspectInternal();
  }

  configure(): Promise<PhoneSetupState> {
    if (this.operation) return this.operation;
    const operation = this.configureInternal().catch((error: unknown) => ({
      phase: "error" as const,
      message: error instanceof Error ? error.message.slice(0, 512) : "Phone setup could not be completed.",
    }));
    this.operation = operation;
    void operation.finally(() => { if (this.operation === operation) this.operation = undefined; });
    return operation;
  }

  restore(): Promise<PhoneSetupState> {
    if (this.operation) return this.operation;
    const operation = this.restoreInternal().catch((error: unknown) => ({
      phase: "error" as const,
      message: error instanceof Error ? error.message.slice(0, 512) : "Phone access could not be restored.",
    }));
    this.operation = operation;
    void operation.finally(() => { if (this.operation === operation) this.operation = undefined; });
    return operation;
  }

  private unsupported(): PhoneSetupState | undefined {
    if (this.platform !== "darwin" || this.arch !== "arm64") {
      return { phase: "unsupported", message: "One-click phone setup currently requires the Apple Silicon Mac app." };
    }
    return undefined;
  }

  private async identity(): Promise<string> {
    const manifest = await readFile(join(this.resourcesPath, "runtime", "manifest.json"));
    return `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  }

  private async tailscaleFacts(): Promise<{ executable: string; url: string }> {
    const executable = await this.tailscaleExecutable();
    const status = await readTailscaleStatus({ runner: this.runner, executable, timeoutMs: 3_000 });
    if (!status.magicDnsName) throw new Error("Tailscale is not connected or MagicDNS is unavailable.");
    return { executable, url: buildTailscaleHttpsBaseUrl({ magicDnsName: status.magicDnsName, servePort: TAILSCALE_HTTPS_PORT }) };
  }

  private async runGatewayService(args: readonly string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return runProcess({
      runner: this.runner,
      command: this.electronExecutable,
      args: [join(this.resourcesPath, "gateway", "tailnet-service.mjs"), ...args],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ELECTRON_RUN_AS_NODE: "1" },
      timeoutMs: 20_000,
    });
  }

  private async gatewayIsHealthy(): Promise<boolean> {
    try {
      const service = await this.runGatewayService(["status"]);
      return service.exitCode === 0 && /health:\s*healthy/iu.test(service.stdout);
    } catch {
      return false;
    }
  }

  private async waitForHealthyGateway(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (await this.gatewayIsHealthy()) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
    return false;
  }

  private async hasExpectedServe(executable: string, url: string): Promise<boolean> {
    try {
      const result = await runProcess({
        runner: this.runner,
        command: executable,
        args: ["serve", "status", "--json"],
        timeoutMs: 3_000,
      });
      if (result.exitCode !== 0 || result.stderr.trim().length > 0) return false;
      const parsed: unknown = JSON.parse(result.stdout);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const record = parsed as Record<string, unknown>;
      const tcp = record.TCP;
      const web = record.Web;
      if (tcp === null || typeof tcp !== "object" || Array.isArray(tcp)) return false;
      if (web === null || typeof web !== "object" || Array.isArray(web)) return false;
      const destination = new URL(url);
      const port = destination.port || "443";
      const tcpPort = (tcp as Record<string, unknown>)[port];
      if (tcpPort === null || typeof tcpPort !== "object" || Array.isArray(tcpPort)) return false;
      if ((tcpPort as Record<string, unknown>).HTTPS !== true) return false;
      const authority = destination.port ? `${destination.hostname}:${destination.port}` : destination.hostname;
      const webRoute = (web as Record<string, unknown>)[authority];
      if (webRoute === null || typeof webRoute !== "object" || Array.isArray(webRoute)) return false;
      const handlers = (webRoute as Record<string, unknown>).Handlers;
      if (handlers === null || typeof handlers !== "object" || Array.isArray(handlers)) return false;
      const root = (handlers as Record<string, unknown>)["/"];
      return root !== null && typeof root === "object" && !Array.isArray(root)
        && (root as Record<string, unknown>).Proxy === `http://127.0.0.1:${LOCAL_GATEWAY_PORT}`;
    } catch {
      return false;
    }
  }

  private async inspectInternal(): Promise<PhoneSetupState> {
    const unsupported = this.unsupported();
    if (unsupported) return unsupported;
    let facts: { executable: string; url: string };
    try {
      facts = await this.tailscaleFacts();
    } catch {
      return { phase: "tailscale-required", message: "Install and connect Tailscale on this Mac to enable private phone access." };
    }
    try {
      const service = await this.runGatewayService(["status"]);
      const expectedServe = await this.hasExpectedServe(facts.executable, facts.url);
      if (
        service.exitCode === 0
        && /health:\s*healthy/iu.test(service.stdout)
        && expectedServe
      ) {
        return { phase: "ready", message: "Phone access is ready on your private Tailscale network.", url: facts.url };
      }
      if (expectedServe && /health:\s*unhealthy/iu.test(service.stdout)) {
        return {
          phase: "error",
          message: "Phone access is installed, but the local OMP runtime is not ready. Open Hosts, restart the default OMP profile, then check again.",
          url: facts.url,
        };
      }
    } catch {}
    return { phase: "not-configured", message: "Set up private phone access, then scan the QR code with your phone.", url: facts.url };
  }

  private async configureInternal(): Promise<PhoneSetupState> {
    const unsupported = this.unsupported();
    if (unsupported) return unsupported;
    let facts: { executable: string; url: string };
    try {
      facts = await this.tailscaleFacts();
    } catch (error) {
      return { phase: "tailscale-required", message: error instanceof Error ? error.message : "Tailscale is unavailable." };
    }
    const service = await this.runGatewayService([
      "install",
      "--origin", facts.url,
      "--web-root", join(this.resourcesPath, "web"),
      "--deployment-identity", await this.identity(),
      "--electron-run-as-node",
    ]);
    if (service.exitCode !== 0) {
      return { phase: "error", message: service.stderr.trim().slice(0, 512) || "The private phone gateway could not start." };
    }
    const serve = suggestTailscaleServe({
      localPort: LOCAL_GATEWAY_PORT,
      servePort: TAILSCALE_HTTPS_PORT,
      executable: facts.executable,
    });
    const result = await runProcess({ runner: this.runner, command: serve.executable, args: serve.args, timeoutMs: 10_000 });
    if (result.exitCode !== 0) {
      return { phase: "error", message: result.stderr.trim().slice(0, 512) || "Tailscale Serve could not expose the private gateway." };
    }
    if (!await this.hasExpectedServe(facts.executable, facts.url)) {
      return { phase: "error", message: "Tailscale Serve did not keep the expected private phone route." };
    }
    if (!await this.waitForHealthyGateway()) {
      return {
        phase: "error",
        message: "Phone access was installed, but the local OMP runtime is not ready. Open Hosts, restart the default OMP profile, then check again.",
        url: facts.url,
      };
    }
    return { phase: "ready", message: "Phone access is ready on your private Tailscale network.", url: facts.url };
  }

  private async restoreInternal(): Promise<PhoneSetupState> {
    const unsupported = this.unsupported();
    if (unsupported) return unsupported;
    let facts: { executable: string; url: string };
    try {
      facts = await this.tailscaleFacts();
    } catch (error) {
      return { phase: "tailscale-required", message: error instanceof Error ? error.message : "Tailscale is unavailable." };
    }
    if (!await this.hasExpectedServe(facts.executable, facts.url)) {
      return { phase: "not-configured", message: "Set up private phone access, then scan the QR code with your phone.", url: facts.url };
    }
    const service = await this.runGatewayService([
      "install",
      "--origin", facts.url,
      "--web-root", join(this.resourcesPath, "web"),
      "--deployment-identity", await this.identity(),
      "--electron-run-as-node",
    ]);
    if (service.exitCode !== 0) {
      return { phase: "error", message: service.stderr.trim().slice(0, 512) || "The private phone gateway could not restart." };
    }
    if (!await this.waitForHealthyGateway()) {
      return {
        phase: "error",
        message: "Phone access restarted, but the local OMP runtime is not ready yet. Open Hosts, restart the default OMP profile, then check again.",
        url: facts.url,
      };
    }
    return { phase: "ready", message: "Phone access is ready on your private Tailscale network.", url: facts.url };
  }
}
