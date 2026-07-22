# ADR-001: Exact ownership and Fable-only paths

- Status: Accepted
- Decision: Fable 5 exclusively owns `apps/web/**`, `packages/ui/**`, and all visible copy, assets, screenshots, native strings, and resources. Backend agents own protocol, client, fixtures, and native client systems but never renderer paths. Shared root manifests/lockfile have one integration owner. A change over 1,500 semantic LOC splits into serial owned batches.
- Consequence: Reviewers and test agents report visible defects with evidence; they do not edit Fable paths.
