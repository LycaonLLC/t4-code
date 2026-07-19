## Signed Mac backend startup

T4 Code v0.1.27 completes the signed Mac backend fix. Packaging now waits for the Promise-based signer to finish before notarization begins. The signed, bundled OMP backend can load OMP's native module, with that permission applied only to the OMP executable inside the app. The top-level T4 Code app and its Electron helpers keep normal library validation enabled.

The v0.1.26 tag did not publish release files: its Mac job stopped when notarization detected that the legacy callback signer had returned before signing finished. No partial v0.1.26 GitHub Release was published.

The protected release job verifies this boundary in both the DMG and ZIP before publication. It also checks the original OMP download's pinned size and SHA-256 hash, the project's exact Developer ID certificate and Team ID, hardened runtime, secure timestamp, stapled notarization ticket, and Gatekeeper result. Signing secrets are never bundled into the app.

The v0.1.25 signed-backend integrity fix remains in place: the app accepts either the exact original OMP download or an executable signed with the project's pinned Developer ID certificate, then copies and rechecks the actual signed bytes atomically.

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

T4 Code v0.1.27 vendors app-wire 0.6.1 from integration commit [e3e15c03](https://github.com/lyc-aon/oh-my-pi/commit/e3e15c03ae95ebbda5f26495cd21213cc53518b1), source tree `e0f32b279eb4b8cbc403e47d765a226bee99c99f`. The client contract remains `omp-app/1`.

The verified OMP 17.0.5 runtime is built from commit [772e5e41](https://github.com/lyc-aon/oh-my-pi/commit/772e5e41eb1537177349247add96a851721c5bfa) and tagged [t4code-17.0.5-appserver-5](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.5-appserver-5). It provides the appserver used by the desktop and remote workflows, including faster startup, cross-session attention and transcript search, and the complete negotiated browser-preview command surface. Unsupported optional capabilities remain hidden when the host does not advertise them.

The integration is based on the official upstream [v17.0.5 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.5), commit [9fd6e971](https://github.com/can1357/oh-my-pi/commit/9fd6e97113f5ed3a847e66d346970efdf8afcad9). Official upstream OMP v17.0.5 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon and are signed and notarized. Verify downloads with `SHA256SUMS.txt`.
