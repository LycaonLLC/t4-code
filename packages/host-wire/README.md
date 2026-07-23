# @t4-code/host-wire

`@t4-code/host-wire` is the dependency-free `omp-app/1` JSON boundary. It owns branded control IDs, allocation-conscious UTF-8 bounds, duplicate-key rejection, cycle-safe JSON validation, safe relative paths, and versioned golden fixtures. JSONL plus profile-scoped lifecycle metadata are the durable session truth. Volatile order uses an opaque string epoch plus a safe sequence; durable entries carry explicit nullable `parentId` and deduplicate by entry ID separately from sequence replay.

Cursor sequence numbers are scoped by frame domain. A session's `snapshot`, `entry`, and `event` frames share the transcript cursor used by `session.attach` replay. Host-wide `session.delta` frames use a separate per-session index cursor and never advance or enter the transcript replay ring. Clients must not compare or merge sequence numbers across those two domains, even when their opaque epoch strings match.

Use `decodeClientFrame` or `decodeServerFrame` at every JSON boundary. These top-level wire decoders accept encoded JSON (`string` or `Uint8Array`) and already-parsed JSON. Known frames preserve additive fields; unknown top-level families fail with typed `AppWireError`; unknown leaf event subtypes are accepted. Hello declares a protocol range, client identity, requested features, and saved cursors. Welcome records selected protocol, host/appserver identity, restart epoch, capabilities, negotiated limits, and resume status.

```ts
import { decodeServerFrame } from "@t4-code/host-wire";
const frame = decodeServerFrame(line); // AppWireError on malformed input
```

Appserver command idempotency is a bounded retry contract. Reusing a pending `commandId` with the same semantic payload waits for its original outcome; a different payload conflicts. For a completed command, the same payload, ignoring only the envelope `requestId`, replays the retained outcome. Completed outcomes expire five minutes after completion. Replay updates the outcome's least-recently-used position without extending that deadline. The default host cache retains at most 1,024 completed outcomes and never evicts pending commands. Once a completed outcome expires or is displaced, the ID is new again and the command may execute again.

`transcript.images` is an additive, metadata-first read path. Projected entries carry only ordered `{ sha256, mimeType }` records in `data.images`; they never carry image bytes or host paths. After negotiating the feature and attaching the session, a client with `sessions.read` may call `session.image.read { entryId, sha256, offset }`. The host verifies that exact entry/digest membership and returns canonical base64 chunks of at most 256 KiB raw bytes. These read-only chunks are intentionally excluded from the completed-command idempotency cache so large response bodies cannot accumulate there; clients may safely retry an offset, and should validate the echoed digest, offsets, size, and completion flag.

`transcript.page` is an additive backward-pagination path for an attached session. A client with `sessions.read` may request entries before an opaque cursor, with an optional entry limit and byte budget. The host returns at most 128 entries in chronological order, an opaque transcript generation, and a next cursor exactly when older history remains. Both requests and results are strictly bounded; a decoded result can never exceed 512 KiB.

`artifacts.read` is the negotiated generic artifact feature. Durable entries may carry session-retained `data.artifacts` descriptors, never paths or bytes. After attachment, `artifact.read { artifactId, offset }` returns a canonical bounded base64 chunk only for a descriptor projected by that session. `files.diff { turnId }` returns a persisted immutable turn-review snapshot; legacy per-path `files.diff` is unchanged. `review.apply` retains the legacy `{ reviewId }` form and adds a typed per-file `{ turnId, path, action }` turn action.

`session.attach` prepares its snapshot or requested replay before acknowledging success. It then delivers the acknowledgement, prepared frames, catch-up replay from the acknowledged baseline, and current subagent state in order. Cached attach delivery rebuilds this connection-scoped output and revalidates session existence, so an old success cannot resurrect a deleted session. Preparation failure does not mark the connection attached.

`session.observer` is additive. When another OMP process owns a session, `SessionRef.liveState.sessionControl` reports categorical observer state without exposing lock or process details. `mode: "observer"` carries `lockStatus: "live" | "suspect" | "malformed"` and `transcript: "live" | "snapshot"`; `mode: "reconciling"` carries only `transcript`; `mode: "unverified"` marks a lockless session whose writer cannot be safely identified or handed off. A missing `sessionControl` means ordinary appserver control. Present but malformed or unknown control data must be treated as read-only.

Appserver accepts one unresolved `session.prompt` per session. A second normal prompt receives `session_busy` before another prompt is written to the RPC child; use `session.steer` or `session.followUp` to add work to an active run. The session remains `active` across intermediate `turn.end` events, including tool-driven multi-turn runs, and returns to `idle` on the final `agent.end`.

The appserver consumes child-RPC `prompt_result` frames internally instead of forwarding them as `omp-app/1` frames. A matching local-only result returns the session to `idle`; a matching late failure emits a sanitized `turn.error` and then returns it to `idle`. A stale result may still produce diagnostic output, but it cannot release newer work. A rejected or non-invoking child response, a dispatch failure, or a successful cancel also releases the prompt lifecycle. Runtime closure or child termination releases ownership and marks the session `closed`.

The exact device capability set and command mapping are exported. Destructive confirmation is separate from one-time `pair.start`/`pair.ok` pairing. File and review paths, plus known file-command arguments, must be safe relative POSIX paths. Remote-only transport supervision and terminal scraping remain outside this wire package.

`preview.control` is negotiated. Clients may expose browser preview only when the welcome frame advertises the feature and the matching `preview.read`, `preview.control`, or `preview.input` capability. The command family covers launch and tab state, bounded capture chunks, navigation, input, uploads, policy checks, leases, and human handoff. Each command keeps its own capability, revision, and confirmation policy.

## Revision ownership

Every command descriptor declares both its revision policy and its owner:

- `session`: session lifecycle/prompt/cancel/close, agent, bash, terminal, lease, and preview commands. The appserver compares these revisions with the session projection.
- `authority`: `files.*`, `review.*`, `config.write`, and `settings.write`. The resource authority receives the opaque `expectedRevision` unchanged and performs the resource comparison.
- `none`: host/session listing and attachment, audit, settings reads, catalog, and watch commands. These commands reject `expectedRevision`.

`revision: "none"` always has `revisionOwner: "none"`; optional and required revisions always name either `session` or `authority`.
`session.create` accepts an opaque `projectId` and optional title. The server resolves that ID to a local project root; clients cannot send a filesystem path. `term.open.args.cwd`, when present, is a safe relative path beneath the selected project root.
