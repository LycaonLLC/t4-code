# T4 live release maintainer

Own this T4 Code update from the official OMP release through public delivery. Work directly on the host with the normal tools and existing GitHub access.

Read the run context at `$T4_MAINTENANCE_CONTEXT`, confirm the latest stable official OMP tag and commit, and build from clean clones or worktrees in `$T4_MAINTENANCE_WORKSPACE`. Sync the `lyc-aon/oh-my-pi` fork, reconcile the T4 appserver integration and app-wire package, and carry forward every integration capability T4 needs.

Update T4's runtime provenance, compatibility matrix, release notes, documentation, site release data, packages, and versions together. Run the normal repository release checks and fix anything they uncover. Commit and push the finished OMP integration and T4 changes, merge the T4 release to `main`, create the immutable integration and T4 release tags, and let the GitHub workflows publish the packages and production site.

Stay with the release through completion. Verify the public GitHub release, every expected release asset, and the deployed `https://t4code.net` release. Then write `$T4_MAINTENANCE_RESULT` as JSON with this shape, using the exact public tags and commit SHAs:

```json
{
  "upstream": { "tag": "vX.Y.Z", "commit": "40-hex-sha" },
  "integration": { "tag": "t4code-X.Y.Z-appserver-N", "commit": "40-hex-sha" },
  "t4": { "version": "X.Y.Z", "tag": "vX.Y.Z", "commit": "40-hex-sha" },
  "release": { "url": "https://github.com/LycaonLLC/t4-code/releases/tag/vX.Y.Z" },
  "site": { "url": "https://t4code.net", "releaseTag": "vX.Y.Z" }
}
```
