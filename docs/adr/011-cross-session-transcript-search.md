# ADR 011: Cross-session transcript search

## Status

Accepted and implemented as one coordinated OMP host contract plus one T4 client and UI slice.

## Problem

People remember a decision or code discussion, but often do not remember which session or machine
contains it. T4 intentionally keeps only bounded warm transcript projections, so searching the
renderer cache would miss older sessions and would give misleading results when a host is offline.

## Decision

Each OMP profile owns a private, rebuildable SQLite full-text index. T4 asks every connected host
independently and merges the bounded answers in memory.

```text
T4 /search route
      |
      +-- local profile A ----> profile A SQLite index
      +-- local profile B ----> profile B SQLite index
      +-- paired host --------> that host's SQLite index
      +-- Tailnet host -------> that host's SQLite index
```

There is no T4 cloud index and no host-to-host search. The existing authenticated target binding,
`sessions.read` capability, and negotiated `transcript.search` feature remain the authority boundary.

## Protocol shape

| Command | Scope | Purpose |
| --- | --- | --- |
| `transcript.search` | Host | Return bounded snippets, entry IDs, filters, per-host coverage, and an opaque cursor |
| `transcript.context` | Session | Return a bounded read-only window around one durable entry ID |

Search cursors belong to one host and one exact query/filter set. T4 paginates one host at a time and
never sends one host's cursor to another host.

The context command is separate from `session.attach`. Opening an old result therefore cannot replace,
truncate, or corrupt the live session projection. The UI labels the window as older read-only context
and offers an explicit action to return to the live tail.

## Search corpus and privacy

The index includes visible durable user text, assistant text, visible custom messages, and compaction
summaries. It excludes hidden messages, reasoning, tool arguments/results, images, and local paths.
OMP applies its display-safe text sanitizer before indexing.

Queries, result lists, snippets, and context windows remain in memory. They are not added to URLs,
browser history, workspace persistence, projection caches, or the appserver completed-command cache.
Snippets are rendered as plain text, never as HTML or Markdown.

## Product shape

- `Cmd/Ctrl+K` can hand the current phrase to the full `/search` route.
- A visible titlebar search action makes the feature discoverable on narrow and touch layouts.
- The full route provides project, role, and archive filters; per-host ready/indexing/offline/
  unsupported/error states; bounded pagination; and read-only historic context.
- Archived sessions are included by default because finding old work is the primary use case.
- Partial results remain visible when one host is offline, outdated, indexing, or failed.

## Failure behavior

An older host is marked unsupported instead of queried. An offline host is not searched through a
stale renderer cache. One bad OMP session marks that host's index incomplete but does not block healthy
sessions or other hosts. Deleted or moved anchors return a stable not-found error and leave the current
search results available.

## Verification boundary

The implementation is covered at four boundaries:

1. strict app-wire request/result fixtures and bounds;
2. SQLite extraction, rewrite, pagination, Unicode, deletion, and crash-consistency tests;
3. appserver feature, capability, lifecycle, error, and idempotency tests; and
4. T4 multi-host coordination, cancellation, pagination, UI state, and historic-context tests.

A fixture/browser screenshot proves layout only. A real release claim still requires a supporting OMP
runtime on local, named-profile, paired-host, and Tailnet paths.
