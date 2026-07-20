# OMP bridge boundary

T4 now owns the generic host service. OMP supplies the small part that must understand OMP's private runtime state.

```text
T4 desktop or mobile
        |
        | omp-app/1
        v
t4-host (T4 executable)
        |
        +-- omp bridge --stdio
        |      sessions, locks, settings, operations, catalog
        |
        +-- omp --mode rpc --session <path>
        |      one live worker for each active session
        |
        `-- standard OMP fallback (when the bridge is absent)
               read saved session files; never start or control a worker
```

## Standard OMP compatibility

The standalone host first asks OMP for the T4 control bridge. Official OMP releases do not include
that bridge. When it is unavailable, the host now falls back to OMP's standard session files instead
of leaving the profile disconnected.

This fallback is intentionally limited:

| Available | Not available |
| --- | --- |
| Discover default and named-profile sessions | Send prompts or slash commands |
| Read existing transcripts | Stop, resume, rename, archive, or delete sessions |
| Follow newly saved transcript entries | Reliable running, idle, or ownership status |
| Search and page through saved history | Token-by-token streaming or T4 runtime settings |

T4 labels these rows `OMP · view only` and shows a `Standard OMP session` banner. The host grants
only `sessions.read`, never starts an OMP worker, and rejects writes even if a client bypasses its UI.
This keeps the limitation visible while still making ordinary OMP work readable.

The normal locations are `~/.omp/agent/sessions` for the default profile and
`~/.omp/profiles/<profile>/agent/sessions` for a named profile. A custom layout can be supplied to
`t4-host serve` with `--session-root /absolute/path`.

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

The bridge is a versioned, length-bounded line protocol over standard input and output. It validates every message and fails closed when an operation is unavailable or ownership is unclear. The migrated host retains a read-only, bounded OMP JSONL projector for transcript search and standard-OMP compatibility. It may project the exact tested format, but it must not mutate OMP state, infer locks, or invent ownership. A later bridge method can replace the projector with an OMP-published catalog and event stream.

## Direct replacement rollout

There are no live users to migrate, so this is a replacement rather than a period where two host implementations run side by side.

| Phase                  | What happens                                                                                                                    | Proof before moving on                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Build the bridge       | OMP exposes `omp bridge --stdio`; T4 validates the protocol and owns the network host.                                          | Contract, cancellation, restart, and malformed-message tests pass.            |
| Build the host         | T4 packages the standalone `t4-host` executable and invokes the same OMP binary for the bridge and session workers.             | Compiled T4 and OMP binaries pass a real Unix-socket session smoke test.      |
| Replace the service    | The existing service label is rewritten to launch `t4-host`. A healthy legacy OMP appserver is not accepted as the final owner. | Desktop lifecycle and service-manager tests prove the definition is replaced. |
| Publish together       | Release the small OMP bridge build, pin its tag and hashes in T4, then ship T4 with both executables.                           | Packaging, signing, provenance, full CI, and release inspection pass.         |
| Remove transition code | Delete code that exists only to run or preserve the old OMP-hosted appserver.                                                   | No public `omp appserver serve` or `ompd` launcher remains.                   |

We intentionally skip dual-running hosts, mixed-version client support, live-session transfer, and an in-process runtime rollback system. Rollback remains a Git/release choice: install the previous known-good pair of T4 and OMP artifacts.

The simplified rollout does not weaken the hard boundaries. We retain strict protocol versioning, fail-closed lock behavior, secret redaction, process isolation, restart/reconnect tests, signed host packaging, exact artifact provenance, and protection for existing local development session files.

## Current branch state

The released `appserver-9` integration consumes checksum-pinned T4 host artifacts through thin compatibility exports. The matching bridge branch advances that boundary by moving the running network host into the standalone T4 executable and removing OMP's public legacy launchers. The thin bridge and standalone host pass a compiled-binary end-to-end smoke test.

The checked-in compatibility matrix correctly remains on `appserver-9` until the new bridge build has a real tag and published hashes; release metadata must never point at an unpublished artifact.

This reduces the fork to the OMP-specific authority adapter and protocol glue, but does not remove the fork entirely. T4 still pins the exact Lycaon OMP source and binary because the bridge is not part of ordinary upstream OMP.
