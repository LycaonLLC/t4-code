#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaults = Object.freeze({
  model: "openai-codex/gpt-5.4-mini",
  thinking: "low",
  runs: 3,
  toolCalls: 10,
  maxTimeSeconds: 180,
  output: null,
});

function positiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function helpText() {
  return `Usage: node scripts/benchmark-omp-codex-transport.mjs [options]

Runs the same tool-heavy OMP workload with ChatGPT OAuth while forcing the
OpenAI Codex transport to WebSocket and SSE in alternating order.

Options:
  --model <selector>       OMP model selector (default: ${defaults.model})
  --thinking <level>       OMP thinking level (default: ${defaults.thinking})
  --runs <count>           Paired runs per transport (default: ${defaults.runs})
  --tool-calls <count>     Sequential bash calls per run (default: ${defaults.toolCalls})
  --max-time <seconds>     OMP timeout for each run (default: ${defaults.maxTimeSeconds})
  --output <path>          Write the redacted JSON result to this path
  --help                   Show this help

The harness never reads or prints OAuth credentials. It records only timings,
token counts, tool counts, transport policy, and bounded error messages.`;
}

export function parseArgs(argv) {
  const options = { ...defaults, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${argument}`);
    if (argument === "--model") options.model = value;
    else if (argument === "--thinking") options.thinking = value;
    else if (argument === "--runs") options.runs = positiveInteger("runs", value);
    else if (argument === "--tool-calls") options.toolCalls = positiveInteger("tool-calls", value);
    else if (argument === "--max-time") options.maxTimeSeconds = positiveInteger("max-time", value);
    else if (argument === "--output") options.output = resolve(value);
    else throw new Error(`unknown option: ${argument}`);
    index += 1;
  }
  return options;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)];
}

function average(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(values) {
  return {
    count: values.length,
    mean: average(values),
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    min: values.length === 0 ? null : Math.min(...values),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

export function benchmarkPrompt(toolCalls) {
  const calls = Array.from({ length: toolCalls }, (_, index) => {
    const marker = String(index + 1).padStart(3, "0");
    return `${index + 1}. Run printf 'marker-${marker}\\n' in one bash tool call.`;
  }).join("\n");
  return `This is a deterministic transport benchmark. Make exactly ${toolCalls} bash tool calls, sequentially and never in parallel. Wait for each result before making the next call. Do not inspect files and do not run any other command.\n\n${calls}\n\nAfter every result has arrived, reply only BENCHMARK_COMPLETE.`;
}

export function boundedError() {
  return "OMP benchmark process failed; inspect local OMP logs for details";
}

async function readTransportDiagnostics(processId, processStartedAtMs) {
  const logDirectory = join(homedir(), ".omp", "logs");
  let names;
  try {
    names = (await readdir(logDirectory)).filter((name) => /^omp\..+\.log$/u.test(name));
  } catch {
    return { available: false, reason: "OMP log directory unavailable" };
  }

  const turns = [];
  let fallbackCount = 0;
  for (const name of names) {
    let text;
    try {
      text = await readFile(join(logDirectory, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.pid !== processId) continue;
      const entryTimeMs = Date.parse(entry.timestamp);
      if (Number.isFinite(entryTimeMs) && entryTimeMs < processStartedAtMs - 2_000) continue;
      if (entry.message === "[codex] codex websocket fallback") fallbackCount += 1;
      if (entry.message !== "[codex] codex turn request diagnostics") continue;
      const diagnostic = entry.diagnostics;
      if (!diagnostic || typeof diagnostic !== "object") continue;
      turns.push({
        transport: diagnostic.transport,
        previousResponseIdPresent: diagnostic.previousResponseIdPresent === true,
        inputItemCount: Number.isFinite(diagnostic.inputItemCount) ? diagnostic.inputItemCount : null,
        inputJsonBytes: Number.isFinite(diagnostic.inputJsonBytes) ? diagnostic.inputJsonBytes : null,
        canAppendBeforeRequest: diagnostic.canAppendBeforeRequest === true,
      });
    }
  }
  return {
    available: turns.length > 0,
    actualTransports: [...new Set(turns.map((turn) => turn.transport).filter(Boolean))],
    fallbackCount,
    fullContextRequests: turns.filter((turn) => !turn.previousResponseIdPresent).length,
    deltaRequests: turns.filter((turn) => turn.previousResponseIdPresent).length,
    inputJsonBytes: turns.reduce((sum, turn) => sum + (turn.inputJsonBytes ?? 0), 0),
    turns,
  };
}

export function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // OMP JSON mode should emit JSONL. A non-JSON progress line is ignored
      // and cannot affect the measured event/timing fields below.
    }
  }
  return events;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

export function analyzeEvents(events, expectedToolCalls) {
  const assistantTurns = events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message);
  const toolCalls = events.filter((event) => event.type === "tool_execution_start").length;
  const toolResults = events.filter((event) => event.type === "tool_execution_end").length;
  const completed = assistantTurns.some((message) =>
    messageText(message.content).trim() === "BENCHMARK_COMPLETE");
  const continuationTurns = assistantTurns.slice(1);
  const providerDurations = assistantTurns.map((message) => message.duration);
  const usage = assistantTurns.map((message) => message.usage ?? {});

  return {
    valid: toolCalls === expectedToolCalls && toolResults === expectedToolCalls && completed,
    toolCalls,
    toolResults,
    assistantTurns: assistantTurns.length,
    completed,
    providerDurationMs:
      providerDurations.length > 0 && providerDurations.every(Number.isFinite)
        ? providerDurations.reduce((sum, duration) => sum + duration, 0)
        : null,
    initialTtftMs: Number.isFinite(assistantTurns[0]?.ttft) ? assistantTurns[0].ttft : null,
    continuationTtftMs: continuationTurns
      .map((message) => message.ttft)
      .filter(Number.isFinite),
    continuationDurationMs: continuationTurns
      .map((message) => message.duration)
      .filter(Number.isFinite),
    inputTokens: usage.reduce((sum, item) => sum + (item.input ?? 0), 0),
    cacheReadTokens: usage.reduce((sum, item) => sum + (item.cacheRead ?? 0), 0),
    outputTokens: usage.reduce((sum, item) => sum + (item.output ?? 0), 0),
  };
}

async function runOmp(options, transport, pairIndex, orderIndex) {
  const workingDirectory = await mkdtemp(join(tmpdir(), `t4-omp-${transport}-`));
  const processStartedAtMs = Date.now();
  const startedAt = performance.now();
  const args = [
    "-p",
    "--mode=json",
    "--no-session",
    "--auto-approve",
    "--tools=bash",
    "--model",
    options.model,
    `--thinking=${options.thinking}`,
    `--max-time=${options.maxTimeSeconds}`,
    "--cwd",
    workingDirectory,
    benchmarkPrompt(options.toolCalls),
  ];

  try {
    const result = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("omp", args, {
        env: {
          ...process.env,
          NO_COLOR: "1",
          PI_CODEX_DEBUG: "1",
          PI_CODEX_WEBSOCKET: transport === "websocket" ? "1" : "0",
        },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      const processId = child.pid;
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", rejectPromise);
      child.on("close", (code, signal) => resolvePromise({ code, signal, stdout, processId }));
    });
    const wallClockMs = performance.now() - startedAt;
    const transportDiagnostics = await readTransportDiagnostics(result.processId, processStartedAtMs);
    if (result.code !== 0) {
      return {
        pairIndex,
        orderIndex,
        transport,
        transportPolicy: transport === "websocket" ? "PI_CODEX_WEBSOCKET=1" : "PI_CODEX_WEBSOCKET=0",
        valid: false,
        wallClockMs,
        exitCode: result.code,
        signal: result.signal,
        transportDiagnostics,
        error: boundedError(),
      };
    }
    return {
      pairIndex,
      orderIndex,
      transport,
      transportPolicy: transport === "websocket" ? "PI_CODEX_WEBSOCKET=1" : "PI_CODEX_WEBSOCKET=0",
      wallClockMs,
      exitCode: result.code,
      transportDiagnostics,
      ...analyzeEvents(parseEvents(result.stdout), options.toolCalls),
    };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

export function aggregate(runs, transport) {
  const selected = runs.filter((run) => run.transport === transport && run.valid);
  const diagnosticRuns = selected.filter((run) => run.transportDiagnostics?.available);
  return {
    successfulRuns: selected.length,
    failedRuns: runs.filter((run) => run.transport === transport && !run.valid).length,
    wallClockMs: summarize(selected.map((run) => run.wallClockMs)),
    providerDurationMs: summarize(selected.map((run) => run.providerDurationMs).filter(Number.isFinite)),
    initialTtftMs: summarize(selected.map((run) => run.initialTtftMs).filter(Number.isFinite)),
    continuationTtftMs: summarize(selected.flatMap((run) => run.continuationTtftMs)),
    continuationDurationMs: summarize(selected.flatMap((run) => run.continuationDurationMs)),
    inputTokens: summarize(selected.map((run) => run.inputTokens)),
    cacheReadTokens: summarize(selected.map((run) => run.cacheReadTokens)),
    transportDiagnostics: {
      runs: diagnosticRuns.length,
      actualTransports: [...new Set(diagnosticRuns.flatMap((run) => run.transportDiagnostics.actualTransports))],
      fallbackCount: diagnosticRuns.reduce((sum, run) => sum + run.transportDiagnostics.fallbackCount, 0),
      fullContextRequests: summarize(diagnosticRuns.map((run) => run.transportDiagnostics.fullContextRequests)),
      deltaRequests: summarize(diagnosticRuns.map((run) => run.transportDiagnostics.deltaRequests)),
      inputJsonBytes: summarize(diagnosticRuns.map((run) => run.transportDiagnostics.inputJsonBytes)),
    },
  };
}

async function readOmpVersion() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("omp", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else rejectPromise(new Error(`omp --version exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }

  const versionResult = await readOmpVersion();
  const runs = [];
  for (let pairIndex = 0; pairIndex < options.runs; pairIndex += 1) {
    const order = pairIndex % 2 === 0 ? ["websocket", "sse"] : ["sse", "websocket"];
    for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
      const transport = order[orderIndex];
      console.error(`pair ${pairIndex + 1}/${options.runs}: ${transport}`);
      const run = await runOmp(options, transport, pairIndex, orderIndex);
      runs.push(run);
      console.error(`  ${run.valid ? "ok" : "invalid"} ${Math.round(run.wallClockMs)} ms, ${run.toolCalls ?? 0} tools`);
    }
  }

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    harness: "OMP ChatGPT OAuth transport benchmark",
    proofBoundary: "Measures the installed OMP openai-codex implementation, not the public OpenAI API endpoint.",
    ompVersion: versionResult,
    model: options.model,
    thinking: options.thinking,
    pairedRuns: options.runs,
    expectedToolCallsPerRun: options.toolCalls,
    ordering: "alternating websocket-first and sse-first pairs",
    transports: {
      websocket: "forced with PI_CODEX_WEBSOCKET=1; OMP may still fall back internally after transport failures",
      sse: "forced with PI_CODEX_WEBSOCKET=0",
    },
    runs,
    summary: {
      websocket: aggregate(runs, "websocket"),
      sse: aggregate(runs, "sse"),
    },
  };

  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, serialized, { encoding: "utf8", mode: 0o600 });
    console.error(`wrote ${options.output}`);
  }
  process.stdout.write(serialized);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
