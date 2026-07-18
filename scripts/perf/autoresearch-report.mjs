import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("usage: node scripts/perf/autoresearch-report.mjs <core-report.json>");

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
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

const event = metrics.get("projection.event-ns-per-event");
const eventDuration = metrics.get("projection.events");
const snapshot = metrics.get("projection.snapshot");
const heap = metrics.get("projection.events-heap-growth");
const artifact = relative(repoRoot, resolve(reportPath));

const lines = [
  `METRIC projection_event_ns_per_event=${event.median}`,
  `METRIC projection_event_p95_ns_per_event=${event.p95}`,
  `METRIC projection_events_ms=${eventDuration.median}`,
  `METRIC projection_snapshot_ms=${snapshot.median}`,
  `METRIC projection_event_heap_growth_bytes=${heap.median}`,
  `ASI source_tree_hash=${sourceHash.digest("hex")}`,
  `ASI source_commit=${report.machine.commit}`,
  `ASI source_dirty=${report.machine.dirty}`,
  "ASI build_mode=vite-plus-test-transform",
  `ASI workload=history-${report.scenario.entryCount}-events-${report.scenario.eventCount}-v1`,
  `ASI repetitions=${report.scenario.repetitions}`,
  `ASI warmups=${report.scenario.warmups}`,
  `ASI event_samples_ns_per_event=${JSON.stringify(event.samples)}`,
  `ASI artifact=${artifact}`,
];
process.stdout.write(`${lines.join("\n")}\n`);
