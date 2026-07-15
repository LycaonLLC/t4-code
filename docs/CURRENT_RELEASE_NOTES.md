## Verified maintenance and local cutovers

T4 Code v0.1.14 includes the Linux host maintainer used for this compatibility pair. It mirrors official OMP `main` without a model call, publishes the product branch and tags as one atomic ref transaction, and independently verifies the workflows, release assets, checksums, and deployed site before a local install becomes eligible.

Local deployment starts only when T4 is closed and the running appserver reports no active work. OMP's identity-bound `drain-if-idle` command checks the current host and epoch together with every tracked activity counter. A busy or changed runtime defers the update. Gateway ingress is the final exposure step. The deployment is accepted only after the installed OMP binary, T4 package, web runtime, loopback health, and exact deployment identity pass verification.

Android release CI now checks the universal APK's package name, version, SDK bounds, split metadata, and production signing certificate before publishing it.

## Runtime compatibility

T4 Code v0.1.14 vendors app-wire 0.5.5 from integration commit [6a87fa64](https://github.com/lyc-aon/oh-my-pi/commit/6a87fa6407ebff20417b4d52885a6bb3091003ea), source tree `a2495fe8781c979184fe7fb9a6d37d8f33bad30f`. Image prompts activate only when the host advertises the additive image capability; the compatibility handshake keeps older appservers available.

The matching OMP 16.5.2 runtime is built from [d7c9ac81](https://github.com/lyc-aon/oh-my-pi/commit/d7c9ac81a3764085d050d0b7148ac7eee976ddd3) and tagged [t4code-16.5.2-appserver-1](https://github.com/lyc-aon/oh-my-pi/tree/t4code-16.5.2-appserver-1). It carries forward T4's appserver, lifecycle, image, and session-control integration and adds the identity-bound atomic maintenance drain used by the local deployer.

The integration is based on the official upstream [v16.5.2 tag](https://github.com/can1357/oh-my-pi/tree/v16.5.2), commit [7d02778c](https://github.com/can1357/oh-my-pi/commit/7d02778c60f4b5db60f84bedbca79d6e64cb91f5). Official upstream OMP v16.5.2 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
