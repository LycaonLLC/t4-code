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

T4 Code v0.1.24 vendors app-wire 0.6.0 from integration commit [ae4b53b4](https://github.com/lyc-aon/oh-my-pi/commit/ae4b53b416f32b200865a32ed9baabd5a4666fa4), source tree `2b8a5f697273f5044789b8ae638b6c264f9f8499`. The client contract remains `omp-app/1`.

The verified OMP 17.0.4 runtime is built from commit [d57dcd85](https://github.com/lyc-aon/oh-my-pi/commit/d57dcd855006c673d8d530237d474fe5ba5645c4) and tagged [t4code-17.0.4-appserver-5](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.4-appserver-5). It provides the stable appserver base used by the desktop and remote workflows. Newer optional capabilities remain hidden when the host does not advertise them.

The integration is based on the official upstream [v17.0.4 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.4), commit [3fdd85ab](https://github.com/can1357/oh-my-pi/commit/3fdd85ab6c6bab6c0cdee80abbbec0981740a5c0). Official upstream OMP v17.0.4 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon and are signed and notarized. Verify downloads with `SHA256SUMS.txt`.
