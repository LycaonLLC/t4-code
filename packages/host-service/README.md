# @t4-code/host-service

This package is T4's local control service. It owns the WebSocket server, replay and projections, remote pairing and authorization, transcript search, artifacts, backend-neutral ACP runtime adapters, and Git workspace lifecycle.

OMP still owns its session files, locks, agent workers, settings, credentials, and takeover decisions. Those responsibilities enter through the injected authority interfaces in `src/types.ts` and the structural RPC types in `src/omp-rpc-contract.ts`.

The package currently carries a bounded, read-only OMP JSONL compatibility projector so the existing bridge remains usable during extraction. It must not mutate OMP files or infer lock ownership. The target OMP adapter replaces file projection with a public catalog and event stream while keeping the same host interfaces.

The `omp-app/1` protocol name remains during the migration because released clients and verified OMP builds already speak it. Package ownership and protocol compatibility are separate: T4 owns this implementation even while the wire name remains stable.
