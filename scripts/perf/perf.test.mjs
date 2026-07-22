import assert from "node:assert/strict";
import test from "node:test";
import { compareReports } from "./compare.mjs";
import { machineMetadata, percentile, summarize } from "./report.mjs";

test("summarize reports stable median and nearest-rank p95", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.deepEqual(summarize([5, 1, 3]), {
    unit: "ms",
    samples: [1, 3, 5],
    min: 1,
    median: 3,
    p95: 5,
    max: 5,
    mean: 3,
  });
});

test("machine metadata uses a non-identifying default label", () => {
  assert.equal(machineMetadata().machineLabel, "unlabeled");
});

test("compareReports flags only matching metrics beyond the threshold", () => {
  const baseline = { metrics: [{ name: "launch", unit: "ms", median: 100 }] };
  const current = { metrics: [{ name: "launch", unit: "ms", median: 111 }] };
  assert.equal(compareReports(baseline, current, 0.1)[0]?.regression, true);
  assert.equal(compareReports(baseline, current, 0.2)[0]?.regression, false);
});

test("compareReports handles zero baselines without non-finite values", () => {
  const baseline = { metrics: [{ name: "launch", unit: "ms", median: 0 }] };
  const unchanged = { metrics: [{ name: "launch", unit: "ms", median: 0 }] };
  const increased = { metrics: [{ name: "launch", unit: "ms", median: 1 }] };
  assert.deepEqual(compareReports(baseline, unchanged, 0.1)[0], {
    name: "launch",
    unit: "ms",
    baselineMedian: 0,
    currentMedian: 0,
    changeFraction: 0,
    thresholdFraction: 0.1,
    regression: false,
  });
  assert.equal(compareReports(baseline, increased, 0.1)[0]?.changeFraction, null);
  assert.equal(compareReports(baseline, increased, 0.1)[0]?.regression, true);
});
