import { test } from "vite-plus/test";

import { applyPublicFrame, createProjectionSnapshot } from "../../packages/client/src/projection.ts";
import { deriveTranscriptRows } from "../../apps/web/src/features/transcript/rows.ts";
import { positiveInteger, sample, summarize, writeReport } from "./report.mjs";

const ENTRY_COUNT = positiveInteger(process.env.T4_PERF_ENTRY_COUNT, 10_000, "entry count");
const EVENT_COUNT = positiveInteger(process.env.T4_PERF_EVENT_COUNT, 100_000, "event count");
const REPETITIONS = positiveInteger(process.env.T4_PERF_REPETITIONS, 5, "repetitions");
const HOST_ID = "host-perf";
const SESSION_ID = "session-perf";
const VERSION = "omp-app/1";

function entries() {
  return Array.from({ length: ENTRY_COUNT }, (_, index) => ({
    id: `entry-${index}`,
    parentId: null,
    hostId: HOST_ID,
    sessionId: SESSION_ID,
    kind: index % 8 === 6 ? "tool-use" : "message",
    timestamp: new Date(index * 1000).toISOString(),
    data:
      index % 8 === 6
        ? {
            tool: "read",
            title: `read module-${index % 97}.ts`,
            args: { path: `src/module-${index % 97}.ts` },
            ok: true,
          }
        : {
            role: index % 2 === 0 ? "user" : "assistant",
            text: `message-${index}\n\nsequence: ${index}`,
          },
  }));
}

const durableEntries = entries();

function snapshotFrame() {
  return {
    v: VERSION,
    type: "snapshot",
    cursor: { epoch: "perf-epoch", seq: 1 },
    revision: "perf-r1",
    hostId: HOST_ID,
    sessionId: SESSION_ID,
    entries: durableEntries,
  };
}

function transcriptProjection() {
  return {
    cursor: { epoch: "perf-epoch", seq: 1 },
    revision: "perf-r1",
    entries: durableEntries,
    historyTruncated: false,
    liveMessages: new Map(),
    toolCalls: new Map(),
    turnActive: false,
    contextMaintenance: null,
    turnGeneration: 0,
    turnStartedAt: null,
    approval: null,
    ask: null,
    plan: null,
    notices: [],
    phase: "live",
  };
}

test(
  "records deterministic core performance scenarios",
  async () => {
    const snapshotMetric = await sample(
      "projection.snapshot",
      () => {
        const state = applyPublicFrame(createProjectionSnapshot(), snapshotFrame() as never);
        if (state.sessions.values().next().value?.entries.length !== ENTRY_COUNT) {
          throw new Error("projection snapshot did not retain the expected entries");
        }
      },
      { repetitions: REPETITIONS },
    );

    const rowProjection = transcriptProjection();
    const rowsMetric = await sample(
      "transcript.derive-rows",
      () => {
        const rows = deriveTranscriptRows(rowProjection as never);
        if (rows.length < ENTRY_COUNT - Math.ceil(ENTRY_COUNT / 8)) {
          throw new Error("row derivation returned fewer rows than expected");
        }
      },
      { repetitions: REPETITIONS },
    );

    const eventSamples = [];
    for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
      globalThis.gc?.();
      let state = applyPublicFrame(createProjectionSnapshot(), snapshotFrame() as never);
      const heapBefore = process.memoryUsage().heapUsed;
      const startedAt = performance.now();
      for (let index = 0; index < EVENT_COUNT; index += 1) {
        state = applyPublicFrame(
          state,
          {
            v: VERSION,
            type: "event",
            cursor: { epoch: "perf-epoch", seq: index + 2 },
            hostId: HOST_ID,
            sessionId: SESSION_ID,
            event: { type: "delta", index },
          } as never,
        );
      }
      eventSamples.push({
        elapsedMs: performance.now() - startedAt,
        heapGrowthBytes: Math.max(0, process.memoryUsage().heapUsed - heapBefore),
      });
      const session = state.sessions.values().next().value;
      const expectedRetainedEvents = Math.min(EVENT_COUNT, 512);
      if (session?.events.length !== expectedRetainedEvents || session.entries.length !== ENTRY_COUNT) {
        throw new Error("event throughput benchmark violated bounded retention");
      }
    }

    const eventMetric = {
      name: "projection.events",
      direction: "lower",
      ...summarize(eventSamples.map((value) => value.elapsedMs)),
    };
    const heapMetric = {
      name: "projection.events-heap-growth",
      direction: "lower",
      ...summarize(
        eventSamples.map((value) => value.heapGrowthBytes),
        "bytes",
      ),
    };

    writeReport("core", [snapshotMetric, rowsMetric, eventMetric, heapMetric], {
      scenario: { entryCount: ENTRY_COUNT, eventCount: EVENT_COUNT, repetitions: REPETITIONS },
    });
  },
  120_000,
);
