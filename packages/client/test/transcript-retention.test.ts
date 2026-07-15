import { describe, expect, it } from "vite-plus/test";
import { hostId, sessionId, type DurableEntry } from "@t4-code/protocol";

import {
  MAX_RETAINED_SESSION_EVENT_BYTES,
  MAX_RETAINED_SESSION_EVENTS,
  MAX_RETAINED_SESSION_EVENTS_BYTES,
  MAX_RETAINED_TRANSCRIPT_BYTES,
  MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
  appendRetainedValue,
  retainDurableEntries,
  retainedJsonBytes,
  sanitizeRetainedDurableEntry,
  sanitizeRetainedRecord,
} from "../src/transcript-retention.ts";

const HOST = hostId("host-retention");
const SESSION = sessionId("session-retention");
const imageReference = Object.freeze({
  sha256: "a".repeat(64),
  mimeType: "image/png",
});

function toolResultEntry(index: number): DurableEntry {
  return {
    id: `entry-${index}` as never,
    parentId: null,
    hostId: HOST,
    sessionId: SESSION,
    kind: "tool.result",
    timestamp: `2026-07-15T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    data: {
      type: "tool.result",
      images: [imageReference],
      result: {
        output: `tool-${index}-head\n${"x".repeat(300_000)}\ntool-${index}-tail`,
      },
    },
  };
}

describe("retained transcript budgets", () => {
  it("keeps the newest contiguous suffix under count, entry, and cumulative byte caps", () => {
    const retained = retainDurableEntries(
      Array.from({ length: 200 }, (_, index) => toolResultEntry(index)),
    );

    expect(retained.truncated).toBe(true);
    expect(retained.entries.length).toBeLessThan(200);
    expect(retained.entries.at(-1)?.id).toBe("entry-199");
    expect(retained.bytes).toBe(retainedJsonBytes(retained.entries));
    expect(retained.bytes).toBeLessThanOrEqual(MAX_RETAINED_TRANSCRIPT_BYTES);
    expect(
      retained.entries.every(
        (entry) => retainedJsonBytes(entry) <= MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
      ),
    ).toBe(true);

    const newestData = retained.entries.at(-1)?.data as {
      readonly images?: readonly unknown[];
      readonly result?: { readonly output?: string };
    };
    expect(newestData.images).toEqual([imageReference]);
    expect(newestData.result?.output).toContain("retained value truncated");
    expect(newestData.result?.output).toContain("tool-199-tail");
  });

  it("preserves durable image references without retaining a clipped inline image", () => {
    const retained = sanitizeRetainedDurableEntry({
      ...toolResultEntry(1),
      data: {
        images: [imageReference],
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "A".repeat(300_000),
          },
        ],
      },
    });
    const data = retained.data as {
      readonly images?: readonly unknown[];
      readonly content?: ReadonlyArray<{ readonly data?: string; readonly mimeType?: string }>;
    };

    expect(data.images).toEqual([imageReference]);
    expect(data.content?.[0]?.mimeType).toBe("image/png");
    expect(data.content?.[0]?.data).toBeUndefined();
    expect(retainedJsonBytes(retained)).toBeLessThanOrEqual(MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES);
  });

  it("bounds repeated large live events cumulatively while retaining the newest event", () => {
    let events: readonly Readonly<Record<string, unknown>>[] = [];
    for (let index = 0; index < 100; index += 1) {
      const event = sanitizeRetainedRecord(
        {
          type: "tool.result",
          index,
          result: { output: `event-${index}-head${"y".repeat(300_000)}event-${index}-tail` },
        },
        MAX_RETAINED_SESSION_EVENT_BYTES,
      );
      events = appendRetainedValue(
        events,
        event,
        MAX_RETAINED_SESSION_EVENTS,
        MAX_RETAINED_SESSION_EVENTS_BYTES,
      );
    }

    expect(events.length).toBeLessThan(100);
    expect(events.at(-1)?.index).toBe(99);
    expect(retainedJsonBytes(events)).toBeLessThanOrEqual(MAX_RETAINED_SESSION_EVENTS_BYTES);
    expect(events.every((event) => retainedJsonBytes(event) <= MAX_RETAINED_SESSION_EVENT_BYTES)).toBe(true);
  });
});
