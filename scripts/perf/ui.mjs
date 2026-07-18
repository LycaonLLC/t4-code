import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { positiveInteger, summarize, writeReport } from "./report.mjs";

const require = createRequire(import.meta.url);
const playwrightCli = require.resolve("@playwright/test/cli");
const repetitions = positiveInteger(process.env.T4_PERF_REPETITIONS, 3, "repetitions");
const durations = [];
const phaseSamples = {
  navigationDomContentLoaded: [],
  connectedAfterDomContentLoaded: [],
  sessionClickToTranscriptVisible: [],
  sessionClickToRealListVisible: [],
  sessionClickToTailPainted: [],
};
const phaseDirectory = mkdtempSync(join(tmpdir(), "t4-browser-paint-perf-"));

function executeOnce(index) {
  return new Promise((resolveRun, reject) => {
    const phaseOutput = join(phaseDirectory, `phases-${index}.json`);
    const environment = { ...process.env, CI: "1", T4_PERF_PHASE_OUTPUT: phaseOutput };
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
        const phases = JSON.parse(readFileSync(phaseOutput, "utf8"));
        for (const phaseName of Object.keys(phaseSamples)) {
          if (!Number.isFinite(phases[phaseName]) || phases[phaseName] < 0) {
            throw new Error(`invalid browser paint phase: ${phaseName}`);
          }
        }
        resolveRun({ duration: resultDurations[0], phases });
      } catch (error) {
        reject(new Error(`could not decode Playwright JSON report: ${error}\n${stdout.slice(-4000)}`));
      }
    });
  });
}

try {
  for (let index = 0; index < repetitions; index += 1) {
    const result = await executeOnce(index);
    durations.push(result.duration);
    for (const phaseName of Object.keys(phaseSamples)) {
      phaseSamples[phaseName].push(result.phases[phaseName]);
    }
  }
} finally {
  rmSync(phaseDirectory, { recursive: true, force: true });
}

writeReport(
  "ui",
  [
    { name: "ui.mount-bounded-10k", direction: "lower", ...summarize(durations) },
    {
      name: "browser.navigation-dom-content-loaded",
      direction: "lower",
      ...summarize(phaseSamples.navigationDomContentLoaded),
    },
    {
      name: "browser.connected-after-dom-content-loaded",
      direction: "lower",
      ...summarize(phaseSamples.connectedAfterDomContentLoaded),
    },
    {
      name: "browser.session-click-to-transcript-visible",
      direction: "lower",
      ...summarize(phaseSamples.sessionClickToTranscriptVisible),
    },
    {
      name: "browser.session-click-to-real-list-visible",
      direction: "lower",
      ...summarize(phaseSamples.sessionClickToRealListVisible),
    },
    {
      name: "browser.session-click-to-tail-painted",
      direction: "lower",
      ...summarize(phaseSamples.sessionClickToTailPainted),
    },
  ],
  {
    scenario: {
      fixture: "history-10k-v1",
      viewport: { width: 390, height: 844 },
      repetitions,
      note: "Browser phases use the renderer performance clock. Tail painted is sampled after the real list is visible and two animation frames have elapsed.",
    },
  },
);
