## OMP 16.5.1 compatibility

T4 Code v0.1.11 adopts the official OMP 16.5.1 release. The host runtime now includes upstream fixes for interrupted session turns, organization-scoped Anthropic accounts, credential rotation, subagent model selection, bounded transcript retention, and RPC disconnect cleanup.

## Desktop runtime

The merged RPC shutdown path rejects pending extension UI, host tool, and host URI requests before it drains accepted work. T4's session teardown then releases the persistent session lock and flushes the postmortem before the worker exits. This sequence prevents a dead client from leaving queued work or a stale session lock.

## Runtime compatibility

T4 Code v0.1.11 vendors app-wire 0.5.4 from integration commit [0688257b](https://github.com/lyc-aon/oh-my-pi/commit/0688257b283dab19894911cda8c1e6d2b2319f20), source tree `87cfd36bcefe71a036dd547119e1e6129bb9be9c`. The client remains backwards compatible with the verified OMP 16.5.1 runtime at [15527d1f](https://github.com/lyc-aon/oh-my-pi/commit/15527d1f00bac22705f63f80b29c0c30e67fc5da); image prompts activate only when a host advertises the additive 0.5.4 capability.

The matching OMP 16.5.1 runtime is tagged [t4code-16.5.1-appserver-1](https://github.com/lyc-aon/oh-my-pi/tree/t4code-16.5.1-appserver-1). It carries forward bounded replay and terminal events, complete session projection, catalog-backed lifecycle controls, ordered remote delivery, failed-worker reaping, recoverable crash state, settled close state, cross-client convergence, and restart-safe RPC teardown.

The integration is based on the official upstream [v16.5.1 tag](https://github.com/can1357/oh-my-pi/tree/v16.5.1), commit [14b5da76](https://github.com/can1357/oh-my-pi/commit/14b5da76a9aece9a469288718d22c3d624daf033). Official upstream OMP v16.5.1 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
