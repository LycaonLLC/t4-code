# OMP Desktop Product Surface Map

This file maps product ideas to their OMP authority and intended T4 Code surface. It is a design and ownership reference, not a list of features shipped in the current release. A row can describe planned work, partial work, or verified behavior; its presence here is not completion proof.

The README and release notes are the release contract. They must only claim behavior exercised by the current build. OMP remains the behavioral authority, and T3 Code remains a presentation and interaction reference where noted below.

## 1. Hosts, connections, and environments

| Capability | OMP authority | T3 reference | Desktop surface and required states | Priority |
|---|---|---|---|---|
| Local host discovery | `packages/coding-agent/src/modes/rpc/rpc-mode.ts`, planned appserver health/capabilities | `apps/web/src/routes/__root.tsx`, `packages/client-runtime/src/connection/*` | Host switcher; starting, ready, version-skew, unavailable, reconnecting, read-only, upgrade-required | Launch |
| Remote tailnet host | Existing collab transport plus planned appserver; current Mac/bunker topology | `packages/tailscale/src/tailscale.ts`, `packages/ssh/src/tunnel.ts`, connection supervisor | Add by MagicDNS/IP, pair, trust, connect, revoke, latency/status; never expose tokens | Launch |
| Host capability negotiation | Planned versioned app protocol over OMP runtime | T3 contract schemas and server handshake | Show feature compatibility; disable unsupported actions with reason | Launch |
| Multi-host operation | Planned appserver registry | T3 environments/projects | Sessions grouped by host and project; host status remains visible across switches | Launch |
| Daemon lifecycle | Planned Linux systemd user unit and macOS launchd agent | T3 desktop service launch/update patterns | Install/start/stop/restart/status/log location; desktop may attach without owning process lifetime | Launch |
| Offline cached browsing | Session JSONL snapshots plus disposable client cache | T3 cached snapshots/replay | Read cached sessions while host is offline; all writes disabled and labeled; cache never becomes durable truth | Launch |

## 2. Projects, workspaces, and repositories

| Capability | OMP authority | T3 reference | Desktop surface and required states | Priority |
|---|---|---|---|---|
| Open/add project | Session `cwd`, workspace tree, filesystem tools | `Sidebar.tsx`, folder picker IPC, environment creation | Native folder picker; recent projects; local/remote path validation; duplicate detection | Launch |
| Project/session grouping | Session headers and cwd | `SidebarProjectsContent`, sortable project rows | Collapsible project groups, stable manual order, activity counts | Launch |
| Git branch/worktree context | Bash/git/LSP/runtime cwd; task isolated worktrees | `BranchToolbar*`, `GitActionsControl*` | Current branch, dirty state, worktree, PR association when available; never imply clean without proof | Launch |
| Workspace tree and files | `read`, `find/search`, LSP, workspace tree | T3 file browser and preview panels | Lazy file tree, open/reveal, search, diagnostics badges, remote-safe path handling | Launch |
| Project scripts | Shell/runtime | `ProjectScriptsControl.tsx` | Optional explicit scripts; running/exited/restart states; no inferred destructive command | Parity |

## 3. Sessions and conversation lifecycle

OMP authority: `packages/coding-agent/src/session/agent-session.ts`, `session-manager.ts`, `session-entries.ts`, `session-loader.ts`, RPC types, and the built-in slash-command registry.

