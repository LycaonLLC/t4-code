# ADR-002: OMP runtime boundary

- Status: Superseded by ADR-013
- Historical decision: OMP owned `packages/app-wire/**` and `packages/appserver/**`; `ompd` launched one `omp --mode rpc` child per live session. ADR-013 moves the generic host and wire ownership to T4. OMP now supplies the narrow authority bridge and remains responsible for OMP session state and workers.
- Consequence: process-global OMP state remains isolated; child failure affects only its session.
