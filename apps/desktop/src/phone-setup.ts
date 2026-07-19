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
      if (service.exitCode === 0 && /health:\s*healthy/iu.test(service.stdout)) {
        return { phase: "ready", message: "Phone access is ready on your private Tailscale network.", url: facts.url };
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
    return { phase: "ready", message: "Phone access is ready on your private Tailscale network.", url: facts.url };
  }
}
