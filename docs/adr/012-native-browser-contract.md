# ADR 012: Native Browser workspace security contract

## Status

Accepted with the desktop-only Native Browser workspace.

## Problem

The desktop app can embed real Electron browser surfaces. Those surfaces can hold cookies, load authenticated pages, and intercept network traffic, so treating them as ordinary UI tabs would let one OMP session affect or observe another.

The existing host-backed Browser Preview has a different trust boundary. Its host policy checks, confirmation challenges, control leases, upload rules, and capture limits remain defined by ADR-010.

## Decision

Native Browser and host Browser Preview remain separate products with separate authority.

```text
OMP session A ---> isolated Electron partition A ---> native surfaces A1, A2
OMP session B ---> isolated Electron partition B ---> native surfaces B1, B2

named profile ---> persistent Electron partition ---> user-approved surface only

connected host ---> ADR-010 host policy and lease contract ---> Browser Preview
```

### Isolated sessions

The default `isolated-session` profile receives one non-persistent Electron partition per owning OMP session. Tabs owned by the same OMP session may share cookies and cache with each other. Tabs owned by different OMP sessions must not share them. The partition name uses a one-way hash so the durable OMP session identifier is not exposed in Electron diagnostics.

The runtime fails closed if it cannot create the requested isolated partition. It never falls back to Electron's default session.

### Authenticated profiles

A named authenticated profile is persistent and can contain login state. It requires the exact profile identifier and an explicit user choice. Authenticated surfaces and their URLs are not restored after an app restart because an old saved choice is not fresh consent. Popups from authenticated surfaces are blocked until the product can ask the user whether the new surface may use that profile.

### Network controls

Electron allows only one listener for each `WebRequest` event on a Session. T4 therefore installs one listener and routes each event to the policy for the matching Electron `webContentsId`. Request logs, route rules, and extra headers remain scoped to their native surface.

User-agent changes use the individual WebContents API. Offline, throttling, and proxy controls are reported as unsupported because Electron exposes them at Session scope, where changing them could silently affect sibling tabs.

### Lifecycle

Closing a surface removes its network policy, security controller, download controller, and profile-use record. Removing one surface must not remove the shared listener while another surface still uses the same Electron Session. When the last surface leaves, the listener is detached.

## Verification boundary

Unit tests prove that separate OMP owners receive separate partitions, a shared Electron Session safely dispatches network events by surface, authenticated pages do not restore without fresh consent, and authenticated popups are rejected. A release claim still requires a packaged desktop smoke test because mocked Electron objects cannot prove native view behavior.
