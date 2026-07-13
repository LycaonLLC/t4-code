export { OmpClient, createOmpClient } from "./omp-client-runtime.ts";
export { isConfirmationDecisionConsumed } from "./omp-client-response.ts";
export {
  OmpClientError,
  DefaultClock,
  DefaultIds,
  DefaultTimers,
  MAX_SAVED,
  MAX_PENDING,
  MAX_INBOUND_FRAMES,
  MAX_INBOUND_BYTES,
} from "./omp-client-contracts.ts";
export type {
  OmpClientState,
  ClientErrorCode,
  OmpClientErrorOptions,
  OmpTransport,
  OmpTransportFactory,
  Unsubscribe,
  CursorRecord,
  CursorStore,
  Clock,
  TimerScheduler,
  IdFactory,
  OmpClientOptions,
  OmpStateSnapshot,
  OmpResourceSnapshot,
  CommandIntent,
  CommandOptions,
  ConfirmIntent,
  PairStartIntent,
  TerminalInputIntent,
  TerminalResizeIntent,
  TerminalCloseIntent,
  PublicServerFrame,
} from "./omp-client-contracts.ts";
export {
  PROJECTION_CACHE_VERSION,
  MAX_PROJECTION_CACHE_BYTES,
  MAX_PROJECTION_CACHE_SESSIONS,
  encodeProjectionCache,
  decodeProjectionCache,
  decodeProjectionCacheValue,
} from "./projection-cache.ts";
export type { ProjectionCacheStore, ProjectionCacheEnvelope } from "./projection-cache.ts";
export {
  createProjectionSnapshot,
  applyPublicFrame,
  ProjectionStore,
  createProjectionStore,
} from "./projection.ts";
export type {
  ProjectionFrame,
  ProjectionFreshness,
  TerminalProjection,
  ResultProjection,
  SessionProjection,
  ProjectionSnapshot,
  SessionIndexMetadata,
  ProjectionOptions,
  ProjectionSubscription,
} from "./projection.ts";
export {
  DesktopRuntimeError,
  DesktopRuntimeController,
  createDesktopRuntimeController,
} from "./desktop-runtime.ts";
export { redactedMessage } from "./desktop-runtime-contracts.ts";
export type {
  DesktopShellPort,
  DesktopRuntimeStartState,
  DesktopHostMetadata,
  DesktopRuntimeErrorEntry,
  DesktopFrameFilter,
  DesktopFrameSubscription,
  DesktopRuntimeSnapshot,
  DesktopRuntimeSnapshotListener,
  DesktopRuntimeOptions,
  DesktopControllerLease,
  DesktopControllerLeaseAcquireResult,
  DesktopControllerLeaseResult,
  DesktopControllerLeaseOperationResult,
  DesktopControllerLeaseOptions,
} from "./desktop-runtime.ts";
