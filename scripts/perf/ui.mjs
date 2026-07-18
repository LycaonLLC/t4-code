import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { positiveInteger, summarize, writeReport } from "./report.mjs";

const require = createRequire(import.meta.url);
const playwrightCli = require.resolve("@playwright/test/cli");
const repetitions = positiveInteger(process.env.T4_PERF_REPETITIONS, 3, "repetitions");
const durations = [];

function executeOnce() {
  return new Promise((resolveRun, reject) => {
    const environment = { ...process.env, CI: "1" };
    delete environment.T4_E2E_BROWSER_CHANNEL;
    const child = spawn(
      process.execPath,
      [
        playwrightCli,
        "test",
        "e2e/remote-app.spec.ts",
        "--grep",
        "mounts the bounded tail of a 10k history",
        "--retries=0",
        "--reporter=json",
      ],
      {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`UI benchmark failed with exit ${code}\n${stderr}\n${stdout.slice(-4000)}`));
        return;
      }
      try {
        const report = JSON.parse(stdout);
        const resultDurations = [];
        const visit = (suite) => {
          for (const spec of suite.specs ?? []) {
            for (const test of spec.tests ?? []) {
              for (const result of test.results ?? []) resultDurations.push(result.duration);
            }
          }
          for (const childSuite of suite.suites ?? []) visit(childSuite);
        };
        for (const suite of report.suites ?? []) visit(suite);
        if (resultDurations.length !== 1 || !Number.isFinite(resultDurations[0])) {
          throw new Error("Playwright report did not contain exactly one test duration");
        }
        resolveRun(resultDurations[0]);
      } catch (error) {
        reject(new Error(`could not decode Playwright JSON report: ${error}\n${stdout.slice(-4000)}`));
      }
    });
  });
}

for (let index = 0; index < repetitions; index += 1) durations.push(await executeOnce());

writeReport(
  "ui",
  [{ name: "ui.mount-bounded-10k", direction: "lower", ...summarize(durations) }],
  {
    scenario: {
      fixture: "history-10k-v1",
      viewport: { width: 390, height: 844 },
      repetitions,
      note: "Playwright test duration is a stable end-to-end regression signal, not frame latency.",
    },
  },
);
