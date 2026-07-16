## Session profile chooser

T4 Code v0.1.21 makes profile ownership explicit when you create a session. The visible **New** action becomes **New ▾** when several local OMP profile targets are configured. Its chooser lists the current and other connected profiles, configured profiles that are offline as **Not connected**, and an **Open Hosts** shortcut to start them. The profile you pick owns the session; with one eligible target, **New** creates directly there. Nothing switches silently.

## Android saved hosts

The Android app now manages saved hosts instead of remembering a single address. It keeps up to 16 saved Tailnet gateway addresses, stored as plain HTTPS origins with no secrets inside. Switch, add, and remove are separate actions.

Adding a host probes the address first and saves only on success. Back or Escape cancels a probe in flight, and a probe that finishes after you cancel cannot save. Removing a host deletes exactly that entry and rolls back its metadata; pairing credentials stay scoped to each host in the Android Keystore, so removing one host never touches another's credentials. Existing installs migrate their saved address into the list automatically.

Each saved host is one remote appserver serving one OMP profile. Android does not list multiple profiles behind a single saved address; running several profiles side by side remains a desktop feature, one local appserver per profile.

## Runtime provenance

T4 Code v0.1.21 vendors app-wire 0.5.7 from integration commit [ee1b794f](https://github.com/lyc-aon/oh-my-pi/commit/ee1b794f1d0638b3d6797c5220e5eafe69d693db), source tree `421e29e6ed9203113345906e2d24c042949d0f61`. The client contract remains `omp-app/1`.

The matching OMP 17.0.0 runtime is built from the same commit [ee1b794f](https://github.com/lyc-aon/oh-my-pi/commit/ee1b794f1d0638b3d6797c5220e5eafe69d693db) and tagged [t4code-17.0.0-appserver-4](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.0-appserver-4). This revision scopes each appserver to its OMP profile, adds host-scoped usage and broker-status commands, reports semantic thinking and fast state, and bounds project catalog resolution. Fork CI requires the release commit to descend from the exact official base.

The integration is based on the official upstream [v17.0.0 tag](https://github.com/can1357/oh-my-pi/tree/v17.0.0), commit [d5cd24f3](https://github.com/can1357/oh-my-pi/commit/d5cd24f39a951bfbd50dc8f50bcf095d59694d6c). Official upstream OMP v17.0.0 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
