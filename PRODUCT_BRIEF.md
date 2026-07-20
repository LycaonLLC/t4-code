# OMP Desktop Product Brief

## Product

A Linux/macOS desktop client for OMP. Preserve OMP as the agent runtime; make projects, concurrent sessions, live streaming, tools, terminal activity, subagents, reviews, files, settings, and remote hosts easier to see and operate.

## Primary reference

T3 Code at `reference/t3code` is the primary presentation, interaction, desktop-shell, and implementation reference. Its MIT license permits copying and modification with attribution. Use direct adaptation where it accelerates quality; do not reimplement equivalent primitives without a reason.

## Experience target

- Presentation and perceived performance are product-critical.
- Keyboard-first, dense when useful, calm by default.
- Fast project/session switching with preserved scroll, composer, panel, and draft state.
- Center session stream remains the primary surface.
- Optional right pane extends the T3 pattern with five calm surface families: Agents, Activity (including events), Review, Files, and Agent Terminals. The user terminal remains a bottom drawer. Context is a popover/dialog, not a permanent tab.
- Browser/app preview is available through the focused host Preview and the separate native desktop Browser workspace rather than becoming a sixth permanent right-pane family.
- Keyboard shortcuts and Quick Open use one shared action registry so the same operation has one availability rule and one implementation. Workspace menus currently use the same explicit store actions and can move into the registry as the action set grows.
- A visible text-file preview can be deliberately staged as bounded, reviewed context for the next new prompt. It is temporary renderer state compiled into ordinary prompt text; it does not create a second runtime authority.
- Light and dark themes use neutral surfaces. Accent use is minimal and semantic.
- OMP identity uses the existing pi/connector mark from the upstream Oh My Pi repository and the Pi Pink `#e83174` accent.
- No SVG turbulence, paper-grain, noise texture, or equivalent decorative overlay is imported from T3.

## Runtime boundary

- OMP remains authoritative for models, tools, commands, sessions, task agents, memory, skills, settings, auth, and execution.
- The desktop app consumes a versioned OMP app protocol; it does not parse terminal pixels as its primary data source and does not reimplement OMP behavior.
- A persistent OMP appserver runs on an OMP host, supports local desktop attachment, and supports authenticated remote attachment across the user's Tailscale tailnet.
- Remote control must preserve exact session identity, reconnect/replay semantics, capability authorization, and explicit destructive-action boundaries.

## Planned package boundaries

- `apps/desktop`: Electron main/preload, packaging, updates, OS integration.
- `apps/web`: T3-derived React renderer and desktop/web client shell.
- `packages/protocol`: install the checked-in relative app-wire tarball from `vendor/app-wire/`, verify its manifest/checksums, re-export it, and add desktop-only IPC schemas without redeclaring network frames.
- `packages/client`: connection, replay, cache, optimistic-state rules, host/session stores.
- `packages/ui`: T3-derived design primitives, tokens, icons, motion, virtualization.
- `packages/fixture-server`: deterministic seeded sessions, faults, and load scenarios.
- OMP `packages/app-wire`: sole versioned, dependency-free protocol authority with JSON-safe TypeScript types, executable decoders/guards, constants, and golden frames.
- OMP `packages/appserver`: persistent host service, RPC-child supervisor, local socket, remote endpoint, pairing, policy, replay, PTY, files, and audit.

## Proof standard

Behavior is proven with deterministic contract tests, concurrency and reconnect stress, seeded visual states, screenshot comparison, interaction/motion checks, Linux runtime proof, macOS runtime proof, and a real two-host Tailscale smoke before remote functionality is called complete.
