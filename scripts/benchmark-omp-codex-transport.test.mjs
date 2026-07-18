import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregate,
  analyzeEvents,
  benchmarkPrompt,
  boundedError,
  parseArgs,
  parseEvents,
} from "./benchmark-omp-codex-transport.mjs";

test("parses benchmark options without running the CLI", () => {
  assert.deepEqual(parseArgs([]), {
    model: "openai-codex/gpt-5.4-mini",
    thinking: "low",
    runs: 3,
    toolCalls: 10,
    maxTimeSeconds: 180,
    output: null,
    help: false,
  });
  assert.deepEqual(
    parseArgs([
      "--model", "openai-codex/test-model",
      "--thinking", "medium",
      "--runs", "2",
      "--tool-calls", "4",
      "--max-time", "30",
      "--help",
    ]),
    {
      model: "openai-codex/test-model",
      thinking: "medium",
      runs: 2,
      toolCalls: 4,
      maxTimeSeconds: 30,
      output: null,
      help: true,
    },
  );
  assert.throws(() => parseArgs(["--runs", "0"]), /runs must be a positive integer/u);
  assert.throws(() => parseArgs(["--unknown", "value"]), /unknown option/u);
  assert.throws(() => parseArgs(["--model"]), /missing value/u);
});

test("builds one ordered marker instruction per requested tool call", () => {
  const prompt = benchmarkPrompt(2);
  assert.match(prompt, /exactly 2 bash tool calls/u);
  assert.match(prompt, /marker-001/u);
  assert.match(prompt, /marker-002/u);
  assert.doesNotMatch(prompt, /marker-003/u);
  assert.match(prompt, /sequentially and never in parallel/u);
});

test("ignores non-JSON output and requires assistant completion", () => {
  assert.deepEqual(
    parseEvents('progress\n{"type":"tool_execution_start"}\n'),
    [{ type: "tool_execution_start" }],
  );

  const baseEvents = [
    { type: "message_end", message: { role: "user", content: "Reply BENCHMARK_COMPLETE" } },
    { type: "tool_execution_start" },
    { type: "tool_execution_end" },
  ];
  const incomplete = analyzeEvents([
    ...baseEvents,
    {
      type: "message_end",
      message: { role: "assistant", content: "not BENCHMARK_COMPLETE" },
    },
  ], 1);
  assert.equal(incomplete.completed, false);
  assert.equal(incomplete.valid, false);

  const complete = analyzeEvents([
    ...baseEvents,
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "BENCHMARK_COMPLETE" }],
        duration: 25,
        ttft: 5,
        usage: { input: 100, cacheRead: 40, output: 3 },
      },
    },
  ], 1);
  assert.equal(complete.valid, true);
  assert.equal(complete.providerDurationMs, 25);
  assert.equal(complete.initialTtftMs, 5);
  assert.equal(complete.inputTokens, 100);
  assert.equal(complete.cacheReadTokens, 40);
  assert.equal(complete.outputTokens, 3);
});

test("aggregates only valid runs and keeps transport diagnostics separate", () => {
  const runs = [
    {
      transport: "websocket",
      valid: true,
      wallClockMs: 100,
      providerDurationMs: 80,
      initialTtftMs: 10,
      continuationTtftMs: [4],
      continuationDurationMs: [20],
      inputTokens: 30,
      cacheReadTokens: 5,
      transportDiagnostics: {
        available: true,
        actualTransports: ["websocket"],
        fallbackCount: 0,
        fullContextRequests: 1,
        deltaRequests: 2,
        inputJsonBytes: 400,
      },
    },
    { transport: "websocket", valid: false },
    { transport: "sse", valid: true },
  ];
  const summary = aggregate(runs, "websocket");
  assert.equal(summary.successfulRuns, 1);
  assert.equal(summary.failedRuns, 1);
  assert.equal(summary.wallClockMs.mean, 100);
  assert.deepEqual(summary.transportDiagnostics.actualTransports, ["websocket"]);
  assert.equal(summary.transportDiagnostics.deltaRequests.mean, 2);
});

test("never copies process output into the report error", () => {
  const error = boundedError(
    "Authorization: Bearer secret-token",
    "api_key=another-secret",
  );
  assert.equal(error, "OMP benchmark process failed; inspect local OMP logs for details");
  assert.doesNotMatch(error, /secret/iu);
});
