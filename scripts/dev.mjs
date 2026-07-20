import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const READINESS_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const SHUTDOWN_KILL_WAIT_MS = 1_000;
const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmEntrypoint = process.env.npm_execpath;

if (!pnpmEntrypoint) {
  throw new Error("pnpm dev must provide npm_execpath so the current pnpm executable can be reused.");
}

const requestedRendererPort = parseRequestedPort(process.env.T4_DEV_RENDERER_PORT);
const managedProcesses = new Set();
let shuttingDown = false;
let shutdownPromise;
let resolveShutdownStarted;
const shutdownStarted = new Promise((resolvePromise) => {
  resolveShutdownStarted = resolvePromise;
});
let exitCode = 0;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) {
      return;
    }

    console.log(`\n[dev] Received ${signal}; stopping dev processes.`);
    void shutdown({ signal });
  });
}

async function main() {
  const build = startPnpm("desktop build", ["--filter", "@t4-code/desktop", "build"]);
  const buildResult = await build.completed;
  managedProcesses.delete(build);

  if (shuttingDown) {
    await shutdownPromise;
    return;
  }

  if (!completedSuccessfully(buildResult)) {
    throw new Error(`Desktop build ${describeCompletion(buildResult)}.`);
  }

  let reservation = await reservePort(requestedRendererPort);
  const rendererUrl = `http://${HOST}:${reservation.port}/`;

  try {
    if (shuttingDown) {
      await shutdownPromise;
      return;
    }

    console.log(`[dev] Renderer URL: ${rendererUrl}`);
    await reservation.release();
    reservation = undefined;

    const web = startPnpm("web dev server", [
      "--filter",
      "@t4-code/web",
      "exec",
      "vp",
      "dev",
      "--host",
      HOST,
      "--port",
      String(portFromUrl(rendererUrl)),
      "--strictPort",
    ]);
    supervise(web);

    const rendererReady = await Promise.race([
      waitForRenderer(rendererUrl).then(() => "ready"),
      shutdownStarted.then(() => "shutdown"),
    ]);

    if (rendererReady === "shutdown") {
      await shutdownPromise;
      return;
    }

    if (shuttingDown) {
      await shutdownPromise;
      return;
    }

    const desktopEnvironment = { ...process.env, OMP_DESKTOP_RENDERER_URL: rendererUrl };
    delete desktopEnvironment.ELECTRON_RUN_AS_NODE;

    const desktop = startPnpm("desktop dev process", ["--filter", "@t4-code/desktop", "dev"], desktopEnvironment);
    supervise(desktop);

    await shutdownStarted;
    await shutdownPromise;
  } finally {
    if (reservation) {
      await reservation.release();
    }
  }
}

function startPnpm(label, args, environment = process.env) {
  const child = spawn(process.execPath, [pnpmEntrypoint, ...args], {
    cwd: rootDirectory,
    env: environment,
    stdio: "inherit",
    shell: false,
    detached: process.platform !== "win32",
  });

  let settle;
  const processRecord = {
    label,
    child,
    exited: false,
    completed: new Promise((resolvePromise) => {
      settle = resolvePromise;
    }),
  };

  const complete = (result) => {
    if (processRecord.exited) {
      return;
    }

    processRecord.exited = true;
    settle(result);
  };

  child.once("error", (error) => complete({ error }));
  child.once("exit", (code, signal) => complete({ code, signal }));
  managedProcesses.add(processRecord);
  return processRecord;
}

function supervise(processRecord) {
  void processRecord.completed.then((result) => {
    if (shuttingDown) {
      return;
    }

    console.error(`[dev] ${processRecord.label} ${describeCompletion(result)}; stopping dev processes.`);
    void shutdown({ unexpected: true });
  });
}

function parseRequestedPort(value) {
  if (value === undefined) {
    return 0;
  }

  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new Error("T4_DEV_RENDERER_PORT must be an integer from 1 through 65535.");
  }

  const port = Number(value);
  if (port > 65_535) {
    throw new Error("T4_DEV_RENDERER_PORT must be an integer from 1 through 65535.");
  }

  return port;
}

