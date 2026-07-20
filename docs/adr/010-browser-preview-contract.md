# ADR-010: Native Browser and Host Preview Contract

- Status: Accepted
- Decision: T4 Code provides a desktop-only native Browser workspace alongside, rather than in place of, the existing host-backed Browser Preview workspace. The two surfaces have separate ownership, authority, and capability contracts.

## 1. Separate browser surfaces

The native Browser workspace is available only in the T4 Code desktop app, where Electron can embed native browser surfaces. It is not a replacement for the session-linked Host Preview workspace: Host Preview remains available from a session when the connected host advertises it.

Each native Browser tab has a stable `surfaceId` for its lifetime. The Browser IPC contract exposes a surface's handle, profile, URL, title, lifecycle and ready states, navigation availability, bounds, visibility, focus, and timestamps. Callers operate on that surface identifier and receive a `not_found` error after it is closed.

## 2. Isolated default and exact authenticated-profile opt-in

New native Browser surfaces use the credential-isolated `isolated-session` profile. The runtime does not discover, implicitly import, or auto-select an authenticated browser profile.

An authenticated profile is a separately named persistent Electron partition that can contain cookies or other authenticated browser state. It MUST NEVER be selected implicitly. Every operation using one requires an exact profile object whose `profileId` matches the user's selected profile and whose `explicitOptIn` value is `true`; incomplete, mismatched, or stale selections are rejected. Cookie import also requires a user-selected JSON export and an exact authenticated profile.

## 3. Bounded native automation

Browser IPC is a bounded, per-surface interface. It covers surface lifecycle and navigation, snapshots and screenshots, limited DOM queries and actions, keyboard and mouse input, console output, cookies and storage, downloads, bounds, mute, focus, and restore. Inputs and results are validated and bounded by the desktop runtime; unavailable operations return a coded error instead of falling through to the host Preview path.

The protocol includes a touch-input capability name for compatibility, but native touch input is currently unsupported because Electron `WebContents.sendInputEvent` cannot send it. A `browser.input_touch` request returns `not_supported`.

## 4. Lifecycle teardown

The desktop lifecycle disposes the native Browser runtime when its renderer begins reloading, when its window closes, and while the application stops. Disposal closes every native surface, releases profile-use tracking, disposes security, network, automation, capture, input, profile, and download controllers, and clears the runtime's active-surface state before persisting its session metadata. Events from a stale runtime are not forwarded to a replacement renderer.

## 5. Host Preview remains host-backed

Host Preview continues to project the bounded preview state supplied by the connected host and accepts only the preview actions that host advertises. Its host-side authority, capability, and lease behavior are independent of the desktop Browser runtime. Native Browser profiles and automation never grant Host Preview access to desktop browser state.
