// Docs content as plain data. Every fact here traces to shipped code or the
// current release contract; the renderer, search index, and navigation all
// derive from this one structure.

import {
  OMP_URL,
  RELEASE_ASSETS,
  RELEASE_TAG,
  RELEASE_VERSION,
  RELEASES_URL,
  REPO_URL,
} from "../release.ts";

export type Block =
  | { kind: "p"; text: string }
  | { kind: "h2"; id: string; text: string }
  | { kind: "h3"; id: string; text: string }
  | { kind: "code"; code: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "note"; text: string }
  | { kind: "table"; head: [string, string]; rows: [string, string][] };

export interface DocTopic {
  readonly id: string;
  readonly title: string;
  readonly lede: string;
  readonly blocks: readonly Block[];
}

export interface DocGroup {
  readonly title: string;
  readonly topics: readonly DocTopic[];
}

const linuxDeb = RELEASE_ASSETS[0]!;
const linuxAppImage = RELEASE_ASSETS[1]!;
const macDmg = RELEASE_ASSETS[2]!;
const macZip = RELEASE_ASSETS[3]!;

const install: DocTopic = {
  id: "install",
  title: "Install",
  lede: "T4 Code ships for Linux (x86_64) and macOS (Apple Silicon). Download from the GitHub release, install, and you are ready for first run.",
  blocks: [
    {
      kind: "p",
      text: `All downloads live on the [v${RELEASE_VERSION} release page](${RELEASES_URL}).`,
    },
    { kind: "h2", id: "install-linux", text: "Linux (x86_64)" },
    { kind: "p", text: "The `.deb` package is the smoothest path on Debian and Ubuntu:" },
    {
      kind: "code",
      code: `sudo apt install ./${linuxDeb.filename}`,
    },
    {
      kind: "p",
      text: "`apt install` resolves system dependencies for you; prefer it over `dpkg -i`.",
    },
    { kind: "p", text: "Or use the AppImage on any distribution:" },
    {
      kind: "code",
      code: `chmod +x ${linuxAppImage.filename}\n./${linuxAppImage.filename}`,
    },
    { kind: "h2", id: "install-macos", text: "macOS (Apple Silicon)" },
    {
      kind: "p",
      text: `Download the [.dmg](${macDmg.url}) (or the [.zip](${macZip.url})) and drag **T4 Code.app** into your Applications folder.`,
    },
    {
      kind: "note",
      text: `The v${RELEASE_VERSION} macOS build is unsigned and not notarized. Gatekeeper can report a damaged app or an unidentified developer. Only bypass that warning if you trust the release from this repository.`,
    },
    { kind: "h3", id: "install-gatekeeper", text: "First launch on macOS" },
    { kind: "p", text: "After copying the app into Applications, pick either route:" },
    {
      kind: "ol",
      items: [
        "If Finder offers it, right-click **T4 Code.app**, choose **Open**, then confirm the security prompt.",
        "If Gatekeeper still blocks it and you choose to proceed, clear the quarantine attribute in a terminal:",
      ],
    },
    {
      kind: "code",
      code: 'xattr -dr com.apple.quarantine "/Applications/T4 Code.app"',
    },
    {
      kind: "note",
      text: "The `xattr` command does not sign, notarize, or verify T4 Code. It only removes the quarantine attribute from the downloaded app.",
    },
    { kind: "h2", id: "install-requirements", text: "Requirements" },
    {
      kind: "p",
      text: `T4 Code is a desktop front end for [Oh My Pi](${OMP_URL}). You need an \`omp\` build with desktop appserver support installed on the machine that runs your sessions, either this one or a remote host you pair with. T4 Code v${RELEASE_VERSION} was tested against OMP 16.4.8 and vendors app-wire 0.5.1.`,
    },
  ],
};

