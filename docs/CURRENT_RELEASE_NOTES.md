## Runtime release-gate hardening

T4 Code v0.1.16 keeps the tool-aware transcript views and child-agent behavior shipped in v0.1.15. Patch operations, task lists, child-agent work, file reads, shell commands, searches, and fetched sources show their useful arguments and structured results without exposing raw event payloads.

The Agents pane follows child-agent transcript events as they arrive and hydrates durable transcript records when opened. Child messages, tools, and images use the same rendering path as the main transcript. Subagent RPC reads have byte and record ceilings, so long-running agents remain responsive without unbounded transcript fetches.

The runtime preserves sanitized structured tool-result details while omitting embedded image bytes from those details. Authorized image digests from child transcripts remain available through the established session image-read path.

## Runtime compatibility

T4 Code v0.1.16 vendors app-wire 0.5.5 from integration commit [6a87fa64](https://github.com/lyc-aon/oh-my-pi/commit/6a87fa6407ebff20417b4d52885a6bb3091003ea), source tree `a2495fe8781c979184fe7fb9a6d37d8f33bad30f`. Image prompts activate only when the host advertises the additive image capability; the compatibility handshake keeps older appservers available.

The matching OMP 16.5.2 runtime is built from [264958b2](https://github.com/lyc-aon/oh-my-pi/commit/264958b23acac16baaf3bf0024129dc1a57f9d14) and tagged [t4code-16.5.2-appserver-4](https://github.com/lyc-aon/oh-my-pi/tree/t4code-16.5.2-appserver-4). The semantic runtime feature remains the appserver-2 implementation: bounded child-agent transcript streaming, structured tool-result details, bounded subagent reads, and verified child-transcript image reads. Appserver-4 fixes the clean-source TypeScript/build check and permanently adds the appserver type check plus full runtime tests to the gates that must pass before OMP release binaries publish.

The integration is based on the official upstream [v16.5.2 tag](https://github.com/can1357/oh-my-pi/tree/v16.5.2), commit [7d02778c](https://github.com/can1357/oh-my-pi/commit/7d02778c60f4b5db60f84bedbca79d6e64cb91f5). Official upstream OMP v16.5.2 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
