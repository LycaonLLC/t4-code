## Prompt delivery

Host command errors reach the composer with their code, message, and redacted details. The draft remains in place so you can act on the specific reason.

When the host cannot confirm whether a prompt ran, T4 Code asks you to check the transcript before retrying. The retained draft stays ready after that check.

## Session recovery

Every current session has a **Terminate runtime** action in its menu. After a separate confirmation, T4 Code asks OMP to close the worker, refreshes the authoritative session list, and waits for the session to report closed and idle. Archive and permanent delete can then proceed.

## Runtime compatibility

T4 Code v0.1.10 uses app-wire 0.5.3 from integration commit [1ada5fc2](https://github.com/lyc-aon/oh-my-pi/commit/1ada5fc2f0d6f9026d373cd25e004b974437651e), source tree `4961ea9c522a3bbf9a9900424dd475a48148c729`. The matching OMP 16.5.0 runtime is tagged [t4code-16.5.0-appserver-4](https://github.com/lyc-aon/oh-my-pi/tree/t4code-16.5.0-appserver-4). It keeps terminal events inside protocol limits, reaps a session worker after a reader failure, makes crash-only sessions restartable after the failed child exits, and clears pending work during an explicit close.

The integration remains based on the official upstream [v16.5.0 tag](https://github.com/can1357/oh-my-pi/tree/v16.5.0), commit [3047c27c](https://github.com/can1357/oh-my-pi/commit/3047c27c332c5629c8e063283d349384c10c9a56). Official upstream OMP v16.5.0 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