const firstRun: DocTopic = {
  id: "first-run",
  title: "First run",
  lede: "On first launch, T4 Code finds your local Oh My Pi install and manages its app server for you.",
  blocks: [
    { kind: "h2", id: "first-run-discovery", text: "How T4 finds omp" },
    { kind: "p", text: "T4 Code checks these places, in order, and uses the first match:" },
    {
      kind: "ol",
      items: [
        "The `OMP_EXECUTABLE` environment variable",
        "Directories on your `PATH`",
        "`~/.local/bin/omp`",
        "`~/bin/omp`",
        "`/usr/local/bin/omp`",
        "`/usr/bin/omp`",
        "`/opt/omp/bin/omp`",
      ],
    },
    {
      kind: "p",
      text: "Before trusting a match, T4 runs `omp appserver status --json` and checks the answer. A build that cannot answer is skipped.",
    },
    { kind: "h2", id: "first-run-service", text: "Who keeps the app server running" },
    {
      kind: "p",
      text: "T4 Code registers the app server with your operating system so it stays up across restarts:",
    },
    {
      kind: "ul",
      items: [
        "**Linux**: a systemd user service. Logs: `~/.local/state/t4-code/appserver`.",
        "**macOS**: a launch agent. Logs: `~/Library/Logs/T4 Code/appserver`.",
      ],
    },
    {
      kind: "p",
      text: "Oh My Pi stays the source of truth the whole time. T4 Code shows you what the host reports; it never invents state of its own.",
    },
  ],
};

const localSessions: DocTopic = {
  id: "local-sessions",
  title: "Local sessions",
  lede: "Open projects, start sessions, and switch between them without losing your place.",
  blocks: [
    { kind: "h2", id: "local-sessions-create", text: "Start a session" },
    {
      kind: "p",
      text: "Pick a project and start a session, with an optional title. The session runs on the OMP host; T4 Code streams everything it does into the transcript.",
    },
    {
      kind: "p",
      text: "New session references retain the project name OMP reports. The rail does not replace that name with an opaque project ID while the new session is attaching.",
    },
    { kind: "h2", id: "local-sessions-switching", text: "Switching stays instant" },
    {
      kind: "p",
      text: "T4 Code keeps up to 8 recent sessions warm in the background. Their live output keeps applying while you are elsewhere, so switching back is instant. No reload, no replay, no duplicate output.",
    },
    {
      kind: "p",
      text: "Your draft message, scroll position, and open panels survive switching away and back.",
    },
    { kind: "h2", id: "local-sessions-disconnects", text: "Disconnects" },
    {
      kind: "p",
      text: "If the connection drops, T4 Code says so instead of pretending. Anything the host did not confirm is marked that way, and you can reconnect or keep reading what you already have.",
    },
  ],
};

const remotePairing: DocTopic = {
  id: "remote-pairing",
  title: "Remote pairing",
  lede: "Pair T4 Code with an Oh My Pi host on another machine and work with its sessions like local ones.",
  blocks: [
    { kind: "h2", id: "remote-pairing-pair", text: "Pair with a host" },
    {
      kind: "p",
      text: "Pairing uses a link from the host in this form:",
    },
    { kind: "code", code: "t4-code://pair/<host>/<code>" },
    {
      kind: "p",
      text: "Opening the link hands the pairing code to T4 Code. Once the host accepts, it appears in your host list and its projects and sessions load like local ones.",
    },
    { kind: "h2", id: "remote-pairing-credentials", text: "Where credentials live" },
    {
      kind: "p",
      text: "Device tokens and credentials are encrypted with your operating system's secure storage before they touch disk. Pairing refuses to proceed if that encryption is unavailable.",
    },
    { kind: "h2", id: "remote-pairing-reconnect", text: "Reconnecting" },
    {
      kind: "p",
      text: "When a remote connection drops, T4 Code retries on its own: up to 12 attempts with growing delays, capped at 10 seconds between tries. Settings you were editing stay staged locally until the host confirms them; nothing is sent blind during a drop.",
    },
    { kind: "h2", id: "remote-pairing-tailnet", text: "Phone access over a tailnet" },
    {
      kind: "p",
      text: "A source checkout can serve T4 Code to a phone through Tailscale Serve. This path has no T4 app password: Tailscale identity plus the tailnet ACLs or grants decide who can reach it. Keep it on Serve, never Funnel, and remember that every permitted identity can operate the connected OMP appserver.",
    },
    {
      kind: "p",
      text: `The v${RELEASE_VERSION} mobile test went through the Tailnet \`.ts.net\` HTTPS URL in a 320 × 568 touch browser. It reached connected state, created a session, selected a model, sent a prompt, received the reply, and kept exactly two durable transcript rows through five reloads. Follow the [Tailnet setup guide](${REPO_URL}/blob/${RELEASE_TAG}/docs/TAILNET_REMOTE.md) to install the source-hosted gateway.`,
    },
    {
      kind: "p",
      text: "The gateway pings each browser WebSocket every 30 seconds. A half-open tunnel that does not pong is terminated and removed from the active-session count within 60 seconds; responsive sessions stay connected.",
    },
  ],
};

