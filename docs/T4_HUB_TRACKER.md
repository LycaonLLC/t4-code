# T4 Hub development tracker

This is the shared source of truth for the first T4 Hub development slice. It tracks decisions and
proof, not optimistic completion claims. Update a row only when its linked evidence is available.

## Status language

| Status | Meaning |
|---|---|
| Ready | Its dependencies are complete and the scope is stable enough to start. |
| Active | An owner and branch are recorded and work is underway. |
| Blocked | A named dependency or failed proof prevents safe progress. |
| Review | The implementation and evidence are in a pull request. |
| Done | The pull request is merged and the acceptance evidence is linked. |

## Dependency map

```text
H1 official OMP proof
          |
          v
H2 contract freeze
    /          |          \
   v           v           v
H3 Hub core  H4 Node     H5 client provider
    \          |          /
     \         |         /
      v        v        v
       H6 physical slice
               |
               v
       H7 fencing/recovery
          /             \
         v               v
H8 standard Node    H9 managed pool proof
         \               /
          v             v
          H10 product integrations
```

## Work items

| ID | Status | Scope | Acceptance evidence | Depends on | Lead | Reviewer | Branch/PR |
|---|---|---|---|---|---|---|---|
| H1 | Ready | Prove the official pinned OMP seam: durable prompt acceptance identity, replay cursor, cancellation, checkpoint contents, restart, and ambiguous disconnect behavior. | Reproducible harness, captured protocol fixtures, and a written supported/unsupported matrix. | — | Unassigned | Unassigned | — |
| H2 | Blocked | Freeze the first Hub Wire and Runtime Wire contracts, command state machine, owner epoch rules, cursors, bounds, and version negotiation. | Golden frames, executable decoders, compatibility tests, and failure cases. | H1 | Unassigned | Unassigned | — |
| H3 | Blocked | Build the Hub command ledger, transactional dispatch queue, session/Node registry, event replay, authentication boundary, and fake runtime. | Focused database and state-machine tests, including crash-before-dispatch and crash-after-dispatch. | H2 | Unassigned | Unassigned | — |
| H4 | Blocked | Build Node registration, pinned OMP lifecycle, command dispatch, checkpoint reporting, workspace operations, epoch rejection, and fake Hub. | Runtime contract suite passes against the fake Hub and official OMP fixture. | H2 | Unassigned | Unassigned | — |
| H5 | Blocked | Add a Hub target behind the T4 client provider boundary without coupling UI code to Hub storage or Runtime Wire. | Fixture-driven client tests for connect, reconnect, offline, observer, denied, indeterminate, and stale-owner states. | H2 | Unassigned | Unassigned | — |
| H6 | Blocked | Connect a physical T4 client to a real Hub and Node, submit one unique command to official OMP, and rebuild the same view after reconnect. | Repeatable end-to-end test plus a redacted run artifact showing identifiers and transitions. | H3, H4, H5 | Unassigned | Unassigned | — |
| H7 | Blocked | Prove ambiguous-failure handling, ownership transfer, hard write fencing, backup consistency, and Git-safe recovery. | Failure matrix including a network-partitioned old owner that cannot write after replacement. | H6 | Unassigned | Unassigned | — |
| H8 | Blocked | Package the lightweight standard Node for an ordinary remote Mac or Linux dev box with safe stopped-session degradation. | Install, update, reconnect, stop, repair, and rollback proof without Kubernetes or shared storage. | H7 | Unassigned | Unassigned | — |
| H9 | Blocked | Evaluate the managed worker-pool profile and select scheduling, storage, artifact, and observability components from measured evidence. | Git/dependency filesystem benchmark, resource floor, failure tests, security review, and restore drill. | H7 | Unassigned | Unassigned | — |
| H10 | Blocked | Add typed CI, approval, deployment, and notification events after the durable session path is trustworthy. | One integration at a time with scoped credentials, provenance, replay, and revocation tests. | H8 or H9 | Unassigned | Unassigned | — |

## Development lanes

| Lane | Owns | Does not own | Expected path boundary |
|---|---|---|---|
| Hub | Durable product state, Hub Wire server, commands, epochs, events, auth decisions | OMP internals, direct workspace writes, client UI | Future `apps/hub/**` and `packages/hub-*/**` |
| Node/runtime | Runtime Wire, official OMP adapter, process lifecycle, checkpoint reporting, workspace/Git operations | Hub database, product permissions, client UI | Future `apps/node/**`, `packages/runtime-wire/**`, and `packages/omp-runtime-adapter/**` |
| Client | Hub provider, disposable projections, connection and recovery presentation | Hub database, Runtime Wire, OMP reconstruction | Existing client app plus a narrow provider package selected in H2 |
| Infrastructure | Packaging, scheduler/operator, storage, backups, secrets, diagnostics | Product command semantics and runtime authority rules | Future `deploy/hub/**` or another path selected in H9 |
| Integration | Shared schemas, root manifests, lockfile, migration allocation, final wiring | Long-running feature implementation inside another lane | Small, reviewed edits across shared paths |

Paths labeled `Future` are reservations, not scaffolding requirements. H2 may reuse an existing
package when that produces a clearer boundary.

## Two-person starting split

Until H2 is complete, the lowest-conflict split is:

| Developer | Primary work | Test double |
|---|---|---|
| Hub lead | Draft H2 command/ownership contracts, then implement H3 | Fake Runtime Wire peer |
| Runtime lead | Prove H1, then implement H4 against the frozen contract | Fake Hub Wire peer |

H2 can be drafted while H1 runs, but it cannot be frozen until the OMP evidence is known. After H2,
client-provider work can proceed independently against golden Hub fixtures. The physical slice is
the planned meeting point; neither lane should bypass the contract to make the demo work.

## Shared-file coordination

Assign one integration owner before touching these paths:

- Hub Wire and Runtime Wire schemas and generated bindings;
- root `package.json`, workspace configuration, and `pnpm-lock.yaml`;
- database migration numbers;
- `docs/adr/**`, `PRODUCT_BRIEF.md`, and `docs/OWNERSHIP.md`;
- CI workflows and deployment manifests.

Each work row records one lead, one reviewer, one branch or PR, and links to proof. Prefer small PRs
that merge into `main` behind unavailable capability flags over a long-lived integration branch.

## First physical slice

The first integrated milestone is intentionally narrow:

1. A physical T4 client lists one registered Node.
2. The user creates one session and submits a unique harmless prompt.
3. The Hub records the command before dispatch.
4. The Node starts official pinned OMP and reports acceptance separately from completion.
5. The client receives the result, disconnects, reconnects, and rebuilds the same view.
6. Repeating the run with a crash immediately after dispatch produces `indeterminate` unless OMP can
   prove durable acceptance. T4 does not replay the command automatically.

## Explicitly deferred

- live process migration;
- automatic failover before hard write fencing is proven;
- mandatory Kubernetes or shared storage for a standard Node;
- selecting CephFS, MinIO, or a full observability stack without comparative proof;
- coupling the Hub architecture to one client framework;
- CI/CD integrations before the durable session path passes recovery testing.
