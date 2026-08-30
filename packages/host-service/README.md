# @t4-code/host-service

This package is T4's local control service. It owns the WebSocket server, replay and projections, remote pairing and authorization, transcript search, artifacts, backend-neutral ACP runtime adapters, and Git workspace lifecycle.

OMP still owns its session files, locks, agent workers, settings, credentials, and takeover decisions. Those responsibilities enter through the injected authority interfaces in `src/types.ts`. The released standalone T4 host supplies them with `OfficialOmpProfileAuthority`, which reads the verified official JSONL format and starts the same official OMP executable in RPC mode for live control.

The package retains the legacy `t4-omp-authority/1` bridge client as an optional adapter, but released desktop and cluster paths do not select it. The official authority projector is bounded and refuses ambiguous or actively owned sessions. Message mutation and agent execution stay inside OMP.

The client-facing `omp-app/1` protocol name remains stable. Package ownership and protocol compatibility are separate: T4 owns this service and official OMP owns the durable session and runtime contracts.
