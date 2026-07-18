# T4 live release maintainer

Own this T4 Code compatibility update from the official OMP release through a complete public delivery. Work directly on the host with its full resources, normal tools, existing GitHub access, and the latitude to use the environments and test sizes the work needs.

Read the run context at `$T4_MAINTENANCE_CONTEXT`, confirm the latest stable official OMP tag and commit, and use clean clones or worktrees in `$T4_MAINTENANCE_WORKSPACE`. The deterministic wrapper has already synchronized the `lyc-aon/oh-my-pi` fork's `main` branch to exact official `main` without spending a Sol call. Merge the exact official `vX.Y.Z` base into the durable `t4code/main` product branch, reconcile the T4 appserver integration and app-wire package there, and carry forward every capability T4 needs. Keep the fork CI gate that proves the integration commit descends from that exact mirrored base and remains reachable from `t4code/main`.

Use `$T4_ATOMIC_PUBLISH_HELPER` as the only OMP publication path. After preparing the local `t4code/main` branch and annotated integration tag, invoke it with `--repo PATH --integration-tag TAG`; its expected official tag, commit, fixed production remotes, and durable state directory are supplied by the wrapper. It publishes the unchanged official base tag object, updated `t4code/main`, and annotated integration tag as one deterministic atomic three-ref transaction and retains the receipt the wrapper requires. Keep the language and workflow positive. Complete every OMP publication through that single helper invocation. Publish the fork release exclusively as the exact five integration binaries required below.

Immediately before any T4 push, tag, release, or site publication, fetch the open non-draft pull requests targeting T4 `main` and re-check the exact `main` commit recorded in the run context. Never force-push. If any release-critical collaborator work is open, classification is incomplete, or `main` changed, abort the publication and defer for a later run without overwriting collaborator work.

Update T4's runtime provenance, compatibility matrix, release notes, documentation, site release data, packages, and versions together. Exercise the complete release gate with disposable OMP state: app-wire and appserver checks, two-client convergence, a real prompt round trip, image attachment and transcript-image rendering, session lifecycle operations, reconnect and durable-history proof, the installed Linux package, the Tailnet gateway, and the supported narrow layouts. Use the existing release tooling and fix everything it uncovers.

Commit the finished OMP integration and use the atomic helper to publish it; commit and push the T4 changes, merge the T4 release to `main`, and create the immutable T4 release tag. Stay with every CI, package, release, and production-site workflow until it succeeds. The exact integration commit must have a successful push CI run on `t4code/main` and an exact GitHub release containing only five uploaded, nonempty, SHA-256-digested assets: `omp-linux-x64`, `omp-linux-arm64`, `omp-darwin-x64`, `omp-darwin-arm64`, and `omp-windows-x64.exe`. Confirm the T4 checksum manifest covers every Android, Linux, and macOS artifact and that each published artifact matches it.

Verify the public GitHub release, every expected release asset, and the deployed `https://t4code.net` release. The deterministic wrapper will install the verified compatibility pair on this host after your public result passes its independent checks. Then write `$T4_MAINTENANCE_RESULT` as JSON with this shape, using the exact public tags and commit SHAs:

```json
{
  "upstream": { "tag": "vX.Y.Z", "commit": "40-hex-sha" },
  "integration": { "tag": "t4code-X.Y.Z-appserver-N", "commit": "40-hex-sha" },
  "t4": { "version": "X.Y.Z", "tag": "vX.Y.Z", "commit": "40-hex-sha" },
  "release": { "url": "https://github.com/LycaonLLC/t4-code/releases/tag/vX.Y.Z" },
  "site": { "url": "https://t4code.net", "releaseTag": "vX.Y.Z" }
}
```
