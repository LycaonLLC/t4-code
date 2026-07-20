import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AttentionOutcome, decodeSessionAttentionState, type SessionId, sessionId } from "@t4-code/host-wire";

const LEDGER_VERSION = 1;
const MAX_OUTCOMES = 1_000;
const MAX_LEDGER_BYTES = 3 * 1024 * 1024;

interface OutcomeRecord {
	sessionId: SessionId;
	outcome: AttentionOutcome;
}

interface OutcomeLedger {
	version: typeof LEDGER_VERSION;
	outcomes: OutcomeRecord[];
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	return keys.length === expected.length && [...expected].sort().every((key, index) => keys[index] === key);
}

function decodeRecord(value: unknown): OutcomeRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (!exactKeys(record, ["sessionId", "outcome"])) return undefined;
	try {
		const id = sessionId(record.sessionId, "outcomes[].sessionId");
		const attention = decodeSessionAttentionState(
			{ pending: [], pendingCount: 0, truncated: false, latestOutcome: record.outcome },
			"outcomes[].attention",
		);
		if (!attention.latestOutcome) return undefined;
		return { sessionId: id, outcome: attention.latestOutcome };
	} catch {
		return undefined;
	}
}

function decodeLedger(value: unknown): OutcomeLedger | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const ledger = value as Record<string, unknown>;
	if (!exactKeys(ledger, ["version", "outcomes"]) || ledger.version !== LEDGER_VERSION) return undefined;
	if (!Array.isArray(ledger.outcomes) || ledger.outcomes.length > MAX_OUTCOMES) return undefined;
	const outcomes: OutcomeRecord[] = [];
	const seen = new Set<SessionId>();
	for (const value of ledger.outcomes) {
		const record = decodeRecord(value);
		if (!record || seen.has(record.sessionId)) return undefined;
		seen.add(record.sessionId);
		outcomes.push(record);
	}
	return { version: LEDGER_VERSION, outcomes };
}

export class AttentionOutcomeStore {
	readonly path: string;
	#outcomes = new Map<SessionId, AttentionOutcome>();
	#tail = Promise.resolve();
	constructor(filePath: string) {
		this.path = filePath;
	}
	async load(): Promise<void> {
		this.#outcomes.clear();
		let metadata: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			metadata = await fs.lstat(this.path);
		} catch {
			return;
		}
		if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.size > MAX_LEDGER_BYTES) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(await Bun.file(this.path).text()) as unknown;
		} catch {
			return;
		}
		const ledger = decodeLedger(parsed);
		if (!ledger) return;
		this.#outcomes = new Map(ledger.outcomes.map(record => [record.sessionId, record.outcome]));
	}
	get(id: SessionId): AttentionOutcome | undefined {
		return this.#outcomes.get(id);
	}
	set(id: SessionId, outcome: AttentionOutcome): Promise<void> {
		this.#outcomes.delete(id);
		this.#outcomes.set(id, outcome);
		this.#trim();
		return this.#persist();
	}
	delete(id: SessionId): Promise<void> {
		if (!this.#outcomes.delete(id)) return this.#tail;
		return this.#persist();
	}
	async flush(): Promise<void> {
		await this.#tail;
	}
	#trim(): void {
		if (this.#outcomes.size <= MAX_OUTCOMES) return;
		const oldest = [...this.#outcomes]
			.sort(([leftId, left], [rightId, right]) => left.at.localeCompare(right.at) || leftId.localeCompare(rightId))
			.slice(0, this.#outcomes.size - MAX_OUTCOMES);
		for (const [id] of oldest) this.#outcomes.delete(id);
	}
	#persist(): Promise<void> {
		const ledger: OutcomeLedger = {
			version: LEDGER_VERSION,
			outcomes: [...this.#outcomes]
				.map(([id, outcome]) => ({ sessionId: id, outcome }))
				.sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
		};
		this.#tail = this.#tail.catch(() => undefined).then(() => this.#write(ledger));
		return this.#tail;
	}
	async #write(ledger: OutcomeLedger): Promise<void> {
		const directory = path.dirname(this.path);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		await fs.chmod(directory, 0o700);
		const temp = `${this.path}.${randomUUID()}.tmp`;
		try {
			const handle = await fs.open(temp, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(ledger)}\n`);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(temp, this.path);
			await fs.chmod(this.path, 0o600);
		} catch (error) {
			await fs.unlink(temp).catch(() => undefined);
			throw error;
		}
	}
}