const sessionControls: DocTopic = {
  id: "session-controls",
  title: "Session controls",
  lede: "Change the model, thinking effort, and fast mode of a running session. The host confirms every change.",
  blocks: [
    { kind: "h2", id: "session-controls-model", text: "Model" },
    {
      kind: "p",
      text: "The primary picker follows the connected OMP profile's `Ctrl+P` cycle in exact order instead of exposing the full catalog. On narrow touch screens, the menu has a bounded vertical scroller. The profile used in the mobile test exposed six choices: Luna 5.6, Opus 4.6, Fable 5, GPT 5.6 Sol, Kimi K2.7, and Grok 4.5.",
    },
    {
      kind: "p",
      text: "Model, thinking, and fast-mode changes finish before an immediately submitted prompt reads the next host revision. This preserves command order when you pick a model and tap Send without waiting.",
    },
    { kind: "h2", id: "session-controls-thinking", text: "Thinking effort" },
    {
      kind: "p",
      text: "Thinking effort levels, from least to most: `auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.",
    },
    { kind: "h2", id: "session-controls-fast", text: "Fast mode" },
    {
      kind: "p",
      text: "Fast mode is a single toggle. Like every other control, the value you see is the host's last confirmed value, not a local guess.",
    },
    { kind: "h2", id: "session-controls-slash", text: "Slash commands" },
    {
      kind: "p",
      text: "Type `/` in the composer to see what the current host supports:",
    },
    {
      kind: "table",
      head: ["Command", "What it does"],
      rows: [
        ["/compact", "Compact the session context (alias: /compress)"],
        ["/context", "Show context usage (alias: /usage)"],
        ["/model", "Change the session model"],
        ["/plan", "Ask for a plan first (alias: /think)"],
        ["/retry", "Retry the last turn (alias: /again)"],
        ["/review", "Review pending changes (alias: /diff)"],
        ["/terminal", "Open a terminal (aliases: /term, /sh)"],
        ["/title", "Rename the session (alias: /rename)"],
      ],
    },
    {
      kind: "p",
      text: "Commands the host cannot run show up disabled with a short reason. For example, `/terminal` needs terminal access on that host.",
    },
  ],
};

const agents: DocTopic = {
  id: "agents",
  title: "Agents",
  lede: "Watch the agents a session spawns, see what each one is doing, and stop one when you need to.",
  blocks: [
    { kind: "h2", id: "agents-pane", text: "The agents pane" },
    {
      kind: "p",
      text: "Sessions can fan work out to agents. The agents pane shows them as they run, so long work stays legible instead of scrolling past in one stream.",
    },
    { kind: "h2", id: "agents-cancel", text: "Cancel an agent" },
    {
      kind: "p",
      text: "You can cancel a running agent from the pane. The cancel goes to the host, and the pane reflects what the host confirms.",
    },
    { kind: "h2", id: "agents-limits", text: "What hosts do not support yet" },
    {
      kind: "p",
      text: "Current hosts cannot take a note for a single agent or wake an agent from the pane. When a host cannot do something, T4 Code shows the action disabled with the reason. It never fakes a control.",
    },
  ],
};

const panes: DocTopic = {
  id: "terminals-files-review",
  title: "Terminals, files & review",
  lede: "Attach to live terminals, browse project files, and apply reviewed changes, all through the host.",
  blocks: [
    { kind: "h2", id: "panes-terminals", text: "Terminals" },
    {
      kind: "p",
      text: "The terminals pane attaches to real terminal sessions on the host. Typing, resizing, and closing all go through the host. T4 Code never scrapes terminal output and never types into a shell an agent owns.",
    },
    { kind: "h2", id: "panes-files", text: "Files" },
    {
      kind: "p",
      text: "Browse folders and preview files when the host supports it. On hosts without file access, T4 Code shows what the session has already streamed and says plainly when it cannot read more.",
    },
    { kind: "h2", id: "panes-review", text: "Review" },
    {
      kind: "p",
      text: "The review pane shows pending changes as diffs. You can apply a reviewed change from the pane. Discarding a change from the app is not supported by current hosts, and the button says so instead of pretending.",
    },
  ],
};

