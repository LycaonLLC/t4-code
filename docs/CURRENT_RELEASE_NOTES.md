## Prompt and session truth

T4 Code v0.1.19 shows a user prompt as soon as OMP accepts it. That pending message is replayed after reconnects and snapshots, remains visible while context compacts, and retires only when the host settles or discards its exact entry. Steering and queued follow-ups use the same ordered lifecycle.

The sidebar and transcript now reconcile against a complete current session inventory. Stale Working and Compacting labels clear only from newer host evidence; cached or incomplete inventories stay read-only and cannot erase a live turn. Context compaction has its own visible activity state, and recovery uses one catch-up indicator instead of duplicate warnings.

## Transcript fidelity and bounds

Known OMP tool calls, plans, todos, collaboration exchanges, and child-agent messages render as semantic rows. Child-agent transcripts and durable transcript images can be opened from the session. Image prompts are chunked and capability-gated rather than embedded in terminal frames.

Transcript entries, live messages, tool values, terminal output, child-agent history, image caches, and the on-disk projection cache all have explicit retention limits. Large command output is clipped in the client instead of remaining in the React tree indefinitely.

## Updates and release authority

Desktop and Android builds now expose a user-initiated update check. Each downloaded package is matched to the published release manifest, the package's SHA-256 digest, and the expected package identity before installation. T4 does not force client updates.

CI runs core, tooling, and Android gates in parallel behind one required `verify` result. A release publishes only after a successful main-branch CI run for the exact tagged commit; later pushes cannot cancel that authority run.

## Runtime provenance

T4 Code v0.1.19 vendors app-wire 0.5.5 from integration commit [6a87fa64](https://github.com/lyc-aon/oh-my-pi/commit/6a87fa6407ebff20417b4d52885a6bb3091003ea), source tree `a2495fe8781c979184fe7fb9a6d37d8f33bad30f`. The client contract remains `omp-app/1`.

The matching OMP 17.0.0 runtime is built from [3cba4bda](https://github.com/lyc-aon/oh-my-pi/commit/3cba4bda41d2b8e4d304c43471735657893d3b62) and tagged [t4code-17.0.0-appserver-2](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.0-appserver-2). This revision adds accepted-prompt lifecycle replay, preserves custom message metadata, normalizes xdev tool envelopes, and reuses trusted native CI artifacts. Fork CI requires the release commit to descend from the exact official base.

The integration is based on the official upstream [v17.0.0 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.0), commit [d5cd24f3](https://github.com/can1357/oh-my-pi/commit/d5cd24f39a951bfbd50dc8f50bcf095d59694d6c). Official upstream OMP v17.0.0 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
