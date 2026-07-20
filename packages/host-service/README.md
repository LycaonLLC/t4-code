# @t4-code/host-service

This package is T4's local control service. It owns the WebSocket server, replay and projections, remote pairing and authorization, transcript search, artifacts, backend-neutral ACP runtime adapters, and Git workspace lifecycle.

OMP still owns its session files, locks, agent workers, settings, credentials, and takeover decisions. Those responsibilities enter through the injected authority interfaces in `src/types.ts`. The standalone T4 host receives them through the versioned `t4-omp-authority/1` stdio bridge.

The package retains a bounded, read-only OMP JSONL projector for transcript indexing. It must not mutate OMP files or infer lock ownership. All authoritative discovery, locking, mutation, settings, operation, terminal, and usage decisions cross the public bridge instead of importing OMP source files.

The client-facing `omp-app/1` protocol name remains stable so existing T4 clients keep speaking the same wire contract. Package ownership and protocol compatibility are separate: T4 owns this implementation while OMP exposes only the smaller authority bridge.
