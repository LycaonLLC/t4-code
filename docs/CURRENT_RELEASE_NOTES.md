## Tool-aware transcripts and child agents

T4 Code v0.1.15 gives known tools dedicated transcript views. Patch operations, task lists, child-agent work, file reads, shell commands, searches, and fetched sources show their useful arguments and structured results without exposing raw event payloads.

The Agents pane follows child-agent transcript events as they arrive and hydrates durable transcript records when opened. Child messages, tools, and images use the same rendering path as the main transcript. Subagent RPC reads have byte and record ceilings, so long-running agents remain responsive without unbounded transcript fetches.

The runtime preserves sanitized structured tool-result details while omitting embedded image bytes from those details. Authorized image digests from child transcripts remain available through the established session image-read path.

## Runtime compatibility

T4 Code v0.1.15 vendors app-wire 0.5.5 from integration commit [6a87fa64](https://github.com/lyc-aon/oh-my-pi/commit/6a87fa6407ebff20417b4d52885a6bb3091003ea), source tree `a2495fe8781c979184fe7fb9a6d37d8f33bad30f`. Image prompts activate only when the host advertises the additive image capability; the compatibility handshake keeps older appservers available.

The matching OMP 16.5.2 runtime is built from [f9322817](https://github.com/lyc-aon/oh-my-pi/commit/f9322817981e16bf3f1e3d77684f4269f026aa64) and tagged [t4code-16.5.2-appserver-2](https://github.com/lyc-aon/oh-my-pi/tree/t4code-16.5.2-appserver-2). It carries forward T4's appserver, lifecycle, image, session-control, and atomic maintenance integration, then adds bounded child-agent transcript streaming and structured tool-result details.

The integration is based on the official upstream [v16.5.2 tag](https://github.com/can1357/oh-my-pi/tree/v16.5.2), commit [7d02778c](https://github.com/can1357/oh-my-pi/commit/7d02778c60f4b5db60f84bedbca79d6e64cb91f5). Official upstream OMP v16.5.2 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
