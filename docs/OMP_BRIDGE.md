# OMP bridge boundary

T4 owns the generic host service and client wire. Unmodified official OMP owns runtime state and agent execution.

```text
T4 desktop or mobile
        |
        | omp-app/1
        v
t4-host (T4 executable)
        |
        +-- omp --mode rpc --session <path>
        |      one live worker for each active session
        |
        `-- ~/.omp/agent/sessions/<session>.jsonl
               durable discovery and transcript projection
```

## T4-owned responsibilities

- WebSocket framing, replay, capability negotiation, pairing, and remote policy
- bounded session projections, attention, transcript search, and artifact reads
- backend-neutral ACP runtime adapters
- Git repository and worktree lifecycle
- deterministic host tests and release gates

## OMP-owned responsibilities

- durable OMP session files and runtime locks
- model selection, thinking levels, fast mode, tools, and agent workers
- prompt, steer, follow-up, approval, cancellation, and session lifecycle RPC
- OMP settings, model registry, usage, and credentials
- native event and transcript persistence

T4 launches the exact tested official OMP executable in RPC mode for active-session commands. T4's bounded JSONL projector reads the official session format for discovery, transcript search, and reconnect recovery. It does not mutate OMP message files, infer lock ownership, or invent runtime state.

## Official runtime cutover

There are no live users to migrate, so the fork-backed runtime is replaced directly.

| Phase | What happens | Proof before moving on |
| --- | --- | --- |
| Pin official OMP | Record the official tag, source commit, artifact sizes, and SHA-256 receipts. | Release consistency rejects provenance drift. |
| Package the host | Bundle the official executable beside the standalone `t4-host`. | Version, checksum, discovery, attach, prompt, model selection, and durable JSONL proofs pass. |
| Replace local services | Rewrite the existing service definition to launch `t4-host` against official OMP. | Desktop lifecycle and service-manager tests prove the definition is replaced. |
| Publish together | Ship T4 with the verified official runtime on desktop and managed hosts. | Packaging, signing, provenance, CI, and release inspection pass. |

Rollback remains a Git and release choice: install the previous known-good T4 package. There is no runtime fallback to the fork.

The simplified rollout does not weaken the hard boundaries. We retain strict protocol versioning, fail-closed lock behavior, secret redaction, process isolation, restart/reconnect tests, signed host packaging, exact artifact provenance, and protection for existing local development session files.

## Released product state

T4 v0.1.32 is paired with official OMP tag `v18.0.11` at commit `b8ce33a58911c26bed1d84f0db9a5e2e727c49a2`. Its published Apple Silicon binary is 131,679,120 bytes with SHA-256 `88b4a3e68e19904b8fcc1ba4b319ef68795f4fe06a6d101d564fc482cb0cc252`.

The protected T4 product build remains the distribution-signing boundary. It verifies the official release checksum, then signs the bundled OMP executable and `t4-host` with T4's Developer ID identity before shipping the macOS app.

The compatibility matrix records official OMP as the verified, published, and packaged runtime. The earlier `lyc-aon/oh-my-pi` repository remains only as frozen provenance for the app-wire compatibility package and historical host-source migration in `provenance/omp-host-migration.json`; it is not an executable runtime dependency.
