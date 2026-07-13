// Typed builders for the app-wire server frames the fixture runtime emits.
// These construct the same decoded shapes `decodeServerFrame` produces —
// using the protocol's own branded-id constructors — so the projection
// reducer exercises exactly the types the real bridge will hand it.
import {
  type Cursor,
  type DurableEntry,
  type DurableEntryFrame,
  entryId,
  type GapFrame,
  hostId,
  type LiveEventFrame,
  PROTOCOL_VERSION,
  revision,
  type SessionEvent,
  sessionId,
  type SessionSnapshotFrame,
} from "@t4-code/protocol";

export interface FrameFactoryOptions {
  readonly host: string;
  readonly session: string;
  readonly epoch: string;
  readonly startSeq?: number;
}

/**
 * Sequenced frame factory for one session stream. Sequence numbers allocate
 * monotonically; every frame it produces is contiguous unless a gap is
 * requested explicitly (`skip`).
 */
export class FrameFactory {
  readonly hostId;
  readonly sessionId;
  private readonly epoch: string;
  private seq: number;
  private revisionCounter = 0;
  private entryCounter = 0;

  constructor(options: FrameFactoryOptions) {
    this.hostId = hostId(options.host);
    this.sessionId = sessionId(options.session);
    this.epoch = options.epoch;
    this.seq = options.startSeq ?? 0;
  }

  cursor(): Cursor {
    return { epoch: this.epoch, seq: this.seq };
  }

  private nextCursor(): Cursor {
    this.seq += 1;
    return { epoch: this.epoch, seq: this.seq };
  }

  /** Deliberately skip sequence numbers to simulate a lost frame. */
  skip(count = 1): void {
    this.seq += count;
  }

  nextEntryId(prefix = "entry"): string {
    this.entryCounter += 1;
    return `${prefix}-${this.entryCounter}`;
  }

  entryRecord(input: {
    readonly id: string;
    readonly parentId?: string | null;
    readonly kind: string;
    readonly timestamp: string;
    readonly data: Record<string, unknown>;
  }): DurableEntry {
    return {
      id: entryId(input.id),
      parentId: input.parentId == null ? null : entryId(input.parentId),
      hostId: this.hostId,
      sessionId: this.sessionId,
      kind: input.kind,
      timestamp: input.timestamp,
      data: input.data,
    };
  }

  snapshot(entries: readonly DurableEntry[]): SessionSnapshotFrame {
    this.revisionCounter += 1;
    return {
      v: PROTOCOL_VERSION,
      type: "snapshot",
      cursor: this.cursor(),
      revision: revision(`rev-${this.revisionCounter}`),
      hostId: this.hostId,
      sessionId: this.sessionId,
      entries: [...entries],
    };
  }

  entry(record: DurableEntry): DurableEntryFrame {
    this.revisionCounter += 1;
    return {
      v: PROTOCOL_VERSION,
      type: "entry",
      cursor: this.nextCursor(),
      revision: revision(`rev-${this.revisionCounter}`),
      hostId: this.hostId,
      sessionId: this.sessionId,
      entry: record,
    };
  }

  event(event: SessionEvent): LiveEventFrame {
    return {
      v: PROTOCOL_VERSION,
      type: "event",
      cursor: this.nextCursor(),
      hostId: this.hostId,
      sessionId: this.sessionId,
      event,
    };
  }
  gap(reason: string, missing = 1): GapFrame {
    const from = this.cursor();
    this.seq += missing;
    return {
      v: PROTOCOL_VERSION,
      type: "gap",
      hostId: this.hostId,
      sessionId: this.sessionId,
      from,
      to: this.cursor(),
      reason,
    };
  }
}
