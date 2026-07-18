import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function percentile(sorted, fraction) {
  if (sorted.length === 0) throw new Error("cannot calculate a percentile without samples");
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

export function summarize(samples, unit = "ms") {
  if (samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("benchmark samples must be finite non-negative numbers");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    unit,
    samples: sorted,
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
    mean: total / sorted.length,
  };
}

export async function sample(name, operation, options = {}) {
  const warmups = options.warmups ?? 1;
  const repetitions = options.repetitions ?? 5;
  for (let index = 0; index < warmups; index += 1) await operation();
  const values = [];
  for (let index = 0; index < repetitions; index += 1) {
    globalThis.gc?.();
    const startedAt = performance.now();
    await operation();
    values.push(performance.now() - startedAt);
  }
  return { name, direction: "lower", ...summarize(values) };
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function machineMetadata() {
  const processors = cpus();
  const sourceDirty = process.env.T4_PERF_SOURCE_DIRTY;
  return {
    machineLabel: process.env.T4_PERF_MACHINE_LABEL ?? "unlabeled",
    platform: platform(),
    release: release(),
    architecture: process.arch,
    cpuModel: processors[0]?.model ?? "unknown",
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
    node: process.version,
    commit: process.env.T4_PERF_SOURCE_COMMIT ?? gitValue(["rev-parse", "HEAD"]),
    dirty: sourceDirty === undefined ? gitValue(["status", "--porcelain"]) !== "" : sourceDirty === "true",
  };
}

export function outputDirectory() {
  return resolve(REPO_ROOT, process.env.T4_PERF_OUTPUT_DIR ?? "test-results/perf");
}

export function writeReport(kind, metrics, extra = {}) {
  const output = outputDirectory();
  mkdirSync(output, { recursive: true });
  const createdAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    kind,
    createdAt,
    machine: machineMetadata(),
    metrics,
    ...extra,
  };
  const timestamp = createdAt.replaceAll(":", "-");
  const versionedPath = join(output, `${timestamp}-${kind}.json`);
  const latestPath = join(output, `latest-${kind}.json`);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(versionedPath, serialized);
  writeFileSync(latestPath, serialized);
  process.stdout.write(`${JSON.stringify({ report: versionedPath, latest: latestPath })}\n`);
  return { report, versionedPath, latestPath };
}

export function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}