| Capability | Source command/state | Desktop behavior | T3 reference | Priority |
|---|---|---|---|---|
| List/recent/search/filter | session store and metadata | Virtualized left rail; project/host grouping; running/waiting/failed/unread badges; fuzzy search | `Sidebar.tsx`, sidebar logic/tests | Launch |
| New session | `/new` | Create in selected project/host; model/profile defaults visible before first prompt | draft routes and composer draft store | Launch |
| Fast switch and tabs | session IDs and snapshots | One-click/keyboard switch; preserve draft, scroll anchor, panel widths/tabs, terminal focus; no white flash | T3 routes, `composerDraftStore`, `rightPanelStore`, terminal store | Launch |
| Resume | `/resume` | Open existing session by stable ID/path; recover moved/missing files with explicit error | thread routing and reconnect supervisor | Launch |
| Rename | `/rename` | Inline rename with optimistic state and rollback | sidebar row actions | Launch |
| Move working directory/session | `/move` | Native/remote path picker, validation, explicit impact message | environment picker patterns | Parity |
| Delete/drop | `/session delete`, `/drop` | Confirmation names exact session; running-session guard; recoverable failure | thread bulk actions/dialogs | Launch |
| Fresh provider stream | `/fresh` | Reset provider stream state while preserving transcript; unavailable while streaming | action menu/status | Parity |
| Retry failed turn | `/retry` | Retry only last eligible turn; display attempt and error ancestry | message action patterns | Launch |
| Branch/fork/tree | `/branch`, `/fork`, `/tree` | Branch from selected turn, show ancestry, switch branches without losing current state | T3 thread branching/worktree patterns | Parity |
| Handoff | `/handoff` | New session with visible context/focus provenance | new-thread promotion patterns | Parity |
| Compact | `/compact` modes | Manual compact, progress, new context budget, failure/retry | plan/work activity rendering | Launch |
| Shake | `/shake` modes | Show what class of heavy content is removed; context estimate changes | context/review pane | Advanced |
| Export/dump | `/export`, `/dump` | Native save dialog, HTML/text/JSON artifacts, exact destination | desktop file-save IPC | Parity |
| Share | `/share` | Encrypted link creation/revoke/copy; authority warning | connection/share patterns | Advanced |
| Live collab/join/leave | `/collab`, `/join`, `/leave`; `collab/host.ts`, `collab/protocol.ts` | Host/view/join/leave/status, guest identity and permissions, copy/QR link; desktop right pane mirrors participants | current OMP collab web and T3 connection UI | Parity |
| Usage/context/stats | `/usage`, `/context`, `/stats`; `packages/stats` | Session context meter, tokens/cost/provider limits, full dashboard | context and status surfaces | Launch |
| Changelog | `/changelog` | Version-aware changes view | T3 desktop update notification | Parity |

## 4. Composer and input

| Capability | OMP authority | Desktop contract | T3 reference |
|---|---|---|---|
| Multiline prompt and draft | session prompt API | Per-session/host draft preservation, undo, paste, IME, large input | `ChatComposer.tsx`, `ComposerPromptEditor.tsx`, draft store |
| Slash commands | `slash-commands/builtin-registry.ts` | Schema-fed autocomplete, aliases, argument hints, subcommands, disabled reason by mode/guest authority | T3 slash search/menu logic |
| File/path references | read/workspace/LSP context | Fuzzy file picker, chips, drag/drop, remote paths, remove/reorder | T3 inline chips and file context |
| Images/attachments | session image attachments, inspect/image tools | Paste/drop/file picker, thumbnails, size/type errors, upload/promotion state | T3 attachment preview/promotion logic |
| Voice/STT/TTS | `stt/stt-controller.ts`, setup CLI, TTS tool | Optional record/transcribe/read-aloud with explicit install/error state | T3 composer controls; new OMP appserver bridge |
| Model selector | model registry and `/model`/`/switch` | Provider/model search, active role, unavailable/limit state, per-session switch | T3 model picker/provider state |
| Thinking/reasoning level | model capabilities/settings | Only valid options per model; retain user choice by profile/session | T3 reasoning controls |
| Fast tier | `/fast` | on/off/status and provider scope; semantic accent only while active | composer status control |
| Advisor | `/advisor` | on/off/status/dump; show advisor state and injected notes without mixing authors | plan/activity side surface |
| Plan mode/review | `/plan`, `/plan-review` | mode state, plan artifact, approve/revise/reject controls, timeout state | `PlanSidebar.tsx`, pending approval UI |
| Goal/guided goal/loop | `/goal`, `/guided-goal`, `/loop` | persistent objective, iteration count/duration, yield/cancel controls | new OMP mode strip/right-pane surface |
| Force tool | `/force` | choose visible tool and attach prompt; one-turn scope clearly labeled | command palette/composer menu |
| Side question/background tangent | `/btw`, `/tan` | ephemeral answer or background agent tied to parent turn; activity visible | child-thread/activity patterns |
| Browser mode | `/browser` | headless/visible state and current browser surface | T3 preview/browser panel |