async function reservePort(port) {
  const server = createServer();

  await new Promise((resolvePromise, reject) => {
    const fail = (error) => {
      server.off("listening", listen);
      reject(error);
    };
    const listen = () => {
      server.off("error", fail);
      resolvePromise();
    };

    server.once("error", fail);
    server.once("listening", listen);
    server.listen({ host: HOST, port, exclusive: true });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Unable to reserve a TCP renderer port.");
  }

  let released = false;
  return {
    port: address.port,
    async release() {
      if (released) {
        return;
      }

      released = true;
      await closeServer(server);
    },
  };
}

async function waitForRenderer(rendererUrl) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastError;

  while (Date.now() < deadline) {
    if (shuttingDown) {
      return;
    }

    try {
      const response = await fetch(rendererUrl, {
        signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))),
      });
      await response.body?.cancel();

      if (response.ok) {
        return;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await delay(Math.min(200, Math.max(1, deadline - Date.now())));
  }

  const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(`Timed out waiting ${READINESS_TIMEOUT_MS}ms for the renderer at ${rendererUrl}${detail}.`);
}

function portFromUrl(rendererUrl) {
  const port = new URL(rendererUrl).port;
  if (!port) {
    throw new Error(`Renderer URL does not contain a port: ${rendererUrl}`);
  }

  return Number(port);
}

function completedSuccessfully(result) {
  return !result.error && result.code === 0 && result.signal === null;
}

function describeCompletion(result) {
  if (result.error) {
    return `could not start (${result.error.message})`;
  }

  if (result.signal) {
    return `exited from ${result.signal}`;
  }

  return `exited with code ${result.code}`;
}

function closeServer(server) {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolvePromise();
    });
  });
}

function shutdown({ signal = "SIGTERM", unexpected = false }) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shuttingDown = true;
  exitCode = unexpected ? 1 : signal === "SIGINT" ? 130 : 143;
  resolveShutdownStarted();
  shutdownPromise = stopManagedProcesses(signal).catch((error) => {
    console.error(`[dev] Failed to stop every dev process: ${error.message}`);
    exitCode = 1;
  });
  return shutdownPromise;
}

async function stopManagedProcesses(signal) {
  const processes = [...managedProcesses];

  if (process.platform === "win32") {
    for (const processRecord of processes) {
      sendSignal(processRecord, signal);
    }

    await delay(SHUTDOWN_GRACE_MS);
    await Promise.all(processes.map((processRecord) => terminateWindowsTree(processRecord)));
    return;
  }

  for (const processRecord of processes) {
    sendSignal(processRecord, signal);
  }

  const stoppedGracefully = await waitForProcessGroupsToExit(processes, SHUTDOWN_GRACE_MS);
  if (stoppedGracefully) {
    return;
  }

  for (const processRecord of processes) {
    if (processGroupExists(processRecord)) {
      sendSignal(processRecord, "SIGKILL");
    }
  }

  await waitForProcessGroupsToExit(processes, SHUTDOWN_KILL_WAIT_MS);
}

function sendSignal(processRecord, signal) {
  const { child } = processRecord;
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    if (!processRecord.exited) {
      child.kill(signal);
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function waitForProcessGroupsToExit(processes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (processes.every((processRecord) => !processGroupExists(processRecord))) {
      return true;
    }

    await delay(100);
  }

  return processes.every((processRecord) => !processGroupExists(processRecord));
}

function processGroupExists(processRecord) {
  const { pid } = processRecord.child;
  if (!pid) {
    return false;
  }

  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function terminateWindowsTree(processRecord) {
  const { pid } = processRecord.child;
  if (!pid) {
    return Promise.resolve();
  }

  return new Promise((resolvePromise) => {
    const taskkill = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once("error", resolvePromise);
    taskkill.once("exit", resolvePromise);
  });
}

await main().catch(async (error) => {
  if (!shuttingDown) {
    console.error(`[dev] ${error.message}`);
    await shutdown({ unexpected: true });
  } else if (shutdownPromise) {
    await shutdownPromise;
  }
});

process.exitCode = exitCode;
