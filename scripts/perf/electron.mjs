import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { _electron as electron } from "@playwright/test";
import { electronMemoryKilobytes, positiveInteger, summarize, writeReport } from "./report.mjs";

const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const electronExecutable = desktopRequire("electron");
const mainEntry = resolve("apps/desktop/dist-electron/main.cjs");
const repetitions = positiveInteger(process.env.T4_PERF_REPETITIONS, 5, "repetitions");
const launchDurations = [];
const settledMemoryBytes = [];

const webRoot = resolve("apps/web/dist");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://perf.invalid").pathname);
  const requestedPath = resolve(webRoot, pathname === "/" ? "index.html" : `.${pathname}`);
  const contained = requestedPath === webRoot || requestedPath.startsWith(`${webRoot}${sep}`);
  const filePath = contained && statSync(requestedPath, { throwIfNoEntry: false })?.isFile()
    ? requestedPath
    : join(webRoot, "index.html");
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": contentTypes.get(extname(filePath)) ?? "application/octet-stream",
  });
  response.end(readFileSync(filePath));
});
await new Promise((resolveStart, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveStart);
});
const serverAddress = server.address();
if (serverAddress === null || typeof serverAddress === "string") {
  throw new Error("Electron benchmark server did not expose a TCP port");
}
const rendererUrl = `http://127.0.0.1:${serverAddress.port}`;

try {
  for (let index = 0; index < repetitions; index += 1) {
    const userDataDirectory = mkdtempSync(join(tmpdir(), "t4-electron-perf-"));
    let electronApplication;
    try {
      const environment = { ...process.env, OMP_DESKTOP_RENDERER_URL: rendererUrl };
      delete environment.ELECTRON_RUN_AS_NODE;
      const startedAt = performance.now();
      electronApplication = await electron.launch({
        executablePath: electronExecutable,
        args: [mainEntry, `--user-data-dir=${userDataDirectory}`],
        chromiumSandbox: true,
        env: environment,
        timeout: 30_000,
      });
      const window = await electronApplication.firstWindow({ timeout: 30_000 });
      await window.waitForLoadState("domcontentloaded");
      await window.locator("body").waitFor({ state: "visible" });
      launchDurations.push(performance.now() - startedAt);
      await window.waitForTimeout(500);
      const metrics = await electronApplication.evaluate(({ app }) => app.getAppMetrics());
      settledMemoryBytes.push(
        metrics.reduce((sum, metric) => sum + electronMemoryKilobytes(metric.memory) * 1024, 0),
      );
    } finally {
      await electronApplication?.close().catch(() => undefined);
      rmSync(userDataDirectory, { recursive: true, force: true });
    }
  }
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}

writeReport(
  "electron",
  [
    { name: "electron.cold-launch", direction: "lower", ...summarize(launchDurations) },
    {
      name: "electron.settled-working-set",
      direction: "lower",
      ...summarize(settledMemoryBytes, "bytes"),
    },
  ],
  {
    scenario: {
      repetitions,
      display: process.env.DISPLAY ?? "native",
      note: "Source-build renderer over loopback. Linux/Xvfb results are regression signals, not packaged macOS launch claims.",
    },
  },
);