## 5. Transcript and streaming renderers

| Entry/event | Required renderer and transitions | Authority |
|---|---|---|
| User message | Markdown/plain text, attachments, terminal/file chips, edit/retry/branch actions | session entries/messages |
| Assistant text | Incremental markdown with stable layout; code fences and tables; copy/save | `AgentSessionEvent` message updates |
| Thinking/reasoning | Collapsible, low-emphasis, streaming/complete/error states; honor provider visibility rules | provider events/session messages |
| Tool call | Tool name, semantic icon, concise summary, expandable validated arguments, running duration, cancelability | tool call events |
| Tool result | Success/error/cancelled, structured renderer when known, raw fallback, artifact/internal URL links | tool result events |
| Bash/PTY | command, cwd, exit, duration, live minimized output, attach/open terminal | bash executor/shell events |
| Edit/write/AST/LSP | file paths, patch/diff, diagnostics, apply/pending/discard state | edit/LSP/resolve tools |
| Read/search/find/web/GitHub | query, targets, result counts, citations/links, errors | respective tools |
| Browser/debug/eval | lifecycle, target/session, output/artifacts, failure | respective tools |
| Ask/approval/resolve | blocking card, keyboard navigation, submitted value, timeout/cancel | ask/client bridge/plan actions |
| Compaction/retry/provider error | causal grouping and attempt history; no duplicate transcript rows | session events |
| Notifications/system notices | restrained inline status; never masquerade as model output | client bridge/events |
| Artifacts/images | preview/open/save and missing/offline state | artifact manager/internal URLs |
| Unknown extension/MCP tool | safe generic JSON/tree renderer with raw copy; never crash stream | extension/MCP tool contract |

## 6. Subagents, tasks, jobs, IRC, and todos

OMP authority: `task/executor.ts`, `task/types.ts`, `async/job-manager.ts`, `irc/bus.ts`, tool implementations, and task tests.

| Capability | Desktop contract | Right-pane behavior | Priority |
|---|---|---|---|
| Task spawn and batch | Render assignment, role/model, parent tool call, start order | Tree node appears before first progress event | Launch |
| Parent/child/grandchild hierarchy | Stable IDs and parent linkage; depth visible | Expand/collapse tree, breadcrumbs, select without leaving main transcript | Launch |
| Lifecycle | queued/running/waiting/idle/parked/completed/failed/aborted/cancelled | Status glyph plus text; no color-only meaning; elapsed/last activity | Launch |
| Progress | current tool, args summary, recent output, budget/request counts when available | Throttled live detail; no whole-tree rerender per token | Launch |
| Agent transcript | Open child transcript read-only or navigable session; link back to parent | Detail tab or main-center navigation | Launch |
| Isolated worktree | Show worktree path/branch and merge outcome | Explicit isolation badge and conflict/failure state | Parity |
| Job lifecycle | list/watch/cancel, completion delivery, background command status | Activity `Jobs` filter and session-linked rows | Launch |
| IRC | roster, unread, send/reply/wake/wait state | Agent detail communication tab; authority-aware controls | Parity |
| Todo | phase/task hierarchy and transitions | Plan/todo view reached from Agents or composer plan state; complete/in-progress/pending/dropped | Launch |
| User steering | Send instruction to selected live agent with confirmation of target | Detail composer distinct from main prompt | Parity |
| Failure/stall | Surface repeated errors/no-progress with evidence | Alert in tree and global activity filter | Launch |

Subagent event authority includes `TASK_SUBAGENT_LIFECYCLE_CHANNEL`, `TASK_SUBAGENT_PROGRESS_CHANNEL`, and `TASK_SUBAGENT_EVENT_CHANNEL` in `packages/coding-agent/src/task/types.ts`.

## 7. Files, review, terminal, browser, and developer surfaces