const settings: DocTopic = {
  id: "settings-model-roles",
  title: "Settings & model roles",
  lede: "Oh My Pi owns its settings. T4 Code gives you a safe editor: you stage changes, the host confirms them.",
  blocks: [
    { kind: "h2", id: "settings-ownership", text: "How saving works" },
    {
      kind: "p",
      text: "Settings load from the connected host and save back to it. If the connection drops before the host confirms a save, your edits stay staged locally; check the host before saving again. There is no hidden second settings store.",
    },
    { kind: "h2", id: "settings-roles", text: "Model roles" },
    {
      kind: "p",
      text: "Roles let you name a job and give it a model. Built-in roles: `default`, `smol` (Fast), `slow` (Thinking), `vision`, `plan` (Architect), `designer`, `commit`, `tiny`, `task` (Subtask), and `advisor`. Each role maps to a model from the host's catalog or to another role, and can carry its own thinking level.",
    },
    { kind: "h2", id: "settings-cycle", text: "Quick-switch cycle" },
    {
      kind: "p",
      text: "The cycle order lists the roles you flip between with `Ctrl+P` in OMP. T4 Code uses that same ordered list for the session model picker, so models outside the cycle stay in advanced settings instead of filling the high-frequency menu.",
    },
    { kind: "h2", id: "settings-task-agents", text: "Task agents" },
    {
      kind: "p",
      text: "For each agent kind you can set an ordered fallback chain of models, or disable the agent entirely. T4 Code warns you when an override points at an agent the host no longer reports.",
    },
  ],
};

const shortcuts: DocTopic = {
  id: "keyboard-shortcuts",
  title: "Keyboard shortcuts",
  lede: "Everything reachable by mouse is reachable by keyboard. `Cmd` on macOS, `Ctrl` on Linux.",
  blocks: [
    { kind: "h2", id: "shortcuts-app", text: "App" },
    {
      kind: "table",
      head: ["Keys", "Action"],
      rows: [
        ["Cmd/Ctrl + K", "Open the search palette"],
        ["Cmd/Ctrl + B", "Collapse or expand the session rail"],
        ["Cmd/Ctrl + ,", "Open Settings"],
        ["Cmd/Ctrl + 1…9", "Jump to a session by its position in the rail"],
        ["Escape", "Close the session's right pane (when nothing else is open)"],
      ],
    },
    { kind: "h2", id: "shortcuts-rail", text: "Session rail" },
    {
      kind: "table",
      head: ["Keys", "Action"],
      rows: [
        ["Arrow Up / Arrow Down", "Move between session rows"],
        ["Home / End", "Jump to the first or last session"],
      ],
    },
    { kind: "h2", id: "shortcuts-composer", text: "Composer" },
    {
      kind: "table",
      head: ["Keys", "Action"],
      rows: [
        ["Enter", "Send"],
        ["Shift/Alt/Ctrl/Cmd + Enter", "New line"],
        ["Escape", "Cancel plan revision (when active)"],
        ["Arrow Up / Arrow Down", "Move through the slash-command menu"],
        ["Enter / Tab", "Run the highlighted slash command"],
        ["1…9", "Pick an option when the session asks a question"],
      ],
    },
    { kind: "h2", id: "shortcuts-terminals", text: "Terminals" },
    {
      kind: "table",
      head: ["Keys", "Action"],
      rows: [
        ["Ctrl + Shift + Arrows", "Move focus between split terminal panes"],
        ["Arrow Left / Arrow Right", "Move between terminal tabs"],
        ["Home / End", "First or last terminal tab"],
      ],
    },
  ],
};

const troubleshooting: DocTopic = {
  id: "troubleshooting",
  title: "Troubleshooting",
  lede: "What the messages mean and what to do about them.",
  blocks: [
    { kind: "h2", id: "troubleshooting-appserver", text: "\u201cApp Server Unavailable\u201d" },
    {
      kind: "p",
      text: "The app server is not answering. Check that `omp` is installed and healthy:",
    },
    { kind: "code", code: "omp appserver status --json" },
    {
      kind: "p",
      text: "If that fails, look at the logs: `~/.local/state/t4-code/appserver` on Linux, `~/Library/Logs/T4 Code/appserver` on macOS. If `omp` is installed somewhere unusual, point T4 Code at it with the `OMP_EXECUTABLE` environment variable.",
    },
    { kind: "h2", id: "troubleshooting-connection", text: "\u201cConnection Lost\u201d / \u201cNo Connection\u201d" },
    {
      kind: "p",
      text: "The link to the app server (or the network) dropped. You can reconnect right away or keep working offline with what already streamed in. Remote hosts reconnect on their own; local ones restart with the service manager.",
    },
    { kind: "h2", id: "troubleshooting-declined", text: "\u201cThe host declined…\u201d" },
    {
      kind: "p",
      text: "A control change (model, thinking, fast mode) was refused by the host. The session keeps its current value. This is the host's decision, not a bug in the app.",
    },
    { kind: "h2", id: "troubleshooting-mac", text: "macOS says the app is damaged" },
    {
      kind: "p",
      text: "That is Gatekeeper reacting to the unsigned build, not real damage. Follow the [first-launch steps](#install-gatekeeper): right-click → Open, or clear the quarantine flag with `xattr -dr com.apple.quarantine`.",
    },
    { kind: "h2", id: "troubleshooting-settings", text: "Settings never load" },
    {
      kind: "p",
      text: "If a host connects but its settings never appear, it may be running an Oh My Pi build without desktop settings support. Update `omp` on that host.",
    },
  ],
};

