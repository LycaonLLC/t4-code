# ADR-010: Browser Preview Workspace and Authority Security Contract

- Status: Accepted
- Decision: Implement a dedicated session-linked Browser/App Preview Workspace. To maintain security isolation, previews must run under credential-isolated authority scopes, enforce lease-locked concurrency controls, restrict directory uploads, and handle memory bounds carefully.

## 1. Pluggable Preview Authority & Explicit Opt-In

To prevent automated credential extraction or session hijacking, preview hosts advertise their authority profile under one of two classifications:
1. `isolated-session` (e.g. OMP session-only browsers): credential-free, ephemeral, and restricted to the session context.
2. `authenticated-profile` (e.g. Wolfgang's real logged-in Google Chrome profile): holds active cookies, session tokens, or identity credentials.

**Security Contract**:
- Authenticated-profile previews MUST NEVER be selected automatically.
- `choosePreview` only selects `isolated-session` previews by default.
- Authenticated-profile previews require explicit, user-initiated selection (matching a concrete `selectedPreviewId` chosen via the UI dropdown).

## 2. Policy & Confirmation Gates

Browser automation actions (such as clicking, typing, navigating, or upload) are privileged.
- The client runtime MUST execute a `preview.policy.check` request before sending any mutation command.
- If the host-level policy check reports `confirmationRequired: true`, the client MUST prompt the user with an explicit approval confirmation dialog.
- The command is only sent to the transport if approved by the user.

## 3. Concurrency Lease Locks

To prevent race conditions and multi-agent command collisions over a shared browser instance, mutations are guarded by lease locks:
- Client-side mutations are routed through the `PreviewLeaseManager`.
- Before executing click, type, fill, scroll, select, or upload, the manager acquires a lease (`preview.lease.acquire`) with a finite time-to-live (TTL).
- The lease is renewed half-way through its TTL (`preview.lease.renew`).
- On any transport disconnection, mutation failure, or timeout, the lease token is immediately invalidated and cleared from local memory to prevent subsequent execution hijacking.

## 4. Directory and Path Confinement

The preview upload action allows selecting local files to upload via input elements:
- File paths MUST be validated via `isProjectRelativeUploadPath(path)` prior to transmission.
- Absolute paths, windows drive letters, and parent traversal sequences (`..`) are strictly rejected.
- Upload actions are confined exclusively to project-relative assets within the workspace directory.

## 5. Capture Object-URL Memory Management

Screenshot captures contain base64 image data sent in chunks:
- Decoded screenshots are loaded as memory-bounded Blobs via `URL.createObjectURL(blob)`.
- To prevent browser memory leaks from accumulated images, the runtime MUST immediately revoke the active URL using `URL.revokeObjectURL(url)` whenever a preview is replaced, closed, or the session runtime is disposed.
