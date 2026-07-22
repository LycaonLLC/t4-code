# OMP to T4 Capability Audit (archived Flutter-era snapshot)

> Historical record only. Current Electron evidence is tracked in
> `docs/ELECTRON_STABILIZATION_TRACKER.csv`.

**Audit date:** 2026-07-20, refreshed 2026-07-21 after T4 PRs #109, #111, #113, and #114

**Scope:** source-level audit of original OMP, Lycaon's T4 fork, T4 desktop, the responsive web/Capacitor mobile client, and the new Flutter client

**Companion tracker:** [`OMP_T4_CAPABILITY_TRACKER.csv`](./OMP_T4_CAPABILITY_TRACKER.csv)

## Executive result

T4 already has the right basic architecture: T4 owns the app-facing protocol and host service, while OMP remains the authority for agent sessions, tools, models, settings, credentials, workers, locks, compaction, and OMP-native events.

The largest problem is no longer a missing transport layer. T4 now has a shared operation-capability contract and a T4-owned adapter that asks unmodified official OMP which commands it can run headlessly. The remaining work is to carry that truth into every client and then replace the most important terminal-only workflows with typed app actions.

1. **Operation truth is implemented in the host but was not yet reaching the UI.** PR #111 added `typed`, `headless`, `terminal-only`, and `unavailable`; PR #113 classifies stock OMP commands and rejects known terminal-only text before it reaches the model. This sprint carries that result into desktop/web and Flutter.
2. **Important daily workflows still lack a typed app action:** plan and goal modes, session branch/fork/tree, handoff, provider login/logout, queue control, and child-agent steering.
3. **The official-OMP Gate 0 proof is complete, and the first packaged-host proof passes.** Unmodified OMP 17.0.6 passed restart continuity, steering, follow-up, approval, cancellation, and the no-replay failure policy on macOS ARM64 plus native Linux x64 and ARM64. The compiled `t4-host` now also passes discovery, attach, prompt, durable JSONL, and T4-wire projection against official OMP on macOS ARM64; the same packaged proof is wired into the native Linux jobs.
4. **The Lycaon fork is transitional, not the desired product center.** The current public package still pins its thin authority bridge, but new compatibility work should prefer the T4-owned official-OMP adapter and add only small, extractable bridge methods when stock OMP has no usable seam.
5. **Protocol vocabulary is not UI coverage.** Every tracker row needs an explicit client disposition: direct control, palette action, read-only view, disabled explanation, terminal handoff, or unavailable.
6. **Source is ahead of the public release.** Flutter and the latest adapter work are on `main`; the latest public GitHub release remains v0.1.28.

## Current implementation checkpoint

The truthful-command foundation is split cleanly between merged host work and this client sprint:

- **Merged:** PR #111 defines one operation contract for every runtime and client.
- **Merged:** PR #113 queries official OMP's bounded `get_available_commands`, supplements omitted terminal-only commands from a pinned reviewed manifest, and blocks known terminal-only slash text before prompt dispatch.
- **Corrected boundary:** PR #114 proved restart continuity with the released Lycaon fallback artifact, despite the harness's old official-OMP name. This sprint adds a separate official OMP 17.0.6 pin and runs the proof against that unmodified binary.
- **Merged:** PR #117 preserves `catalog.get.result.operations` through the desktop runtime.
- **Merged:** PRs #118 and #120 make web/Electron and Flutter build truthful slash menus from the runtime capability contract and fail closed when that contract is absent or unavailable.
- **This sprint:** the official OMP 17.0.6 harness passes lifecycle, crash/resume, steer, follow-up, approval, and cancellation on macOS ARM64; the host/client failure tests prove a dispatched command becomes `outcome_unknown` and is never automatically replayed.
- **This sprint:** `compat/official-omp-gate0.json` records the exact runtime, required platforms/scenarios, direct RPC support, and three missing stock seams. macOS ARM64 plus Linux x64 and ARM64 CI jobs retain per-platform lifecycle and packaged-host evidence.
- **This sprint:** the shared supervisor synthesizes the missing ready watermark from official JSONL, projects complete durable records, conservatively correlates matching user prompts, and deduplicates the Lycaon fallback's richer live frames.
- **This sprint:** `t4-host --omp-authority official --omp-sessions-root <absolute-path>` adds an opt-in, exclusive-profile cutover path. The compiled macOS ARM64 host passes the real Unix-socket proof; native Linux proof is now a required CI scenario. The released/default desktop path remains the Lycaon bridge.
- **This sprint:** Flutter adds project Quick Open plus visible pause, resume, and manual compaction controls over existing typed commands. No new fork behavior is required.