const security: DocTopic = {
  id: "security",
  title: "Security",
  lede: "Plain answers about what T4 Code stores, sends, and never does.",
  blocks: [
    { kind: "h2", id: "security-unsigned", text: "The unsigned macOS build" },
    {
      kind: "p",
      text: `The v${RELEASE_VERSION} macOS build is unsigned and not notarized, so macOS warns before first launch. Clearing \`com.apple.quarantine\` changes Gatekeeper handling but does not sign, notarize, or verify the app. If you would rather not trust a downloaded binary, [build from source](#build-from-source). The repository is public at [LycaonLLC/t4-code](${REPO_URL}).`,
    },
    { kind: "h2", id: "security-credentials", text: "Credentials" },
    {
      kind: "p",
      text: "Remote host tokens are encrypted with the operating system's secure storage before being written to disk. If that encryption is not available, pairing refuses to store anything.",
    },
    { kind: "h2", id: "security-truth", text: "Runtime truth" },
    {
      kind: "p",
      text: "Everything you see comes from the Oh My Pi host over a typed protocol. T4 Code never fabricates state, never scrapes terminals, and marks unconfirmed actions as unconfirmed instead of guessing.",
    },
    { kind: "h2", id: "security-site", text: "This website" },
    {
      kind: "p",
      text: "t4code.net is a static site. It loads no third-party scripts, no analytics, and no trackers; fonts are bundled with the site.",
    },
  ],
};

const buildFromSource: DocTopic = {
  id: "build-from-source",
  title: "Build from source",
  lede: "The whole app builds from the public repository with Node and pnpm.",
  blocks: [
    { kind: "h2", id: "build-prereqs", text: "Prerequisites" },
    {
      kind: "ul",
      items: ["Node.js 24.13.1 or newer", "pnpm 11"],
    },
    { kind: "h2", id: "build-steps", text: "Build" },
    {
      kind: "code",
      code: `git clone ${REPO_URL}.git\ncd t4-code\npnpm install\npnpm build`,
    },
    { kind: "h2", id: "build-package", text: "Package installers" },
    { kind: "code", code: "pnpm package:linux" },
    {
      kind: "p",
      text: "On a Mac, `pnpm package:mac:unsigned` produces the same unsigned build we ship. Installers land in `release/`.",
    },
  ],
};

export const DOC_GROUPS: readonly DocGroup[] = [
  { title: "Get started", topics: [install, firstRun] },
  { title: "Work", topics: [localSessions, sessionControls, agents, panes] },
  { title: "Connect", topics: [remotePairing, settings] },
  { title: "Reference", topics: [shortcuts, troubleshooting, security, buildFromSource] },
];

export const DOC_TOPICS: readonly DocTopic[] = DOC_GROUPS.flatMap((g) => [...g.topics]);

export const DEFAULT_TOPIC_ID = install.id;

/** Map every anchorable id (topic ids + heading ids) to its owning topic. */
export function buildAnchorIndex(topics: readonly DocTopic[]): Map<string, DocTopic> {
  const index = new Map<string, DocTopic>();
  for (const topic of topics) {
    index.set(topic.id, topic);
    for (const block of topic.blocks) {
      if (block.kind === "h2" || block.kind === "h3") {
        index.set(block.id, topic);
      }
    }
  }
  return index;
}

export const ANCHOR_INDEX = buildAnchorIndex(DOC_TOPICS);

/** Resolve a location hash (with or without "#") to the topic that owns it. */
export function resolveTopicForHash(hash: string): DocTopic | undefined {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  if (id.length === 0) return undefined;
  return ANCHOR_INDEX.get(decodeURIComponent(id));
}