| Surface | T3 implementation reference | OMP data/control | Required states |
|---|---|---|---|
| Right-panel families | `rightPanelStore.ts`, `RightPanelTabs.tsx`, `RightPanelSheet.tsx` | protocol surface registry | Five persistent families: Agents, Activity, Review, Files, Terminal; open/close/reorder/select/restore per session; context is a composer popover/dialog and raw events are Activity filters |
| Diff/review | `DiffPanel.tsx`, `AnnotatableCodeView.tsx`, `@pierre/diffs` | git/files/edit artifacts | unified/split, wrap, collapse, comments, binary/missing/huge diff |
| File preview/editor | `files/FilePreviewPanel.tsx`, file save coordinator | read/write/LSP | loading, dirty, save conflict, diagnostics, binary/image, offline read-only |
| Terminal drawer | `ThreadTerminalDrawer.tsx`, server terminal manager/node-pty | OMP persistent shell/appserver PTY | tabs/splits/resizing/history/input/exit/restart/reconnect/backpressure |
| Browser/app preview | T3 preview manager/panel/webview security | OMP browser tool and app preview | Required Wave 4 focused preview workspace or secondary Electron window; navigation, inspect/click/scroll/type, screenshots, crash/reload, trusted partitions; not a sixth permanent right-pane tab |
| Context inspector | T3 context/session surfaces | OMP context estimate, rules, files, skills, memory contributions | Composer meter popover plus detailed dialog; budget breakdown and source disclosure without secret content |
| Raw event inspector | New OMP surface | versioned app protocol frames | Activity filters/search/pause/copy/export, redaction, unknown-version fallback; not a separate permanent tab |
| Logs/diagnostics | T3 diagnostics settings | OMP logs/doctor/provider/tool status | scoped export, redacted data, service health, actionable errors |

## 8. Models, providers, authentication, and usage

The desktop reads typed data from OMP settings/model/provider registries. It never reads or displays secret values.

- Provider inventory, health, account labels, model inventory, capabilities, pricing metadata, service tier, quota/usage, and error status.
- Role routing: main, smol, slow, plan, advisor, reviewer, direct named model, and current session override.
- Provider setup/login/logout flows use OMP-owned auth APIs and browser/deep-link callbacks.
- Auth broker state is status-only; token contents never cross the protocol.
- Custom provider/model configuration uses schema-generated controls with secret references, not raw secret text.
- Model switching validates capability compatibility before changing the live session.
- Usage views include per-turn/session/day/provider/model tokens, cost where known, cached tokens, request count, and resets supported by `/usage`.

Authority paths: `config/settings.ts`, `settings-schema.ts`, `models-config-schema.ts`, `model-registry.ts`, provider capability registry, auth broker/client code, `packages/stats`.

## 9. Tools and extensibility

### Built-in tool catalog

The appserver exposes the active tool catalog from `tools/index.ts` and `tools/builtin-names.ts`. Initial known names are:

`read`, `bash`, `edit`, `ast_grep`, `ast_edit`, `ask`, `debug`, `eval`, `ssh`, `github`, `find/search`, `lsp`, `inspect_image`, `browser`, `checkpoint`, `rewind`, `task`, `job`, `irc`, `todo`, `web_search`, `search_tool_bm25`, `write`, `memory_edit`, `retain`, `recall`, `reflect`, `learn`, `manage_skill`; plus hidden/runtime tools `yield`, `report_finding`, `report_tool_issue`, `resolve`, and `goal` when enabled.

For every tool: show availability, source, description, running calls, validated input/result, permission class, artifacts, error, and raw fallback. Tool-specific renderers are enhancements over the generic structured renderer, never separate backend implementations.

### Extensibility inventory

