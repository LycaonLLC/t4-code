# Ownership and handoffs

These boundaries coordinate changes across the released repository and planned architecture paths.
They are defaults, not permanent titles or exclusive locks. When active work overlaps, name an
integration owner or land the smaller shared contract first.

## Current repository paths

| Path                                                                     | Primary owner                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `apps/flutter/**`                                                        | Flutter client and provider owner                                                        |
| `packages/host-wire/**`, network-frame changes in `packages/protocol/**` | Protocol owner                                                                           |
| `packages/host-service/**`, `packages/host-daemon/**`                    | T4 Local systems owner                                                                   |
| `packages/client/**`, `packages/fixture-server/**`                       | Client data and fixtures owner                                                           |
| `packages/remote/**`, `packages/service-manager/**`                      | Pairing, remote connection, and native service-lifecycle owner                           |
| `apps/web/**`, `packages/ui/**`, visible copy/assets/screenshots         | Compatibility client experience owner                                                    |
| `apps/desktop/**`                                                        | Compatibility desktop systems owner; coordinate visible UI changes with the client owner |
| Root manifests, workspace configuration, and `pnpm-lock.yaml`            | Integration owner                                                                        |
| `docs/adr/**`, architecture, licenses, notices, and provenance           | Architecture/provenance owner                                                            |

## Planned path reservations

These paths reserve ownership without requiring premature scaffolding:

| Path                                                                 | Primary owner             |
| -------------------------------------------------------------------- | ------------------------- |
| Future `apps/hub/**`, `packages/hub-*/**`                            | Hub systems owner         |
| Future `packages/hub-wire/**`, shared capability and client schemas  | Protocol owner            |
| Future `packages/omp-runtime-adapter/**`, `packages/runtime-wire/**` | Runtime integration owner |
| Future operator, release, and managed deployment paths               | Managed platform owner    |
| Future native Workstation Runner package                             | Workstation systems owner |

## Handoffs

- OMP remains authoritative for runtime behavior. A published T4 release pins one exact compatible
  official OMP artifact.
- Changes to shared client, Hub Wire, Runtime Wire, capability, identifier, or error schemas require
  executable fixtures before consumers enable the behavior.
- Root manifests, workspace configuration, lockfiles, migration identifiers, CI workflows, OCI
  builds, operator APIs, and deployment manifests require an integration owner when lanes overlap.
- Client owners consume normalized capabilities and state; they do not reconstruct OMP behavior or
  backend authority.
- Security-sensitive logs, fixtures, and support data remain bounded and redacted.

## Canonical architecture

[`T4_ARCHITECTURE.html`](T4_ARCHITECTURE.html) is the sole specification for product profiles,
authority, transport, storage, recovery, deployment, performance, and delivery gates.
