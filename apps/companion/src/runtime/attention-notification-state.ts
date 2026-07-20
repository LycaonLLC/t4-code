export interface AttentionNotificationCandidate {
  readonly key: string;
}

/** Tracks one host's pending-attention keys without replaying its initial inbox. */
export class AttentionNotificationState {
  readonly #seen = new Set<string>();
  #seeded = false;

  update<T extends AttentionNotificationCandidate>(items: readonly T[]): readonly T[] {
    const current = new Set(items.map((item) => item.key));
    const added = this.#seeded ? items.filter((item) => !this.#seen.has(item.key)) : [];

    this.#seen.clear();
    for (const key of current) this.#seen.add(key);
    this.#seeded = true;
    return added;
  }

  reset(): void {
    this.#seen.clear();
    this.#seeded = false;
  }
}