| Capability | Authority | Desktop surface |
|---|---|---|
| MCP servers/tools/resources | `mcp/client.ts`, manager/config, `/mcp` | servers list, transport/health/tools, add/test/remove, logs, secret-safe config |
| Extensions/plugins | `extensibility/extensions/loader.ts`, types, `/extensions`, `/plugins` | installed/enabled/source/version/errors; enable/disable/reload |
| Marketplace | `/marketplace` | sources, search, details, install/update/remove with permission warning |
| Skills | `extensibility/skills.ts` | user/project/managed sources, inspect, enable/disable where supported, managed-skill operations |
| Agents | registry and `/agents` | bundled/user/project agents, model/role/source, availability |
| Commands | builtin registry plus extension commands | searchable command palette and slash autocomplete |
| Custom tools/hooks | extension API/shared events | inventory, source, enabled state, failure logs |
| Tool discovery | discovery mode/search index | active vs discoverable counts and search action |
| Reload | `/reload-plugins` | atomic reload progress/result; preserve current session on failure |

## 10. Memory, context, rules, and autonomous modes

| Capability | Authority | Desktop contract |
|---|---|---|
| Recall/reflect/retain/learn/edit | Mnemopi tools and `packages/mnemopi` | Memory search/list/detail/source, create/update/invalidate/forget confirmations, fact read-only state |
| Memory maintenance | `/memory` subcommands | status/health/refresh/history/maintenance results; advanced surface |
| Context files | capability/context loaders and `AGENTS.md` discovery | Show applied files/source/scope and reload state; content visibility respects filesystem authority |
| Skills/rules | skill and rule loaders | Show what influenced current session and source precedence |
| TTSR/OMFG | `export/ttsr.ts`, `/omfg` | Rule creation/review, trigger event, stream abort/retry ancestry, enable/disable |
| Checkpoint/rewind | checkpoint tools | Named checkpoint state, rewind preview/confirmation, current-history impact |
| Goal/guided goal/loop | goal state/runtime and slash commands | Objective/progress/yield/iteration controls and persistent status |
| Advisor/plan/review | respective mode state and commands | Distinct authorship, state, review actions, timeout/error |

## 11. Settings, diagnostics, and desktop lifecycle

Settings UI is generated from OMP's typed `settings-schema.ts` and supplemental model/provider schemas. This avoids a second hand-maintained settings universe and guarantees new OMP settings appear with an unsupported-control fallback rather than disappearing.

Required classes and behavior:

- Scope: global, project, session override, CLI overlay, read-only effective value.
- Type: boolean, enum, number, duration, text, path, list, map, secret reference, nested object.
- State: default/inherited/overridden, invalid, restart-required, unavailable on host/platform, sensitive.
- Actions: edit, reset scope, reveal source path—not secret value—reload, validate, export redacted diagnostics.
- Dedicated surfaces: general, appearance, models/providers, roles, tools/discovery, MCP, extensions/plugins, agents/skills, memory, keybindings/hotkeys, notifications, speech, browser, terminal, remote hosts, updates, diagnostics.
- App lifecycle: window state, native titlebar, menu, deep links, protocol URLs, notifications, tray optional, update download/apply, crash recovery, safe restart, release notes.

## 12. Visual system and accessibility contract

- Light and dark only; neutral surfaces dominate.
- Pi Pink `#e83174` is reserved for brand mark, focus/selection when not conflicting with semantic state, primary commit action, and active OMP identity. It is not a background wash or decorative gradient.
- Success/warning/error/info use separate accessible semantic colors; pink never means both brand and warning in the same context; warning stays semantic amber.
- Existing OMP pi/connector mark from `assets/icon.svg` is adapted for light/dark and desktop icon sizes.
- All status has icon/text/shape, never color alone.
- Full keyboard navigation, visible focus, screen-reader names, reduced motion, scalable type, IME, and minimum-window fallback. Text meets WCAG AA; focus/selection rings meet WCAG 1.4.11 non-text 3:1 against both surface and adjacent fill.

## 13. Explicit CLI-only boundaries

These remain CLI-only only when the desktop cannot preserve authority or fidelity:

- Raw terminal escape-sequence presentation and terminal-specific debug probes.
- Shell profile editing and arbitrary credential-file editing.
- Provider secret value display.
- Unsafe plugin source mutation without an OMP-owned validated command.
- Internal developer commands with no stable non-TUI handler until OMP exposes one.

CLI-only is not silent omission. The desktop shows the capability, explains why it opens a terminal or is unavailable, and provides the exact safe transition.
