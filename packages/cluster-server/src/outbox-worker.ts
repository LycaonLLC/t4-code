import type { OutboxClaim, OwnerLease, PostgresLedger, StaleCreateCleanup, StaleCreateCleanupClaim } from "./ledger.ts";

export type { OutboxClaim, StaleCreateCleanup } from "./ledger.ts";
export interface OutboxMutation {
	readonly idempotencyToken: string;
	readonly commandId: string;
	readonly principalId: string;
	readonly kind: OutboxClaim["kind"];
	readonly targetId: string;
	readonly targetRevision: bigint;
	readonly payload: Readonly<Record<string, unknown>>;
}
export interface OutboxApplyContext {
	readonly claimIsCurrent?: () => Promise<boolean>;
	readonly signal?: AbortSignal;
	readonly persistStaleCreateCleanup?: (cleanup: StaleCreateCleanup) => Promise<void>;
}
export interface StaleCreateCleanupReplayContext {
	readonly claimIsCurrent: () => Promise<boolean>;
	readonly signal?: AbortSignal;
}
export interface KubernetesOutboxApplier {
	apply(mutation: OutboxMutation, fence: OwnerLease, context?: OutboxApplyContext): Promise<void>;
	replayStaleCreateCleanup?(cleanup: StaleCreateCleanup, context: StaleCreateCleanupReplayContext): Promise<void>;
}
export interface DurableOutboxWorkerOptions {
	readonly ledger: PostgresLedger;
	readonly ownerId: string;
	readonly applier: KubernetesOutboxApplier;
}

export class DurableOutboxWorker {
	readonly #ledger: PostgresLedger;
	readonly #ownerId: string;
	readonly #applier: KubernetesOutboxApplier;
	#lease: OwnerLease | undefined;

	constructor(options: DurableOutboxWorkerOptions) {
		if (!options.ownerId.trim() || Buffer.byteLength(options.ownerId, "utf8") > 256) throw new Error("outbox owner id is invalid");
		this.#ledger = options.ledger;
		this.#ownerId = options.ownerId;
		this.#applier = options.applier;
	}

	async tryAcquireLease(): Promise<OwnerLease | undefined> {
		this.#lease = await this.#ledger.tryAcquireLease(this.#ownerId);
		return this.#lease;
	}

	async acquireLease(): Promise<OwnerLease> {
		this.#lease = await this.#ledger.acquireLease(this.#ownerId);
		return this.#lease;
	}

	async claimNext(): Promise<OutboxClaim | undefined> {
		if (!this.#lease) throw new Error("outbox lease has not been acquired");
		return await this.#ledger.claimNext(this.#lease);
	}

	async applyClaim(claim: OutboxClaim): Promise<"applied" | "fenced" | "retry"> {
		if (!await this.#ledger.claimIsCurrent(claim)) return "fenced";
		const mutation: OutboxMutation = {
			idempotencyToken: `outbox:${claim.outboxId}`,
			commandId: claim.commandId,
			principalId: claim.principalId,
			kind: claim.kind,
			targetId: claim.targetId,
			targetRevision: claim.targetRevision,
			payload: claim.mutation,
		};
		const timeout = Math.max(0, claim.expiresAt - Date.now());
		const signal = timeout === 0 ? AbortSignal.abort(new Error("outbox lease has expired")) : AbortSignal.timeout(timeout);
		try {
			await this.#applier.apply(mutation, { ownerId: claim.ownerId, epoch: claim.ownerEpoch }, {
				claimIsCurrent: () => this.#ledger.claimIsCurrent(claim),
				signal,
				persistStaleCreateCleanup: async cleanup => {
					if (!await this.#ledger.persistStaleCreateCleanup(claim, cleanup)) throw new Error("stale create cleanup does not match its durable outbox claim");
				},
			});
		} catch (error) {
			if (!await this.#ledger.claimIsCurrent(claim)) return "fenced";
			await this.#ledger.recordFailure(claim, error instanceof Error ? error.message : "outbox application failed");
			return "retry";
		}
		return await this.#ledger.acknowledge(claim) ? "applied" : "fenced";
	}

	async #applyStaleCreateCleanup(claim: StaleCreateCleanupClaim): Promise<"applied" | "fenced" | "retry"> {
		if (!this.#applier.replayStaleCreateCleanup || !await this.#ledger.staleCreateCleanupClaimIsCurrent(claim)) return "fenced";
		const timeout = Math.max(0, claim.expiresAt - Date.now());
		const signal = timeout === 0 ? AbortSignal.abort(new Error("outbox lease has expired")) : AbortSignal.timeout(timeout);
		try {
			await this.#applier.replayStaleCreateCleanup(claim, {
				claimIsCurrent: () => this.#ledger.staleCreateCleanupClaimIsCurrent(claim),
				signal,
			});
		} catch (error) {
			if (!await this.#ledger.staleCreateCleanupClaimIsCurrent(claim)) return "fenced";
			await this.#ledger.recordStaleCreateCleanupFailure(claim, error instanceof Error ? error.message : "stale create cleanup failed");
			return "retry";
		}
		return await this.#ledger.acknowledgeStaleCreateCleanup(claim) ? "applied" : "fenced";
	}

	async drain(maximum = 100): Promise<number> {
		if (!this.#lease) await this.acquireLease();
		if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10_000) throw new Error("outbox drain bound is invalid");
		let applied = 0;
		let emptyPasses = 0;
		for (let index = 0; index < maximum && emptyPasses < 2; index++) {
			if (this.#applier.replayStaleCreateCleanup) {
				const cleanup = await this.#ledger.claimStaleCreateCleanup(this.#lease!);
				if (cleanup) {
					emptyPasses = 0;
					const result = await this.#applyStaleCreateCleanup(cleanup);
					if (result === "fenced") break;
					continue;
				}
			}
			const claim = await this.claimNext();
			if (!claim) {
				emptyPasses++;
				continue;
			}
			emptyPasses = 0;
			const result = await this.applyClaim(claim);
			if (result === "applied") applied++;
			if (result === "fenced") break;
		}
		return applied;
	}
}
