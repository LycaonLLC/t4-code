// Persistence adapter boundary for the workspace store. The web build talks
// to localStorage; the native shell substitutes its own adapter through the
// shell bridge without the store noticing. Renderer state only — runtime
// truth never lives here.

export interface WorkspacePersistence {
  /** Raw persisted snapshot, or null when nothing usable is stored. */
  load(): unknown;
  /** Persist a snapshot. Failures are swallowed; view state is best-effort. */
  save(snapshot: unknown): void;
}

/** In-memory adapter for tests and ephemeral fixture boots. */
export function createMemoryPersistence(initial?: unknown): WorkspacePersistence {
  let stored: unknown = initial ?? null;
  return {
    load: () => stored,
    save: (snapshot) => {
      stored = snapshot;
    },
  };
}

/** localStorage adapter used by the web/fixture build. */
export function createLocalStoragePersistence(key: string): WorkspacePersistence {
  return {
    load: () => {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? null : (JSON.parse(raw) as unknown);
      } catch {
        return null;
      }
    },
    save: (snapshot) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(snapshot));
      } catch {
        // Quota or privacy-mode failure; losing view state must not break the shell.
      }
    },
  };
}
