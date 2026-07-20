import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const rendererStartupTimeoutMs = 30_000;
const rendererPollIntervalMs = 100;

export function sanitizeEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  delete sanitized.ELECTRON_RUN_AS_NODE;
  return sanitized;
}

export function validateLoopbackRendererUrl(value) {
  if (value === undefined) return undefined;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OMP_DESKTOP_RENDERER_URL must be a loopback HTTP URL");
  }

  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback) {
    throw new Error("OMP_DESKTOP_RENDERER_URL must be a loopback HTTP URL");
  }

  return url;
}

export async function waitForRenderer(value, {
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = rendererStartupTimeoutMs,
  intervalMs = rendererPollIntervalMs,
} = {}) {
  const url = validateLoopbackRendererUrl(value);
  if (url === undefined) return;

  const deadline = now() + timeoutMs;
  while (true) {
    try {
      const response = await fetchImpl(url, { method: "HEAD" });
      if (response.ok) return;
    } catch {
      // The renderer process is still starting.
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }

  throw new Error(`Renderer did not become ready at ${url.origin}`);
}

export function startElectron({
  cwd = join(import.meta.dirname, ".."),
  electron,
  environment = process.env,
  spawnProcess = spawn,
  processRef = process,
} = {}) {
  const require = createRequire(import.meta.url);
  const executable = electron ?? environment.ELECTRON_BIN ?? require("electron");
  const child = spawnProcess(executable, [join(cwd, "dist-electron", "main.cjs")], {
    cwd,
    env: sanitizeEnvironment(environment),
    stdio: "inherit",
    shell: false,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let forwarded = false;

    const terminate = (signal) => {
      if (!settled && !child.killed) child.kill(signal);
    };
    const forwardSignal = (signal) => {
      if (forwarded) return;
      forwarded = true;
      terminate(signal);
    };
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");
    const onProcessExit = () => terminate("SIGTERM");
    const cleanup = () => {
      processRef.removeListener("SIGINT", onSigint);
      processRef.removeListener("SIGTERM", onSigterm);
      processRef.removeListener("exit", onProcessExit);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    processRef.once("SIGINT", onSigint);
    processRef.once("SIGTERM", onSigterm);
    processRef.once("exit", onProcessExit);
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code, signal) => settle(() => resolve({ code, signal })));
  });
}

export async function main(options = {}) {
  const environment = sanitizeEnvironment(options.environment);
  await waitForRenderer(environment.OMP_DESKTOP_RENDERER_URL, options);
  return startElectron({ ...options, environment });
}

function isExecutedDirectly() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isExecutedDirectly()) {
  main().then(
    ({ code }) => {
      process.exitCode = code ?? 1;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
