## Empty working-folder cleanup

T4 Code v0.1.17 adds **Remove shortcut** to the menu for a working folder with no current sessions. The action hides that row in the current T4 Code client. It does not delete the folder, archived transcripts, or any other OMP data.

The preference persists across restarts. Archived sessions remain available, and their folder menu provides **Show shortcut**. Creating or restoring a current session also makes the folder visible again. Other T4 Code clients keep their own shortcut preferences.

The removal action stays disabled until the host has supplied a complete session inventory. Keyboard focus moves to the next useful rail control after removal, and the menu keeps a 44-pixel touch target on narrow screens.

## Runtime compatibility

T4 Code v0.1.17 vendors app-wire 0.5.5 from integration commit [6a87fa64](https://github.com/lyc-aon/oh-my-pi/commit/6a87fa6407ebff20417b4d52885a6bb3091003ea), source tree `a2495fe8781c979184fe7fb9a6d37d8f33bad30f`. Image prompts activate only when the host advertises the additive image capability; the compatibility handshake keeps older appservers available.

The matching OMP 16.5.2 runtime is built from [264958b2](https://github.com/lyc-aon/oh-my-pi/commit/264958b23acac16baaf3bf0024129dc1a57f9d14) and tagged [t4code-16.5.2-appserver-4](https://github.com/lyc-aon/oh-my-pi/tree/t4code-16.5.2-appserver-4). The semantic runtime feature remains the appserver-2 implementation: bounded child-agent transcript streaming, structured tool-result details, bounded subagent reads, and verified child-transcript image reads. Appserver-4 fixes the clean-source TypeScript/build check and permanently adds the appserver type check plus full runtime tests to the gates that must pass before OMP release binaries publish.

The integration is based on the official upstream [v16.5.2 tag](https://github.com/can1357/oh-my-pi/tree/v16.5.2), commit [7d02778c](https://github.com/can1357/oh-my-pi/commit/7d02778c60f4b5db60f84bedbca79d6e64cb91f5). Official upstream OMP v16.5.2 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
