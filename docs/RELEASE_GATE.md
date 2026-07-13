# T4 Code release gate

T4 Code is a client for a separate runtime. A green UI fixture suite proves that the renderer understands its fixtures; it does not prove that a released desktop build can discover OMP, load real history, survive a reconnect, or work through the Tailnet gateway.

Every release must pass the layers below. Destructive lifecycle checks use a disposable OMP profile and disposable session root. They never run against a person's normal sessions.

## Required automated checks

1. Protocol distribution
   - Decode every golden app-wire fixture from the vendored package.
   - Reject stale or locally reimplemented command shapes.
   - Verify the vendored tarball, source tree, fixture corpus, and recorded hashes.
2. OMP runtime packages
   - Run app-wire, appserver, and coding-agent type checks and focused tests.
   - Cover cursor-domain separation, ordered delivery, bounded replay, lifecycle revision conflicts, busy-session refusal, operation and terminal drain, path containment, deletion recovery, and external discovery deltas.
3. T4 workspaces
   - Run lint, type checks, unit/integration suites, production builds, packaging/tooling checks, and Playwright.
   - Exercise a complete inventory, a truncated inventory, reconnects, authoritative empty state, stale routes, and two clients observing the same session changes.
4. Touch layouts
   - Use real CDP touch input at 320 pixels for model-list drag scrolling and selection. Check Send and session-management control reachability at 320, 360, and 390 pixels, including a short 390 x 500 viewport.
   - Open and close the session rail, create a session, reach the Send control, drag-scroll the model list, and select its last available model.

## Required release-operator proof

1. Start a freshly built OMP appserver with isolated config, state, socket, and session directories.
2. Connect two independent T4 clients. Create a disposable session and confirm both clients receive it.
3. Send a prompt, wait for the durable transcript, reconnect both clients, and confirm the history appears once in the same order.
4. Rename, archive, restore, and permanently delete the disposable session. Confirm both clients converge after every change and that archived sessions reject writes.
5. Build and install the Linux desktop package. Launch the installed executable, not a development Electron process, and confirm the expected appserver service, socket, host identity, session list, transcript, and composer state.
6. Open the actual Tailscale Serve HTTPS URL in a touch browser. Confirm connected state, shared history, model selection, prompt round-trip, reload recovery, and usable controls at the narrowest viewport.
7. Confirm the route is Tailscale Serve only. Funnel must be off.
8. Verify the public release assets and checksums, then verify that the production site points to those exact files.

Release sequencing is enforced by the workflows. An ordinary main-branch site run deploys only when the release referenced by that source is already public; otherwise it exits successfully and defers the versioned site update. A release tag must match the trusted main-branch package version, resolve to a commit reachable from `main`, and remain fixed to that verified commit while every platform builds. After all desktop artifacts and `SHA256SUMS.txt` publish, the release workflow dispatches the production workflow on `main` with that exact tag. The site workflow independently resolves the published tag back to its immutable commit before building and deploying it.

## Why this gate exists

Earlier releases over-weighted fixture coverage and treated a product-surface roadmap as a completion contract. That left gaps at the boundaries between OMP, the client cache, Electron, the gateway, and a real touch browser. It also let single-client tests pass without proving desktop/phone convergence.

Fixture proof is enough to merge code. A release still needs installed-runtime and Tailnet proof.
