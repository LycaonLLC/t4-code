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

Stage 3 transcript and composer parity is complete locally. Durable and live transcript events now
render Markdown, reasoning, tool progress/results, streaming state, and integrity-checked images.
The composer preserves a separate draft and attachment set per session, uploads bounded images
through the chunked app-wire protocol, exposes catalog-backed slash and model choices, applies
thinking and fast-mode controls, and supports steering, queued follow-ups, and confirmed turn
cancellation. Focused protocol, controller, and compact/wide widget coverage passes alongside the
Web release build and fixture-connected macOS, iOS Simulator, and Android emulator smokes.

Stage 3 decisions and attention parity is complete locally. The shared inbox groups approvals,
questions, plans, security confirmations, failures, completions, and background-agent progress.
Actions remain bound to the host session revision, acquire a negotiated prompt lease before
dispatch, and reject replaced or expired requests. The full Flutter suite, Web release build,
compact widget coverage, and an interactive compact-browser decision smoke pass.

Stage 3 developer surfaces are complete locally. A shared developer workspace exposes redacted
activity with filters and pause/copy controls, file browsing and source inspection, selected-file
diff review, and protocol-backed PTY tabs with bounded scrollback, resize/input forwarding, exit
state, and guarded paste. Preview navigation stays host-authoritative: Flutter renders only
integrity-checked capture bytes and never executes page HTML or JavaScript. Focused controller and
compact widget coverage, the full Flutter suite, and fixture-connected Web, iOS Simulator, and
Android emulator smokes exercise the new path.

## A session rail built for large libraries

T4 Code v0.1.30 makes a large session library easier to navigate. The rail now supports text search, activity filters, newest/oldest sorting, grouped and flat layouts, collapsible project folders, and saved display preferences. Those controls follow the Codex desktop organization model while keeping OMP as the source of truth.

Project menus can create a session in that folder, reveal the folder in the system file manager, collapse the group, or hide it from the rail. Hidden projects are not deleted and can be restored from the filter menu. The reveal action is deliberately narrow: the host accepts only project paths already present in its session catalog.

## Workspace polish and stable empty panes

The workspace shell, transcript, home pane, composer, and supporting panes now share a clearer and denser visual hierarchy. Empty activity, agent, file, review, and terminal panes keep their normal header and close control visible, so an empty result never traps the user in a pane without navigation.

## More reliable macOS upgrades

When a bundled OMP upgrade temporarily fails to stop the existing macOS service, T4 Code now retries the stop-and-replace sequence. This avoids leaving the installed backend half-updated during normal desktop upgrades while preserving the existing signed-runtime checks.

The bundled backend now also recovers from an inactive Unix socket when the crashed owner's process ID still appears alive. It confirms the endpoint is unreachable more than once and revalidates every ownership file before reclaiming it, while leaving a responsive backend untouched.

## Native Browser workspace

The desktop app now includes a built-in Browser workspace that is distinct from the existing host-backed Browser Preview workspace. Its tabs expose stable native surface state for navigation and rendering. New tabs use the credential-isolated `isolated-session` profile. Authenticated profiles are never selected automatically: each use requires the exact user-selected profile with explicit opt-in.

Native Browser automation is bounded to its surface contract. Touch input is currently unsupported and returns a capability error. The desktop closes native Browser surfaces and releases their supporting controllers when the renderer reloads, the window closes, or the app stops.

## Host Browser Preview workspace

Session-linked Host Browser Previews continue to open in their dedicated workspace. The client projects bounded, sanitized preview state from the host, maps pointer and keyboard input through explicit permission gates, and uses leases so two clients cannot silently control the same preview at once. Preview activity records origins and paths without storing query strings, page pixels, credentials, or backend error text.

## Runtime provenance

T4 Code v0.1.30 vendors app-wire 0.6.2 from integration commit [04229b1f](https://github.com/lyc-aon/oh-my-pi/commit/04229b1f46547ac7c0617e55a993496ec9725f46), source tree `8400a3af618e8af11cccf6b20aadcf3a22baf9a1`. The client contract remains `omp-app/1`.

The verified OMP 17.0.5 runtime is built from commit [09835b92](https://github.com/lyc-aon/oh-my-pi/commit/09835b929cd028e7e3f800b3e4203e3d1f37931c) and tagged [t4code-17.0.5-appserver-8](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.5-appserver-8). It adds stale-owner recovery to the existing appserver capabilities, including privacy-safe local project reveal, lazy session indexing, cross-session attention and transcript search, and the negotiated browser-preview command surface. Unsupported optional capabilities remain hidden when the host does not advertise them.

The integration is based on the official upstream [v17.0.5 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.5), commit [9fd6e971](https://github.com/can1357/oh-my-pi/commit/9fd6e97113f5ed3a847e66d346970efdf8afcad9). Official upstream OMP v17.0.5 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon and are signed and notarized. Verify downloads with `SHA256SUMS.txt`.
