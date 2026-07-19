## Flutter permanent foundations (development)

The local migration branch now contains the Flutter/Dart Stage 2 foundations for macOS, iOS,
Android, and Web, with generated Windows and Linux targets. The client strictly decodes and
encodes the pinned `omp-app/1` corpus, correlates commands, restores typed transcript and
session-index cursors, negotiates host watching, and handles reconnect, resume, and continuity
gaps without moving protocol logic into widgets.

Saved Tailnet hosts, active-host selection, device pairing, host switching, and credential removal
now use shared Dart contracts. Host metadata is stored separately from device credentials; Android
uses encrypted storage and migrates the released app's keyed credentials without exposing them to
Dart, while Apple targets use Keychain-backed storage. Compact and wide layouts share the same
immutable state and command surface, including onboarding, pairing, and host management.

This is still a development migration, not a release cutover. The deterministic fixture suite,
exact 390x844 and 1440x900 browser checks, iOS and Android target smokes, and an authenticated
disposable OMP appserver connection pass locally. The existing Electron, React, browser, and
Capacitor clients remain the released implementation until the complete feature matrix, packaging,
update, migration, security, and release gates pass.

Stage 3 host parity is now complete on the local migration branch. The Flutter client presents
negotiated device permissions, deliberate disconnect/reconnect controls, cancellable pre-save host
checks, an exact least-authority pairing command, pairing failures, and confirmed host removal that
deletes only the device-local address and credential.

Stage 3 project and session parity is also complete locally. The shared session rail consumes the
canonical session index, groups and searches current or archived sessions, creates and selects
sessions, and exposes rename, runtime termination, archive, restore, and confirmed permanent
deletion through revisioned app-wire commands. Compact drawers and wide rails share the same state
and actions.


## Signed and notarized on macOS

T4 Code v0.1.24 is the first macOS release signed with the project's pinned Developer ID identity and notarized by Apple. The protected release job reopens both the DMG and ZIP, checks their certificate and Team ID, hardened runtime, secure timestamp, stapled notarization ticket, and Gatekeeper result, and stops publication if any of them drift.

Local development can still produce an explicitly unsigned package without release credentials. Signing secrets are available only to the protected release job and are never bundled into the app.

## One inbox for sessions that need attention

The attention inbox gathers sessions waiting for a decision, confirmation, or reply. It keeps the host authoritative: T4 projects the host's events into a useful list, deduplicates repeated signals, and routes an action back through the owning session instead of inventing local state.

Older runtimes remain usable. Attention controls appear only when the connected host advertises the required contract.

## Clearer connection health

Session screens now distinguish reconnecting, delayed, and degraded transport states. Provider diagnostics explain what T4 last confirmed and whether it is safe to act, rather than collapsing every interruption into a generic disconnected message.

## Faster bounded projections

Transcript and attention projections now avoid repeated full-history work where a bounded update is sufficient. Ordering, deduplication, retention, and host-authority checks remain intact.

## Browser preview workspace

Session-linked browser previews now open in a dedicated workspace. The client projects bounded, sanitized preview state from the host, maps pointer and keyboard input through explicit permission gates, and uses leases so two clients cannot silently control the same preview at once. Preview activity records origins and paths without storing query strings, page pixels, credentials, or backend error text.

## Runtime provenance

T4 Code v0.1.24 vendors app-wire 0.6.1 from integration commit [e3e15c03](https://github.com/lyc-aon/oh-my-pi/commit/e3e15c03ae95ebbda5f26495cd21213cc53518b1), source tree `e0f32b279eb4b8cbc403e47d765a226bee99c99f`. The client contract remains `omp-app/1`.

The verified OMP 17.0.5 runtime is built from commit [3393ae0f](https://github.com/lyc-aon/oh-my-pi/commit/3393ae0f7fc5b2ea9919d8bdb3a2d5719b1cbc2f) and tagged [t4code-17.0.5-appserver-3](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.5-appserver-3). It provides the stable appserver base used by the desktop and remote workflows, including faster startup, cross-session attention, and cross-session transcript search. Newer optional capabilities remain hidden when the host does not advertise them.

The integration is based on the official upstream [v17.0.5 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.5), commit [9fd6e971](https://github.com/can1357/oh-my-pi/commit/9fd6e97113f5ed3a847e66d346970efdf8afcad9). Official upstream OMP v17.0.5 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon and are signed and notarized. Verify downloads with `SHA256SUMS.txt`.
