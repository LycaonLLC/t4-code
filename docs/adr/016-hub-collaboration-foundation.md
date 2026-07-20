# ADR-016: Establish the T4 Hub collaboration foundation

- Status: accepted as a planning foundation; implementation and infrastructure choices remain pending.

## The problem

T4 already connects to OMP on local and remote hosts. The next product step is a single workspace
that can coordinate sessions across several personal dev boxes, team machines, and managed worker
pools. Building that safely requires more than adding another remote-host screen:

- commands need a durable record before T4 sends them;
- one runtime must own a session at a time, even during a network split;
- a replacement runtime must recover only state that was durably recorded;
- client, Hub, Node, and OMP responsibilities must remain understandable;
- collaborators need separate code ownership so they can work without repeatedly editing the same
  files.

The current T4 Host and OMP authority bridge remain the released architecture from ADR-013. This ADR
does not remove that path. It defines the boundary for proving a Hub alongside it.

## Decision

T4 will explore a central Hub and lightweight Nodes behind two explicit contracts:

```text
T4 client
    |
    | Hub Wire: identity, sessions, commands, events, approvals
    v
T4 Hub
    |
    | Runtime Wire: ownership, dispatch, checkpoints, health
    v
T4 Node
    |
    v
official pinned OMP + workspace
```

The contracts are client-neutral and scheduler-neutral. A React, Flutter, web, or other T4 client
should see the same product behavior. A normal remote dev box can run a lightweight Node without
becoming a Kubernetes cluster. A managed worker pool may add Kubernetes after the runtime behavior
is proven.

### Portable sessions with one active owner

A session is not permanently identified by one physical machine. Its durable parts may be restored
on another suitable Node. At any instant, however, exactly one runtime owns the session under an
`ownerEpoch`.

```text
epoch 17 on Node A -> revoke or fence -> epoch 18 on Node B -> restore -> continue
```

This is restart-and-recover portability, not live process migration. Shell processes, debugger
memory, and a tool call interrupted at an uncertain point do not move between machines.

The Hub may grant a new epoch only after it can prove that the old owner cannot continue making
authoritative changes. Expiring a database lease alone does not prove that a partitioned process has
lost direct write access to a shared filesystem. The storage or Node design must provide a hard
fence before automatic cross-machine recovery can ship.

### Authority boundaries

| Information | Authority |
|---|---|
| Users, permissions, project metadata, command ledger, and current owner epoch | Hub durable store |
| Prompt acceptance, transcript, tools, model behavior, and agent execution | OMP |
| Files and Git state | Workspace filesystem and Git, operated through the Node/runtime |
| Client views and caches | Disposable projections rebuilt from Hub events |
| Logs, traces, and metrics | Non-authoritative diagnostics |

The Node does not connect directly to the Hub database. It communicates through Runtime Wire. The
Hub records OMP-derived events with their source identity and does not invent transcript or tool
state that OMP did not report.

### Command outcomes

A command moves through explicit durable states:

```text
recorded -> claimed(ownerEpoch) -> dispatched -> accepted by OMP -> completed
                                      |
                                      +-> indeterminate after an ambiguous failure
```

T4 does not automatically replay an indeterminate command. An at-most-once execution promise
requires a durable command identity that official OMP recognizes. Until that seam is proven, the UI
must report uncertainty and ask the user what to do.

### Deployment profiles

The same Hub-facing product model may support two execution profiles:

| Profile | Behavior |
|---|---|
| Standard Node | Session normally stays on one Mac or Linux dev box and uses fast machine-local storage. If the box is unavailable, the session stops safely. |
| Managed pool | A scheduler may restart a portable session on another Node after ownership and storage fencing are proven. |

High availability is a capability of a deployment, not a claim made by every installation. A
single-machine setup remains useful but cannot recover while its only machine is offline.

## Proof gates before implementation expands

1. **Official OMP seam:** prove durable acceptance identity, event replay, cancellation, checkpoint
   contents, and restart behavior against an unmodified pinned OMP release.
2. **Contract freeze:** define bounded Hub Wire and Runtime Wire messages, version negotiation,
   command states, epochs, cursors, and failure results.
3. **Physical vertical slice:** submit one command from a real T4 client through a real Hub and Node
   to official OMP, then reconnect and rebuild the same session view.
4. **Ambiguous failure:** kill components before and after dispatch and prove that unknown outcomes
   are visible and never replayed automatically.
5. **Hard fencing:** prove that a partitioned old owner cannot continue writing before another Node
   receives ownership.
6. **Recovery and restore:** test Node loss, Hub loss, storage loss, backup restoration, and Git
   integrity with measured recovery behavior.

Kubernetes, CephFS, MinIO, and a full observability stack remain candidates for managed deployments.
They are not selected for the standard Node profile by this ADR. Client framework migration is also
a separate decision.

## Collaborative ownership

Work is divided by authority rather than by screen:

- the Hub lane owns durable product state, command and ownership state machines, and Hub Wire;
- the Node/runtime lane owns the official OMP seam, process lifecycle, workspaces, checkpoints, and
  Runtime Wire;
- the client lane consumes Hub Wire through a provider boundary and does not reach into Hub storage
  or Runtime Wire;
- the infrastructure lane packages proven behavior and does not define command or ownership
  semantics through deployment manifests.

One integration owner coordinates contract schemas, root manifests, dependency lockfiles, database
migration allocation, and final vertical-slice wiring. The shared work tracker is
[`docs/T4_HUB_TRACKER.md`](../T4_HUB_TRACKER.md).

## Consequences

- Multi-machine coordination becomes a first-class direction without breaking the released local
  Host path before the Hub is proven.
- Ordinary remote dev boxes stay lightweight; managed pools can add stronger scheduling and storage
  when users need them.
- The hardest uncertainties are tested before the team invests in a distributed infrastructure
  stack.
- Portable recovery requires explicit storage fencing and honest treatment of in-flight work.
- Hub and Node developers can work against fakes and contract tests with a small shared edit surface.
