import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("usage: node scripts/perf/autoresearch-report.mjs <core-report.json>");

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const reportFile = resolve(reportPath);
const reportContents = readFileSync(reportFile);
const report = JSON.parse(reportContents.toString("utf8"));
if (report.kind !== "core") throw new Error(`expected a core report, received ${report.kind}`);

const metrics = new Map(report.metrics.map((metric) => [metric.name, metric]));
const required = [
  "projection.snapshot",
  "projection.events",
  "projection.event-ns-per-event",
  "projection.events-heap-growth",
];
for (const name of required) {
  if (!metrics.has(name)) throw new Error(`core report is missing ${name}`);
}

const sourcePaths = [
  "packages/client/src/projection.ts",
  "packages/client/src/transcript-retention.ts",
];
const sourceHash = createHash("sha256");
for (const sourcePath of sourcePaths) {
  sourceHash.update(sourcePath);
  sourceHash.update("\0");
  sourceHash.update(readFileSync(resolve(repoRoot, sourcePath)));
  sourceHash.update("\0");
}
const sourceTreeHash = sourceHash.digest("hex");

const event = metrics.get("projection.event-ns-per-event");
const eventDuration = metrics.get("projection.events");
const snapshot = metrics.get("projection.snapshot");
const heap = metrics.get("projection.events-heap-growth");
const artifact = relative(repoRoot, reportFile);
const buildMode = "vite-plus-test-transform";
const workload = `history-${report.scenario.entryCount}-events-${report.scenario.eventCount}-v1`;
const timeoutSeconds = Number.parseInt(
  process.env.T4_AUTORESEARCH_TIMEOUT_SECONDS_RESOLVED ?? "",
  10,
);
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) {
  throw new Error("missing resolved autoresearch timeout");
}
const cpuAffinity = process.env.T4_AUTORESEARCH_CPU_AFFINITY_RESOLVED;
if (!cpuAffinity) throw new Error("missing resolved autoresearch CPU affinity");

const evidenceFile = resolve(dirname(reportFile), "evidence.json");
const evidenceArtifact = relative(repoRoot, evidenceFile);
writeFileSync(
  evidenceFile,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      source: {
        treeHash: sourceTreeHash,
        commit: report.machine.commit,
        dirty: report.machine.dirty,
      },
      execution: {
        buildMode,
        workload,
        repetitions: report.scenario.repetitions,
        warmups: report.scenario.warmups,
        timeoutSeconds,
        cpuAffinity,
      },
      artifact: {
        path: artifact,
        sha256: createHash("sha256").update(reportContents).digest("hex"),
      },
    },
    null,
    2,
  )}\n`,
);

const lines = [
  `METRIC projection_event_ns_per_event=${event.median}`,
  `METRIC projection_event_p95_ns_per_event=${event.p95}`,
  `METRIC projection_events_ms=${eventDuration.median}`,
  `METRIC projection_snapshot_ms=${snapshot.median}`,
  `METRIC projection_event_heap_growth_bytes=${heap.median}`,
  `ASI source_tree_hash=${sourceTreeHash}`,
  `ASI source_commit=${report.machine.commit}`,
  `ASI source_dirty=${report.machine.dirty}`,
  `ASI build_mode=${buildMode}`,
  `ASI workload=${workload}`,
  `ASI repetitions=${report.scenario.repetitions}`,
  `ASI warmups=${report.scenario.warmups}`,
  `ASI event_samples_ns_per_event=${JSON.stringify(event.samples)}`,
  `ASI artifact=${artifact}`,
  `ASI evidence=${evidenceArtifact}`,
];
process.stdout.write(`${lines.join("\n")}\n`);
