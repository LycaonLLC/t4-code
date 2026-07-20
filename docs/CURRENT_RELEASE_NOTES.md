## A session rail built for large libraries

T4 Code v0.1.29 makes a large session library easier to navigate. The rail now supports text search, activity filters, newest/oldest sorting, grouped and flat layouts, collapsible project folders, and saved display preferences. Those controls follow the Codex desktop organization model while keeping OMP as the source of truth.

Project menus can create a session in that folder, reveal the folder in the system file manager, collapse the group, or hide it from the rail. Hidden projects are not deleted and can be restored from the filter menu. The reveal action is deliberately narrow: the host accepts only project paths already present in its session catalog.

## Workspace polish and stable empty panes

The workspace shell, transcript, home pane, composer, and supporting panes now share a clearer and denser visual hierarchy. Empty activity, agent, file, review, and terminal panes keep their normal header and close control visible, so an empty result never traps the user in a pane without navigation.

## More reliable macOS upgrades

When a bundled OMP upgrade temporarily fails to stop the existing macOS service, T4 Code now retries the stop-and-replace sequence. This avoids leaving the installed backend half-updated during normal desktop upgrades while preserving the existing signed-runtime checks.

## Native Browser workspace

The desktop app now includes a built-in Browser workspace that is distinct from the existing host-backed Browser Preview workspace. Its tabs expose stable native surface state for navigation and rendering. New tabs use the credential-isolated `isolated-session` profile. Authenticated profiles are never selected automatically: each use requires the exact user-selected profile with explicit opt-in.

Native Browser automation is bounded to its surface contract. Touch input is currently unsupported and returns a capability error. The desktop closes native Browser surfaces and releases their supporting controllers when the renderer reloads, the window closes, or the app stops.

## Host Browser Preview workspace

Session-linked Host Browser Previews continue to open in their dedicated workspace. The client projects bounded, sanitized preview state from the host, maps pointer and keyboard input through explicit permission gates, and uses leases so two clients cannot silently control the same preview at once. Preview activity records origins and paths without storing query strings, page pixels, credentials, or backend error text.

## Runtime provenance

T4 Code v0.1.29 vendors app-wire 0.6.2 from integration commit [04229b1f](https://github.com/lyc-aon/oh-my-pi/commit/04229b1f46547ac7c0617e55a993496ec9725f46), source tree `8400a3af618e8af11cccf6b20aadcf3a22baf9a1`. The client contract remains `omp-app/1`.

The verified OMP 17.0.5 runtime is built from commit [04229b1f](https://github.com/lyc-aon/oh-my-pi/commit/04229b1f46547ac7c0617e55a993496ec9725f46) and tagged [t4code-17.0.5-appserver-7](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.5-appserver-7). It adds privacy-safe local project reveal to the existing appserver capabilities, including lazy session indexing, cross-session attention and transcript search, and the negotiated browser-preview command surface. Unsupported optional capabilities remain hidden when the host does not advertise them.

The integration is based on the official upstream [v17.0.5 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.5), commit [9fd6e971](https://github.com/can1357/oh-my-pi/commit/9fd6e97113f5ed3a847e66d346970efdf8afcad9). Official upstream OMP v17.0.5 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon and are signed and notarized. Verify downloads with `SHA256SUMS.txt`.