The tracker distinguishes merged source, work in this sprint, and public release state. None of the new adapter/client work is claimed as packaged desktop, Android, or iOS proof yet.

### Sprint 1 coverage matrix

| Slice | Host/runtime | Desktop web/Electron | Mobile web/Capacitor | Flutter desktop/mobile | Evidence state |
|---|---|---|---|---|---|
| Operation capability contract | Merged | Decodes shared contract | Same web client | Dart decoder merged | PR #111 green |
| Official OMP command discovery and rejection | Merged | Receives through host | Receives through host | Receives through host | PR #113 green |
| Official OMP Gate 0 behavior | Direct RPC passes macOS ARM64 and native Linux x64/ARM64; compiled local host passes macOS ARM64 and is required in Linux CI | Adapter path proven, packaged desktop default unchanged | Shared host behavior | Shared host behavior | Stock 17.0.6 passes lifecycle, steer/follow-up, approval, cancellation, crash/no-replay, JSONL reconciliation, and the local T4 wire |
| Preserve `catalog.get.operations` | Merged host response | Merged in PR #117 | Merged in PR #117 | Already decoded | Response and live-frame client tests pass |
| Capability-aware slash menu | Host rejects unsafe fallback | Implemented on `main` | Implemented on `main` | Implemented on `main` | PRs #118 and #120 are green and merged |
| Project Quick Open | `files.search` merged | Implemented on `main` | Implemented on `main` | Implemented this sprint | Flutter analysis and the full 168-test suite pass locally; platform CI pending |
| Pause/resume controls | Typed commands merged | Not consistently visible | Not consistently visible | Implemented this sprint | Controller and widget coverage pass locally; platform CI pending |
| Manual compaction | Typed command merged | Partial slash/control UX | Partial slash/control UX | Implemented this sprint | Direct action is locally verified; richer strategy/result UX remains |

This matrix is intentionally stricter than “the protocol supports it.” A row is complete only when the connected runtime advertises it, the client exposes an honest action or explanation, and the target package has been exercised.

## Source pins and proof boundary

