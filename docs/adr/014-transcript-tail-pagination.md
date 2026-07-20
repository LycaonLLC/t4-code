# ADR 014: Paint the transcript tail before loading older history

- Status: accepted in the T4-owned host; the current legacy OMP bridge does not expose it yet.

## The problem

Session discovery is lazy, but opening a cold session was not. The old attach path still read and
projected the complete JSONL transcript before it could send the bounded snapshot that the client
actually displays. A session larger than 64 MiB could not load transcript entries at all.

That made open time depend on the total age of the session. It also mixed two different jobs:

```text
live stream and reconnect             older saved history
forward-only `{ epoch, seq }` cursor  backward-only opaque page cursor
must be exact                         may be requested when needed
```

## Decision

T4 keeps those jobs separate.

```text
Cold session open
      |
      +-- transcript.page (small newest page) --> paint useful messages
      |
      +-- session.attach -----------------------> live snapshot and forward events

User asks for earlier messages
      |
      +-- transcript.page(before: opaque token) -> prepend one bounded page
```

`transcript.page` is a negotiated, session-scoped `sessions.read` command. Each response contains
chronological durable entries, an opaque generation, and an optional opaque cursor for the next
older page. The wire caps one page at 128 entries and 512 KiB.

The host reads bounded ranges from the end of the JSONL file. Its encrypted cursor binds the
session, file identity, frozen end, generation, and small rewrite anchors. Append-only growth does
not invalidate an in-progress backward walk. Replacement, truncation, or a changed anchor does.

The page cursor never enters the live projection, replay ring, reconnect journal, session revision,
or `{ epoch, seq }` cursor. The client prepends page entries by stable entry ID while live events
continue to append normally.

## Client behavior

- A warm session with a saved live cursor attaches immediately, exactly as before.
- A cold supported session requests a 64-entry, 256 KiB tail first. Attach starts after that small
  request settles, even if paging is unavailable or fails.
- The timeline exposes an explicit **Load earlier messages** control. Prepends preserve the visible
  list position and do not raise the **New output** indicator.
- Unsupported hosts silently retain the previous attach behavior.
- A stale paging generation is an explicit retryable history error; it does not disturb the live
  transcript.

## Flutter handoff

Flutter should use the same two-lane contract rather than copy the web implementation:

```text
open screen
  -> paint locally cached tail, when present
  -> request newest transcript.page and reconcile by entry ID
  -> attach the live stream

scroll near top
  -> request page with the saved opaque before token
  -> prepend rows while preserving the first visible row and its pixel offset
```

The mobile cache should be a small local database keyed by host ID, session ID, and generation. It
is display-only: the host remains authoritative, and cached entries never advance the live cursor or
enable writes while offline. Store page cursors only for the host process that issued them; a host
restart intentionally expires the current process-local encrypted cursor.

## Limits and follow-up

This change makes first useful paint independent of the full transcript scan by issuing the bounded
page before attach. It does not yet replace the host's own `session.attach` hydration with a seeded
tail observer. Doing that safely requires an observer that begins at the same EOF state; the current
observer starts at byte zero and could otherwise replace the newest tail with an oldest prefix while
catching up.

The bounded projector backscan preserves ordinary tool call/result pairs. A tool pair separated by
more than 512 KiB can lose its joined presentation on a page boundary without corrupting pagination.
The current T4-owned host packages also still need the planned thin OMP launcher before this feature
is available in the released legacy OMP bridge.

## Verification

Coverage includes strict wire fixtures, full-result byte limits, malformed and stale cursors,
append-stable walks, adjacent-page deduplication, files larger than 64 MiB, server policy/routing,
cold page-before-attach ordering, overlap-safe prepends, and proof that page loads do not change the
live cursor.
