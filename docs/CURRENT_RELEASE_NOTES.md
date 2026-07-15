## OMP 17 compatibility

T4 Code v0.1.18 moves the verified runtime to OMP 17.0.0 without changing the `omp-app/1` client contract. Existing T4 clients keep the same app-wire frames and capability negotiation.

The public integration preserves bounded replay for growing sessions, structured tool-result details, child-agent transcript and image projection, session lifecycle controls, two-client convergence, reconnect-safe history, and atomic maintenance drain.

## Runtime provenance

T4 Code v0.1.18 vendors app-wire 0.5.5 from integration commit [6a87fa64](https://github.com/lyc-aon/oh-my-pi/commit/6a87fa6407ebff20417b4d52885a6bb3091003ea), source tree `a2495fe8781c979184fe7fb9a6d37d8f33bad30f`. Image prompts activate only when the host advertises the additive image capability.

The matching OMP 17.0.0 runtime is built from [6e2f2350](https://github.com/lyc-aon/oh-my-pi/commit/6e2f2350cfe9e6f5db691c311333cae33cdb62ba) and tagged [t4code-17.0.0-appserver-1](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.0-appserver-1). Fork CI requires the release commit to descend from the exact official base before it publishes integration binaries.

The integration is based on the official upstream [v17.0.0 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.0), commit [d5cd24f3](https://github.com/can1357/oh-my-pi/commit/d5cd24f39a951bfbd50dc8f50bcf095d59694d6c). Official upstream OMP v17.0.0 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