| Source | Audited ref | Why it matters |
|---|---|---|
| Original OMP | [`can1357/oh-my-pi@89d6a8f6`](https://github.com/can1357/oh-my-pi/commit/89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6), version 17.0.6 | Current original product surface |
| Lycaon OMP fork | [`lyc-aon/oh-my-pi@8476f445`](https://github.com/lyc-aon/oh-my-pi/commit/8476f4451ed95c5d5401785d279a93d3c659fac4), tag [`t4code-17.0.5-appserver-10`](https://github.com/lyc-aon/oh-my-pi/releases/tag/t4code-17.0.5-appserver-10) | Current released thin authority bridge; transitional compatibility input |
| Shared upstream base | [`can1357/oh-my-pi@9fd6e971`](https://github.com/can1357/oh-my-pi/commit/9fd6e97113f5ed3a847e66d346970efdf8afcad9), version 17.0.5 | Last shared OMP point |
| T4 `main` | [`210ddfcb`](https://github.com/LycaonLLC/t4-code/commit/210ddfcb11b84da89b2c4b079a9517901168fa37), version 0.1.30 in source | Official-OMP classification, capability-aware clients, Flutter controls, and cluster foundations are merged |
| Flutter merge | [`LycaonLLC/t4-code#104`](https://github.com/LycaonLLC/t4-code/pull/104) | New shared desktop/mobile client now on `main` |
| Public T4 release | [`v0.1.28`](https://github.com/LycaonLLC/t4-code/releases/tag/v0.1.28) | Latest public release visible during the audit |

This is primarily a source audit, supplemented by merged official-adapter smokes, focused TypeScript tests, and one compiled-host proof. It does not prove that every path works in a packaged desktop or mobile app. Live Flutter desktop, Android, iOS, web, and Electron round trips remain a separate verification pass.

Relevant planning and implementation changes:

- [#109: canonical local and managed architecture](https://github.com/LycaonLLC/t4-code/pull/109) — merged; makes the shared T4-owned official-OMP adapter the intended path.
- [#111: operation capability contract](https://github.com/LycaonLLC/t4-code/pull/111) — merged.
- [#113: official OMP operation classification](https://github.com/LycaonLLC/t4-code/pull/113) — merged.
- [#114: lifecycle continuity harness](https://github.com/LycaonLLC/t4-code/pull/114) — merged; its artifact came from the Lycaon fallback, so this sprint supersedes that proof boundary with a separately pinned official release.
- [#117: preserve OMP operation capabilities in the desktop runtime](https://github.com/LycaonLLC/t4-code/pull/117) — merged.
- [#98: standard OMP view-only compatibility](https://github.com/LycaonLLC/t4-code/pull/98) — still open, but its older read-only approach must not become a second long-term adapter beside the architecture in #109.

## Status and priority language

| Label | Meaning |
|---|---|
| `Code: full` | The audited source has a direct user path for the core behavior. It may still need packaged-app proof. |
| `Code: partial` | Some behavior exists, but important controls, detail, or platform coverage are missing. |
| `Slash only` | The app can use a verified headless slash command, but there is no first-class app action. |
| `Read only` | The app can display the state but cannot fully operate it. |
| `Missing` | No dependable app path was found. |
| `Platform` | The terminal presentation itself should not be copied; T4 needs an equivalent native behavior where useful. |
| `Open PR` | Work exists but is not merged into the audited `main`. |

| Tier | Meaning |
|---|---|
| `T0` | Core daily loop, data safety, or a misleading behavior that should be fixed before claiming parity |
| `T1` | Frequent power-user workflow that materially improves normal desktop/mobile use |
| `T2` | Advanced integration or less frequent workflow |
| `T3` | Niche, diagnostic, or terminal-specific convenience |

## What OMP actually contains

OMP is much more than a chat loop. Its major surfaces are:

| OMP area | Important behavior |
|---|---|
| Runtime entry points | Interactive terminal UI, one-shot print/JSON, Node SDK, RPC/RPC-UI, ACP editor integration, encrypted live collaboration, and browser guest mode |
| Prompt control | Prompt, live steering, after-turn follow-ups, queue modes, structured questions, pause, cancel, retry, force-tool, side questions, and background tangents |
| Sessions | Persistent JSONL trees, resume, branch, fork, tree navigation, rename, move, archive/delete, provider-state reset, compact, handoff, export, share, and collaboration |
| Models and providers | Provider login, model inventory, role routing, thinking levels, service tiers, fallbacks, provider health, and quota/reset data |
| Tools | Files, shell, eval, LSP, debugger, AST operations, browser, web search, GitHub, images, speech, agents, todos, memory, checkpoints, and rewind |
| Agents | Subagents, worktree isolation, progress, child transcripts, cancellation, jobs, hub coordination, and todos |
| Extensibility | Skills, extensions, plugins, marketplaces, custom commands, hooks, custom renderers/providers, and MCP servers/resources/prompts/OAuth |
| Context and memory | Context reporting, compaction strategies, project rules, stream rules, memory backends, retain/recall/reflect, checkpoint, and rewind |
| Developer operations | Files, diff/review, persistent terminal, one-shot bash, SSH, browser automation, worktrees, commits, reviews, and CI repair |
| Operations | Settings, approval policy, usage, statistics, debugging, changelog, install/update, completions, setup, and garbage collection |

The [current OMP README](https://github.com/can1357/oh-my-pi/blob/89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6/README.md), [RPC documentation](https://github.com/can1357/oh-my-pi/blob/89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6/docs/rpc.md), [session-operation matrix](https://github.com/can1357/oh-my-pi/blob/89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6/docs/session-operations-export-share-fork-resume.md), [settings reference](https://github.com/can1357/oh-my-pi/blob/89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6/docs/settings.md), and [extension reference](https://github.com/can1357/oh-my-pi/blob/89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6/docs/extensions.md) are the primary upstream references.

### Command and tool counts

- Original OMP defines 62 built-in top-level slash commands before aliases and dynamically added skill commands.
- The Lycaon fork adds `/mechanism` and `/continue-in-t4`, bringing the fork catalog to 64.
- A live official-OMP smoke in PR #113 produced 68 normalized operations: one typed prompt operation plus the headless commands returned by official OMP and 35 reviewed terminal-only commands omitted from that headless feed.
- These counts are evidence for the pinned OMP build, not permanent constants. The client reads the operation list returned by the connected runtime rather than baking the count into its UI.
- The source registry contains 29 built-in tool names including hidden control tools. The desktop web client has specialized cards for 24; `checkpoint`, `rewind`, `memory_edit`, `learn`, and `manage_skill` currently use the safe generic fallback. Flutter currently uses generic structured tool cards rather than specialized per-tool cards.
- OMP's settings schema has 415 top-level settings; 303 include UI metadata. The fork already turns the schema into secret-safe catalog data, so T4 should keep generating settings UI instead of manually rebuilding hundreds of controls.

## What Lycaon's fork adds today

The fork provides the T4-specific bridge, launcher, compatibility packages, and two additional product surfaces:

| Addition | Purpose | Long-term home |
|---|---|---|
| `omp bridge --stdio` | Exposes OMP-wide authority through `t4-omp-authority/1` | Thin OMP adapter in the fork |
| `omp appserver` compatibility command | Starts/administers the T4-owned host | Compatibility launcher only |
| `omp home` | Loopback web UI for profiles, routing, settings, roles, and providers | Evaluate separately; do not duplicate logic in every client |
| `omp mechanism` | Archived harness/session visualization | Optional advanced surface |
| `packages/app-wire` | Compatibility re-export of the T4 protocol | T4 owns the active protocol |
| `packages/appserver` | Compatibility wrapper for T4's host service | T4 owns the active host |

Fork PR [#22](https://github.com/lyc-aon/oh-my-pi/pull/22) removed more than 37,000 lines of copied generic host/wire code from OMP and placed that ownership in T4. Fork PR [#23](https://github.com/lyc-aon/oh-my-pi/pull/23) added the smaller authority bridge. That reduction was correct, but PR #109 now sets a stronger direction: the normal local and managed paths should share a T4-owned adapter around pinned official OMP. The fork bridge remains a current compatibility input until Gate 0 proves the official path can replace each required authority safely.

## Current T4 coverage

### Strong foundations already present

| Area | Current source evidence |
|---|---|
| Host and security | Versioned bounded protocol, device capabilities, pairing, replay, controller/prompt leases, confirmation challenges, and negotiated features |
| Sessions | List, create, attach, rename, archive, restore, close/delete, prompt, steer, follow-up, cancel, retry, compact, pause/resume in the wire, model/thinking/fast controls |
| Transcript | Durable entries, reconnect reconciliation, images, paging, search, surrounding context, attention summaries, and latest outcomes |
| Developer tools | Confined files, diff/review, one-shot bash, persistent terminal, preview navigation/input/capture, and audit events |
| Host-wide OMP truth | Session discovery/lifecycle, roots, locks, settings/catalog, provider broker status, usage, files, review, bash, and terminal through the authority bridge |
| Desktop web/Electron | Session library, composer, attention, agent view, files, review, terminal, browser preview, settings, transcript search, usage, and host management |
| Responsive web/Capacitor | Shares most web UI and supports remote T4 gateway use; native Android shell adds secure storage, updates, and speech support |
| Flutter on `main` | Host/pairing management, sessions, conversation, attention, developer surfaces, settings, transcript search, usage, model controls, and structured tool cards |

### Important gaps

| Priority | Gap | Why it matters | Best patch path |
|---|---|---|---|
| T0 | Managed and shipped official-OMP cutover is not proven | Stock JSONL reconciliation and the compiled local host now pass on macOS ARM64; Linux packaged-host CI, managed-session proof, and an actual desktop release still remain | Land native packaged-host evidence, prove the same authority in managed sessions, then change release packaging deliberately |
| T0 | A fresh official-OMP profile has no project bootstrap flow | The current authority derives projects from existing sessions, so the opt-in proof seeds one session before discovery | Add a small T4-owned project registry or explicit project-add command, then prove first-run create without prewriting OMP state |
| T0 | Release state is ambiguous | Source says v0.1.30 while public GitHub release remains v0.1.28 | Separate `on main`, `verified package`, and `publicly released` in the tracker/release gate |
| T0 | Plan, goal, branch/fork/tree, handoff, and provider auth lack complete typed app flows | These are central OMP workflows, not decorative terminal features | Typed T4 commands backed by existing OMP RPC where possible |
| T1 | Queue and pause/resume controls are not consistently exposed outside Flutter | Cross-device control needs explicit, predictable behavior | Add equally visible controls to web/Capacitor over the same typed commands |
| T1 | Child agents can be viewed/cancelled but not fully steered or messaged | Agent orchestration is a major reason to use OMP | Add typed agent actions and OMP event projection |
| T1 | Project/worktree context is not consistent across clients | Quick Open is now covered, but branch/worktree identity is still easy to miss | Project a shared read-only context summary from runtime truth |
| T1 | Mobile tool output is mostly generic | It is safe, but harder to scan than desktop | Share semantic tool-view models, then use platform-specific layouts |
| T2 | MCP, skills, plugins, extensions, and marketplaces are mainly catalog/settings data | Advanced OMP setup still requires the terminal | Start read-only, then add bounded management actions |
| T2 | Memory, checkpoints, rewind, collaboration, and sharing lack first-class app flows | Useful but less common and higher-risk to expose casually | Typed commands with confirmation and clear results |

## Truthful command execution

The original defect was that a command name in a catalog did not prove that the connected runtime could execute it outside the terminal UI. That allowed a terminal-only command to look selectable and then arrive as ordinary model text.

```text
catalog used to show /plan
        |
        v
user selects /plan in T4
        |
        +-- real headless handler? no
        |
        v
text reaches the model as an ordinary prompt
        |
        v
OMP plan mode was not actually enabled
```

The merged operation contract now uses these execution values:

```text
typed          a first-class T4 operation
headless       discovered from official OMP and safe through its RPC prompt path
terminal-only  recognized, visible, and blocked from app prompt dispatch
unavailable    known to the product but not exposed by this runtime
```

PR #113 enforces this at the host boundary. This sprint enforces it again at the presentation boundary:

```text
official OMP get_available_commands
        |
        v
T4 adapter classifies operations
        |
        +-- headless ------> selectable in desktop and mobile
        |
        +-- terminal-only -> visible, disabled, exact reason shown
        |
        +-- unavailable ---> omitted from unrelated controls or shown disabled
```

The app must still keep the host-side rejection. A disabled menu is helpful feedback, not a security or correctness boundary.

## Recommended thin-host architecture

Use the architecture established in PR #109. T4 owns one adapter and uses it in local and managed deployments; official OMP remains the runtime authority.

```text
Desktop or mobile UI
        |
        | typed, versioned omp-app/1 commands
        v
T4 local service or T4 managed runtime
        |
        +-- shared T4 adapter ------------> pinned official OMP RPC
        |
        +-- temporary missing seam -------> thin Lycaon bridge method
        |                                   only where Gate 0 proves it is needed
        |
        +-- T4 product services ----------> pairing, replay, search,
                                            previews, workspaces, adapters
```

### Ownership rules

| Layer | Owns | Does not own |
|---|---|---|
| OMP original | Agent behavior, session truth, workers, tools, models, provider auth, settings, compaction, OMP events | T4 device pairing, mobile transport, T4 screen layout |
| Lycaon fork | Temporary, small OMP-specific seams still required by the released product, plus pinned release provenance | The default home for capability discovery, lifecycle policy, generic host code, protocol code, or client behavior |
| T4 host and adapter | App protocol, security, replay, capability normalization, projections, search/indexes, artifacts, preview, workspace lifecycle, and official-OMP process handling | Reimplementation of OMP session/model/tool rules |
| T4 clients | Layout, navigation, accessibility, native integrations, and user actions gated by negotiated capabilities | Guessing runtime truth or parsing private OMP files directly |

### How each kind of gap should be fixed

| Gap type | Preferred fix |
|---|---|
| A screen is missing but the wire already supports it | Client-only UI work |
| OMP RPC already supports the operation | Add a typed T4 command that forwards to the existing RPC request |
| The operation is OMP-wide rather than session-specific | First look for a stable official RPC/SDK seam; add one small extractable fork bridge method only when needed |
| The behavior is safe but uncommon | Keep a verified headless slash path temporarily |
| The behavior is terminal presentation | Build a native equivalent or use an explicit CLI handoff |
| Original OMP lacks a stable generic seam | Propose a small upstream RPC/SDK improvement that benefits any client |
| The fork differs only because it is old | Move the compatibility proof to pinned official OMP; do not create another fork workaround |

Do not send a giant T4 product PR to original OMP. A suitable upstream contribution is small and generic—for example, a stable RPC operation or capability field useful to any client. T4-specific device permissions, mobile behavior, search projections, and host lifecycle belong in T4.

## Capability manifest and drift control

The checked snapshot at `compat/official-omp-gate0.json` now records the Gate 0 runtime, platform/scenario contract, direct RPC support, missing stock seams, T4's JSONL coverage, packaged-host contract, and no-replay policy. Native runs write both `artifacts/official-omp-gate0/<platform>-<arch>.json` and `artifacts/official-omp-packaged-host/<platform>-<arch>.json` as evidence. The broader capability snapshot should next add:

- Official OMP version and exact commit; when the fallback bridge is exercised, its fork commit and tag too.
- Operations and aliases using `typed`, `headless`, `terminal-only`, or `unavailable`.
- Built-in tool names and relevant rendering metadata.
- Settings schema hash and UI-metadata count.
- RPC commands/events, T4 adapter coverage, and any remaining authority-bridge methods.
- Provider/auth capabilities and runtime roles.

CI should compare the new manifest with the previously approved manifest. It should fail only when a capability was added, removed, or changed without a tracker classification. This catches drift without forcing the host to duplicate OMP internals.

The release compatibility row should pin all of these together:

```text
official OMP version + commit
        + T4 adapter version + Gate 0 result
        + optional Lycaon fallback commit + tag
        + authority protocol version
        + omp-app protocol version
        + T4 host package hash
        + desktop/mobile build version
```

## Suggested delivery order

### Phase 0: finish the official-OMP foundation

1. Land the completed stock-JSONL reconciliation and native packaged-local proof without changing the released default.
2. Add a first-run project registry or explicit project-add flow so an empty exclusive profile can create its first session.
3. Apply the same exclusive-profile authority contract to managed session hosts and prove it on native Linux x64/ARM64.
4. Track source, verified package, and public release status separately, then retire fallback use only after packaged desktop and managed proofs pass.

### Phase 1: close the daily-workflow gaps

1. Plan and goal modes.
2. Branch/fork/tree and handoff.
3. Provider login/logout and setup.
4. Queue controls plus matching pause/resume and compaction controls in web/Capacitor.
5. Consistent project/worktree context across clients.
6. Child-agent steer, follow-up, and wake/message actions.

### Phase 2: make desktop and mobile equally useful

1. Share semantic tool-view models between desktop and Flutter.
2. Finish mobile layouts for files, review, terminal, and preview without copying desktop chrome.
3. Verify reconnect, pairing, offline transcript, attention, and approval flows on macOS, Android, and iOS.
4. Add accessibility, notifications, updates, and platform lifecycle proof.

### Phase 3: advanced OMP administration

1. MCP, skills, plugins, extensions, and marketplace management.
2. Memory maintenance, checkpoint, and rewind.
3. Share/collaboration and encrypted guest access.
4. OMP Home and Mechanism integration decisions.

## How to use the tracker

The companion CSV has 104 feature rows, each with one stable feature ID. Update a client column only when there is a named source path, test, screenshot, or live round-trip attached as evidence. Protocol vocabulary alone is not enough.

For each future sprint:

1. Filter to the highest incomplete tier.
2. Check whether the gap is UI-only, an existing RPC seam, an authority-bridge seam, a CLI handoff, or simple upstream drift.
3. Implement the smallest complete vertical slice across the required layers.
4. Verify desktop and mobile separately.
5. Record the exact release/build where the feature became available.

## Audit limitations and next proof pass

- This pass ran the compiled `t4-host` against the pinned official OMP binary on macOS ARM64, but did not run a packaged Electron/Flutter application bundle.
- It did not visually inspect every desktop, Android, or iOS screen.
- Optional protocol features may not be negotiated by every host instance.
- The shared adapter is currently an official-OMP seam, not proof that T4 is a generic multi-runtime product.
- OMP Home and Mechanism were cataloged but not judged as required T4 screens.
- TUI decoration, key bindings, status-line layout, and editor overlays should be judged by functional outcome, not pixel-for-pixel parity.

The next audit pass should execute Tier 0 and Tier 1 rows against packaged Flutter desktop, Android, and iOS builds, plus the still-supported web/Electron client where applicable, and attach proof to this tracker.
