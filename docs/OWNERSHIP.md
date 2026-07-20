# Ownership and handoffs

These boundaries describe the released T4 repository and reserve low-conflict lanes for the Hub
work. Assign people to roles in the relevant tracker or pull request; the role names are not
permanent team titles.

## Current repository paths

| Path | Primary owner |
|---|---|
| `packages/host-wire/**`, network-frame changes in `packages/protocol/**` | Protocol owner |
| `packages/host-service/**`, `packages/host-daemon/**` | Host systems owner |
| `packages/client/**`, `packages/fixture-server/**` | Client data and fixtures owner |
| `packages/remote/**`, `packages/service-manager/**` | Remote connection and service-lifecycle owner |
| `apps/web/**`, `packages/ui/**`, visible copy/assets/screenshots | Client experience owner |
| `apps/desktop/**` | Desktop systems owner; coordinate visible UI changes with the client owner |
| `apps/mobile/**` | Mobile packaging owner; shared web behavior stays in `apps/web` |
| Root manifests, workspace configuration, and `pnpm-lock.yaml` | Integration owner |
| `docs/adr/**`, architecture, licenses, notices, and provenance | Architecture/provenance owner |

OMP owns the authority bridge and runtime behavior described in ADR-013. T4 owns the generic host,
wire contract, remote policy, projections, and client experience. A published T4 release still pins
one exact compatible OMP artifact.

## Planned Hub paths

| Lane | Reserved scope | Boundary |
|---|---|---|
| Hub | Future `apps/hub/**` and `packages/hub-*/**` | Owns durable product state and Hub Wire; does not write workspaces directly. |
| Node/runtime | Future `apps/node/**`, `packages/runtime-wire/**`, and `packages/omp-runtime-adapter/**` | Owns OMP lifecycle and workspace operations; does not connect to the Hub database. |
| Client | A provider boundary selected during contract work | Consumes Hub Wire; does not consume Runtime Wire or reconstruct OMP truth. |
| Infrastructure | Future deployment path selected after recovery proof | Packages proven behavior; does not define command or ownership semantics. |

These names reserve collaboration lanes, not mandatory package scaffolding. The contract phase may
reuse an existing package when that creates a clearer boundary.

## Shared-file handoffs

Use one integration owner for protocol schemas, generated bindings, database migration allocation,
root manifests, the lockfile, CI workflows, and final vertical-slice wiring. A change to a shared
contract should be a small reviewable PR before consumers depend on it.

Backend-to-client handoff includes protocol version, capabilities, golden fixtures, stable IDs and
revisions, and loading, empty, stale, reconnecting, denied, indeterminate, and old-owner states. The
client does not create a shadow schema or present unavailable capabilities as working.

Runtime-to-Hub handoff includes the pinned OMP version, acceptance and replay behavior, checkpoint
contents, cancellation behavior, failure ambiguity, and executable contract fixtures. The Hub does
not infer acceptance from dispatch alone.

Every T3-derived port keeps its import record. Security-sensitive logs and fixtures remain bounded
and redacted. The active Hub work and evidence links live in
[`T4_HUB_TRACKER.md`](T4_HUB_TRACKER.md).
