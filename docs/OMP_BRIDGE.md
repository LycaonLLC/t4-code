# OMP bridge boundary

T4 now owns the generic host service. OMP supplies the small part that must understand OMP's private runtime state.

```text
T4 desktop or mobile
        |
        | omp-app/1
        v
@t4-code/host-service
        |
        | validated OMP JSON RPC bridge
        v
OMP session authority
```

## T4-owned responsibilities

- WebSocket framing, replay, capability negotiation, pairing, and remote policy
- bounded session projections, attention, transcript search, and artifact reads
- backend-neutral ACP runtime adapters
- Git repository and worktree lifecycle
- deterministic host tests and release gates

## OMP-owned responsibilities

- reading and writing OMP sessions
- lock inspection, takeover, and mutation refusal
- starting, steering, and cancelling OMP agent workers
- OMP settings, model registry, usage, and credentials
- turning OMP-native events into the validated bridge stream

The bridge must fail closed when an operation is unavailable or ownership is unclear. The migrated host temporarily retains a read-only, bounded OMP JSONL compatibility projector. It may project the exact tested format, but it must not mutate OMP state, infer locks, or invent ownership. The target thin bridge replaces that projector with an OMP-published catalog and event stream.

## Migration state

The verified OMP integration now consumes checksum-pinned T4 host artifacts through thin compatibility exports. The duplicated generic host and wire implementation has been removed from the fork; OMP retains the launcher and its private authority adapter. T4 keeps the exact runtime tag, source commit, artifact size, and hash in the compatibility matrix. Ordinary upstream OMP is still not compatible because it does not ship that launcher or adapter.
