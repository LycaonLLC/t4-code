import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sessionId } from "@t4-code/host-wire";
import { AttentionOutcomeStore } from "../src/attention-outcome-store.ts";

describe("private attention outcome ledger", () => {
	test("atomically restores only bounded outcomes and removes deleted sessions", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attention-ledger-"));
		const ledgerPath = path.join(root, "profile", "agent", "appserver", "attention-outcomes.json");
		const first = new AttentionOutcomeStore(ledgerPath);
		const outcome = {
			id: "agent:completed:2026-07-18T12:00:00.000Z",
			kind: "completed" as const,
			at: "2026-07-18T12:00:00.000Z",
			summary: "Agent completed work.",
		};
		await first.set(sessionId("session-a"), outcome);
		await first.flush();

		const metadata = await fs.stat(ledgerPath);
		expect(metadata.mode & 0o777).toBe(0o600);
		const serialized = await Bun.file(ledgerPath).text();
		expect(serialized).not.toContain("pending");
		expect(JSON.parse(serialized)).toEqual({
			version: 1,
			outcomes: [{ sessionId: "session-a", outcome }],
		});

		const restored = new AttentionOutcomeStore(ledgerPath);
		await restored.load();
		expect(restored.get(sessionId("session-a"))).toEqual(outcome);
		await restored.delete(sessionId("session-a"));
		expect(JSON.parse(await Bun.file(ledgerPath).text())).toEqual({ version: 1, outcomes: [] });
		await fs.rm(root, { recursive: true, force: true });
	});
	test("ignores ledgers without exact owner-only permissions", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attention-ledger-mode-"));
		const ledgerPath = path.join(root, "attention-outcomes.json");
		const outcome = {
			id: "agent:completed:2026-07-18T12:00:00.000Z",
			kind: "completed" as const,
			at: "2026-07-18T12:00:00.000Z",
			summary: "Agent completed work.",
		};
		await fs.writeFile(
			ledgerPath,
			`${JSON.stringify({ version: 1, outcomes: [{ sessionId: "session-a", outcome }] })}\n`,
			{ mode: 0o700 },
		);
		await fs.chmod(ledgerPath, 0o700);

		const store = new AttentionOutcomeStore(ledgerPath);
		await store.load();
		expect(store.get(sessionId("session-a"))).toBeUndefined();
		await fs.rm(root, { recursive: true, force: true });
	});
	test("treats ledger access failures as an empty best-effort cache", async () => {
		const store = new AttentionOutcomeStore("invalid\0attention-outcomes.json");
		await expect(store.load()).resolves.toBeUndefined();
		expect(store.get(sessionId("session-a"))).toBeUndefined();
	});
});
