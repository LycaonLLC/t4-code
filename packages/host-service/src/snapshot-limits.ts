import { createHash } from "node:crypto";
import { type DurableEntry, type EntryId, entryId, type HostId, type SessionId } from "@t4-code/host-wire";

const MAX_SNAPSHOT_ENTRIES = 1000;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_SNAPSHOT_NODES = 16_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function boundUtf8(value: string, maxBytes: number): string {
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return decoder.decode(bytes.slice(0, end));
}

function jsonNodeCount(value: unknown): number {
	if (value === null || typeof value !== "object") return 1;
	if (Array.isArray(value)) return 1 + value.reduce((count, item) => count + jsonNodeCount(item), 0);
	return 1 + Object.values(value).reduce((count, item) => count + jsonNodeCount(item), 0);
}

export function uniqueEntryId(base: string, used: ReadonlySet<string>): EntryId {
	const first = entryId(boundUtf8(base, 256));
	if (!used.has(first)) return first;
	const suffix = createHash("sha256").update(base).digest("hex").slice(0, 16);
	for (let counter = used.size; ; counter++) {
		const candidate = entryId(`snapshot-${suffix}-${counter}`);
		if (!used.has(candidate)) return candidate;
	}
}

function priorOmissionCount(entry: DurableEntry): number {
	const omitted = entry.data.omitted;
	const summary = entry.data.summary;
	if (
		entry.kind !== "compaction" ||
		entry.parentId !== null ||
		entry.data.snapshotOmission !== true ||
		typeof omitted !== "number" ||
		!Number.isSafeInteger(omitted) ||
		omitted < 1 ||
		typeof summary !== "string" ||
		!summary.startsWith("Older transcript entries were omitted from this snapshot (")
	)
		return 0;
	return omitted;
}

function payloadSize(entries: readonly DurableEntry[]): { bytes: number; nodes: number } {
	let bytes = 2;
	let nodes = 1;
	for (let i = 0; i < entries.length; i++) {
		bytes += (i === 0 ? 0 : 1) + encoder.encode(JSON.stringify(entries[i])).byteLength;
		nodes += jsonNodeCount(entries[i]);
	}
	return { bytes, nodes };
}

function omissionNotice(
	retained: readonly DurableEntry[],
	host: HostId,
	session: SessionId,
	timestamp: string,
	omitted: number,
): DurableEntry {
	return {
		id: uniqueEntryId(`snapshot-truncation-${session}`, new Set(retained.map(entry => entry.id))),
		parentId: null,
		hostId: host,
		sessionId: session,
		kind: "compaction",
		timestamp,
		data: {
			summary: `Older transcript entries were omitted from this snapshot (${omitted} entries).`,
			omitted,
			snapshotOmission: true,
		},
	};
}

export function boundSnapshotEntries(
	entries: readonly DurableEntry[],
	host: HostId,
	session: SessionId,
	fallbackTimestamp: string,
): DurableEntry[] {
	let priorOmitted = 0;
	const candidates: DurableEntry[] = [];
	for (const entry of entries) {
		const omitted = priorOmissionCount(entry);
		if (omitted) priorOmitted += omitted;
		else candidates.push(entry);
	}
	const retainedReverse: DurableEntry[] = [];
	let payloadBytes = 2;
	let payloadNodes = 1;
	for (let i = candidates.length - 1; i >= 0 && retainedReverse.length < MAX_SNAPSHOT_ENTRIES; i--) {
		const entry = candidates[i];
		const entryBytes = encoder.encode(JSON.stringify(entry)).byteLength;
		const entryNodes = jsonNodeCount(entry);
		const separatorBytes = retainedReverse.length === 0 ? 0 : 1;
		if (
			payloadBytes + separatorBytes + entryBytes > MAX_SNAPSHOT_BYTES ||
			payloadNodes + entryNodes > MAX_SNAPSHOT_NODES
		) {
			if (retainedReverse.length === 0) continue;
			break;
		}
		retainedReverse.push(entry);
		payloadBytes += separatorBytes + entryBytes;
		payloadNodes += entryNodes;
	}
	const retained = retainedReverse.reverse();
	let omitted = priorOmitted + candidates.length - retained.length;
	if (omitted === 0) return retained;

	while (retained.length >= MAX_SNAPSHOT_ENTRIES) {
		retained.shift();
		omitted++;
	}
	while (true) {
		const timestamp = retained[0]?.timestamp ?? fallbackTimestamp;
		const notice = omissionNotice(retained, host, session, timestamp, omitted);
		const size = payloadSize([notice, ...retained]);
		if (size.bytes <= MAX_SNAPSHOT_BYTES && size.nodes <= MAX_SNAPSHOT_NODES) break;
		retained.shift();
		omitted++;
	}

	const retainedIds = new Set(retained.map(entry => entry.id));
	const rebound = retained.map(entry =>
		entry.parentId && !retainedIds.has(entry.parentId) ? { ...entry, parentId: null } : entry,
	);
	const timestamp = rebound[0]?.timestamp ?? fallbackTimestamp;
	return [omissionNotice(rebound, host, session, timestamp, omitted), ...rebound];
}
