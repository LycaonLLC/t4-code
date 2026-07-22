# ADR-003: Dependency-free app-wire v1

- Status: Accepted
- Decision: Canonical app-wire lives only in OMP and has zero runtime dependencies, executable guards, versioned envelopes, identity, feature negotiation, cursor/epoch, snapshots, events, commands, errors, capabilities, confirmations, and golden frames. Sequence orders volatile same-epoch frames; stable entry ID deduplicates durable transcript entries. Old epochs and gaps require a snapshot, never guessing.
- Consequence: TypeScript and Dart clients both consume the pinned wire corpus and must not invent competing frame shapes.
