## Follow a terminal session

Sessions running as a plain `omp` TUI on the host now appear in T4 Code v0.1.22, marked **Active elsewhere**. While the TUI owns the session, T4 follows its durable transcript: complete records, including saved images, appear as they land on disk. Every write control is disabled with the reason instead of failing later.

![An OMP TUI session followed in T4 Code: the transcript fills in read-only under an "Active in another app" banner, /continue-in-t4 runs in the terminal, T4 takes over, and the composer accepts input again.](https://raw.githubusercontent.com/LycaonLLC/t4-code/v0.1.22/docs/assets/t4-code-tui-handoff.gif)

Ownership copy never guesses:

- A confirmed live lock is the only state called **Active in another app**.
- A lock that has gone quiet reads as **Waiting to take over**; T4 promotes on its own once the session settles.
- A malformed or unrecognized lock keeps the session read-only as "ownership unclear". T4 never names an owner it cannot confirm.

While another app owns the session, stopping the turn and session management stay with that app; T4 says so on each disabled control. If following is not available yet, T4 shows the last saved copy and catches up on its own.

## Continue in T4

Run `/continue-in-t4` in the OMP TUI, or just exit it. The TUI tears down normally, and T4 takes over in two confirmed steps:

1. The host reports the session lock gone. A writable takeover happens only when the lock is freshly missing; a live owner is never displaced.
2. T4 reconciles the complete transcript, line by line, against what the host has on disk.

Input returns only after both steps pass. Nothing is typed into a session another app still owns, and no transcript line is lost in the handoff.

## Reconnect that does not give up

Retryable transport failures now stay in the reconnect loop indefinitely, with backoff capped at 10 seconds. A network drop, a laptop sleep, or a host restart ends in a reconnected session instead of a dead one. Anything the host did not confirm stays marked unconfirmed the whole time.

## Mobile rail fix

On narrow screens, live output from the session you are already reading no longer closes the session rail you just reopened. Opening a different session still closes the rail, as before.

## Runtime provenance

T4 Code v0.1.22 vendors app-wire 0.5.8 from integration commit [33615123](https://github.com/lyc-aon/oh-my-pi/commit/33615123ff986fc9cadf645463b4fed17e8b9f35), source tree `e36475dc81dd4c3703eb207ae466f85947b33525`. The client contract remains `omp-app/1`.

The matching OMP 17.0.0 runtime is built from commit [f909a289](https://github.com/lyc-aon/oh-my-pi/commit/f909a2895bc1a352d1d3c27c45d59622bc1c0a36) and tagged [t4code-17.0.0-appserver-6](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.0-appserver-6). This revision adds lock-aware external session observation, complete line-by-line transcript reconciliation, missing-lock-only session promotion, the cooperative `/continue-in-t4` TUI handoff, and deterministic session file ordering. Terminal-session following requires this runtime; older appserver builds keep working without it. Fork CI requires the release commit to descend from the exact official base.

The integration is based on the official upstream [v17.0.0 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.0), commit [d5cd24f3](https://github.com/can1357/oh-my-pi/commit/d5cd24f39a951bfbd50dc8f50bcf095d59694d6c). Official upstream OMP v17.0.0 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
