# ADR 017: Search project filenames through the trusted host

- Status: accepted; release pending.

## The problem

Quick Open could find only files whose folders the user had already expanded in the Files panel.
That was honest, but it made a common IDE action depend on unrelated browsing. Letting the React
renderer recursively inspect the disk would be the wrong fix: a remote client could choose a root,
large projects could create unbounded work, and symlinks could lead outside the project.

## Decision

`files.search` is a small, read-only host command. It accepts only a query and result limit. It never
accepts an absolute path.

```text
Quick Open query
      |
      v
T4 client checks feature + files.list permission
      |
      v
T4 host asks OMP for this session's project root
      |
      v
bounded filename scan -> ranked relative paths
      |
      v
existing file.open action -> existing files.read boundary
```

OMP remains the authority for which project belongs to the session. The generic T4 host owns the
bounded filename-search mechanism, just as it owns other desktop indexes and projections. The
renderer receives only safe relative file paths.

In a Git worktree, the host uses Git's tracked-and-untracked file index with normal ignore rules. In
a non-Git folder, it uses a bounded directory walk. Both routes skip `.git`, `node_modules`, and
symbolic links. They stop after 50,000 paths, 8 MiB of Git output, or two seconds. Results are ranked
in memory, capped at 50 on the wire, and not persisted. A new query for the same session stops the
older scan. The result says `truncated: true` when a limit prevented a complete answer or more valid
matches exist than were returned.

## Compatibility and user-facing truth

The command is protected by the existing `files.list` permission and a separately negotiated
`files.search` feature. A host that does not advertise both is never called. Quick Open then keeps
showing its already-loaded file matches and says that project search is unavailable. While a live
query is running, old project results are removed; late replies cannot replace newer results.

Opening a match does not add a new file-read path. It selects the relative path in the existing Files
surface, whose normal `files.read` authority performs the actual read and containment checks.

## Verification

Tests cover strict query/result decoding, feature and permission negotiation, OMP-root resolution,
Git ignore behavior, non-Git fallback, symlink exclusion, ranking, caps, superseded scans, invalid
host replies, Quick Open merge/deduplication, loaded-file fallback, and the desktop fixture path.
