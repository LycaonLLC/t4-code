import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeReport } from "./report.mjs";

export function compareReports(baseline, current, thresholdFraction) {
  const currentByName = new Map(current.metrics.map((metric) => [metric.name, metric]));
  return baseline.metrics.flatMap((baselineMetric) => {
    const currentMetric = currentByName.get(baselineMetric.name);
    if (currentMetric === undefined || currentMetric.unit !== baselineMetric.unit) return [];
    const changeFraction = baselineMetric.median === 0
      ? (currentMetric.median === 0 ? 0 : null)
      : (currentMetric.median - baselineMetric.median) / baselineMetric.median;
    return [{
      name: baselineMetric.name,
      unit: baselineMetric.unit,
      baselineMedian: baselineMetric.median,
      currentMedian: currentMetric.median,
      changeFraction,
      thresholdFraction,
      regression: changeFraction === null || changeFraction > thresholdFraction,
    }];
  });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const rawArguments = process.argv.slice(2);
  const arguments_ = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
  const [baselinePath, currentPath] = arguments_;
  if (baselinePath === undefined || currentPath === undefined) {
    throw new Error("usage: pnpm perf:compare -- <baseline.json> <current.json>");
  }
  const thresholdPercent = Number(process.env.T4_PERF_REGRESSION_PERCENT ?? "10");
  if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0) {
    throw new Error("T4_PERF_REGRESSION_PERCENT must be a non-negative number");
  }
  const baseline = JSON.parse(readFileSync(resolve(baselinePath), "utf8"));
  const current = JSON.parse(readFileSync(resolve(currentPath), "utf8"));
  if (baseline.kind !== current.kind) throw new Error("benchmark report kinds do not match");
  if (JSON.stringify(baseline.scenario) !== JSON.stringify(current.scenario)) {
    throw new Error("benchmark scenarios do not match");
  }
  const comparisons = compareReports(baseline, current, thresholdPercent / 100);
  if (comparisons.length === 0) throw new Error("benchmark reports have no comparable metrics");
  const result = writeReport("comparison", [], {
    baseline: resolve(baselinePath),
    current: resolve(currentPath),
    comparisons,
  });
  for (const comparison of comparisons) {
    const change = comparison.changeFraction === null
      ? `from 0 to ${comparison.currentMedian} ${comparison.unit}`
      : `${(comparison.changeFraction * 100).toFixed(1)}%`;
    process.stdout.write(
      `${comparison.regression ? "REGRESSION" : "ok"} ${comparison.name}: ${change}\n`,
    );
  }
  if (comparisons.some((comparison) => comparison.regression)) process.exitCode = 1;
  else process.stdout.write(`comparison report: ${result.versionedPath}\n`);
}
