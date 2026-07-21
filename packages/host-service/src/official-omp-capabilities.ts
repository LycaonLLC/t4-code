import {
  boundedArray,
  boundedMap,
  controlFree,
  OPERATION_DISABLED_REASON_CODES,
  operationId,
  type OperationCapability,
  type OperationId,
} from "@t4-code/host-wire";

const MAX_AVAILABLE_COMMANDS = 1_000;
const MAX_COMMAND_ALIASES = 32;
const MAX_COMMAND_NAME_BYTES = 128;
const MAX_COMMAND_DESCRIPTION_BYTES = 4_096;
const MAX_COMMAND_SOURCE_BYTES = 64;

export const OFFICIAL_OMP_TERMINAL_ONLY_EVIDENCE = Object.freeze({
  packageVersion: "17.0.5",
  sourceCommit: "772e5e41eb1537177349247add96a851721c5bfa",
});

interface TerminalOnlyCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
}

/**
 * Commands omitted by official OMP's `get_available_commands` RPC because they
 * only have a TUI handler. Keep this manifest pinned to the reviewed OMP source
 * revision above; the headless discovery feed wins if a later OMP version makes
 * one of these commands executable over RPC.
 */
const TERMINAL_ONLY_COMMANDS: readonly TerminalOnlyCommand[] = Object.freeze([
  { name: "settings", description: "Open settings menu" },
  { name: "setup", aliases: ["providers"], description: "Open provider setup" },
  { name: "plan", description: "Toggle plan mode (agent plans before executing)" },
  { name: "plan-review", description: "Re-open the plan review for the latest plan" },
  { name: "vibe", description: "Toggle vibe mode" },
  { name: "goal", description: "Toggle goal mode" },
  { name: "guided-goal", description: "Interview and refine a goal before enabling goal mode" },
  { name: "loop", description: "Toggle loop mode" },
  { name: "queue", description: "Queue a message for after the agent yields" },
  { name: "switch", description: "Switch model for this session" },
  { name: "collab", description: "Share this session live via a relay" },
  { name: "join", description: "Join a shared collaboration session" },
  { name: "leave", description: "Leave the collaboration session" },
  { name: "copy", description: "Pick text or code from the conversation to copy" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "extensions", aliases: ["status"], description: "Open Extension Control Center" },
  { name: "agents", description: "Open Agent Control Center" },
  { name: "branch", description: "Create a new branch from a previous message" },
  { name: "fork", description: "Create a new fork from a previous message" },
  { name: "tree", description: "Navigate the session tree" },
  { name: "login", description: "Log in with an OAuth provider" },
  { name: "logout", description: "Log out from an OAuth provider" },
  { name: "new", aliases: ["clear"], description: "Start a new session" },
  { name: "drop", description: "Delete the current session and start a new one" },
  { name: "handoff", description: "Hand off context to a new session" },
  { name: "resume", description: "Resume a different session" },
  { name: "btw", description: "Ask an ephemeral side question" },
  { name: "tan", description: "Run a background agent on tangential work" },
  { name: "omfg", description: "Forge a TTSR rule from a complaint" },
  { name: "retry", description: "Retry the last failed agent turn" },
  { name: "debug", description: "Open debug tools selector" },
  { name: "exit", description: "Exit the application" },
  { name: "continue-in-t4", description: "Persist and continue this session in T4" },
  { name: "pause", description: "Freeze all agents until resumed" },
  { name: "quit", aliases: ["q"], description: "Quit the application" },
]);

interface HeadlessCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description?: string;
  readonly source: string;
}

export type OfficialOmpOperationRejectionCode = (typeof OPERATION_DISABLED_REASON_CODES)[
  | "terminalOnly"
  | "capabilityUnavailable"];

export class OfficialOmpOperationError extends Error {
  readonly operationId: OperationId;
  readonly code: OfficialOmpOperationRejectionCode;
  readonly execution: "terminal-only" | "unavailable";

  constructor(
    operation: OperationId,
    code: OfficialOmpOperationRejectionCode,
    execution: "terminal-only" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "OfficialOmpOperationError";
    this.operationId = operation;
    this.code = code;
    this.execution = execution;
  }
}

function slashName(value: unknown, path: string): string {
  const name = controlFree(value, path, MAX_COMMAND_NAME_BYTES);
  if (!/^[^\s/]+$/u.test(name)) throw new Error(`${path} must be a slash command name`);
  return name;
}

function decodeHeadlessCommands(value: unknown): readonly HeadlessCommand[] {
  const items = boundedArray(value, "available_commands_update.commands", MAX_AVAILABLE_COMMANDS);
  const commands: HeadlessCommand[] = [];
  const names = new Set<string>();
  for (let index = 0; index < items.length; index++) {
    const path = `available_commands_update.commands[${index}]`;
    const item = boundedMap(items[index], path, 16);
    const name = slashName(item.name, `${path}.name`);
    if (names.has(name)) throw new Error(`duplicate available command: ${name}`);
    names.add(name);
    const aliases = boundedArray(item.aliases ?? [], `${path}.aliases`, MAX_COMMAND_ALIASES).map(
      (alias, aliasIndex) => slashName(alias, `${path}.aliases[${aliasIndex}]`),
    );
    const description =
      item.description === undefined
        ? undefined
        : controlFree(item.description, `${path}.description`, MAX_COMMAND_DESCRIPTION_BYTES);
    const source = controlFree(item.source, `${path}.source`, MAX_COMMAND_SOURCE_BYTES);
    commands.push(Object.freeze({ name, aliases: Object.freeze(aliases), description, source }));
  }
  return Object.freeze(commands);
}

function promptSlashName(message: string): string | undefined {
  const text = message.trimStart();
  if (!text.startsWith("/")) return undefined;
  const end = text.search(/[\s:]/u);
  return text.slice(1, end === -1 ? undefined : end);
}

/** Normalizes official OMP capability frames and guards prompt dispatch. */
export class OfficialOmpCapabilityAdapter {
  #operations: readonly OperationCapability[];
  #operationsById = new Map<string, OperationCapability>();
  #promptOperations = new Map<string, OperationCapability>();

  constructor() {
    this.#operations = this.buildCatalog([]);
  }

  consume(frame: Readonly<Record<string, unknown>>): boolean {
    if (frame.type !== "available_commands_update") return false;
    this.update(frame.commands);
    return true;
  }

  /** Replace headless capabilities with one bounded official OMP discovery result. */
  update(commands: unknown): readonly OperationCapability[] {
    this.#operations = this.buildCatalog(decodeHeadlessCommands(commands));
    return this.#operations;
  }

  operations(): readonly OperationCapability[] {
    return this.#operations;
  }

  assertOperationSupported(id: string): OperationCapability {
    const capability = this.#operationsById.get(id);
    if (!capability) {
      const unavailableId = operationId(id);
      throw new OfficialOmpOperationError(
        unavailableId,
        OPERATION_DISABLED_REASON_CODES.capabilityUnavailable,
        "unavailable",
        `${id} is not exposed by this OMP runtime.`,
      );
    }
    if (!capability.supported) {
      throw new OfficialOmpOperationError(
        capability.operationId,
        OPERATION_DISABLED_REASON_CODES.terminalOnly,
        "terminal-only",
        capability.disabledReason?.message ??
          `${capability.label} requires the OMP terminal interface.`,
      );
    }
    return capability;
  }

  assertPromptSupported(message: string): OperationCapability | undefined {
    const name = promptSlashName(message);
    if (!name) return undefined;
    const capability = this.#promptOperations.get(name);
    if (capability && !capability.supported) this.assertOperationSupported(capability.operationId);
    return capability;
  }

  private buildCatalog(
    headlessCommands: readonly HeadlessCommand[],
  ): readonly OperationCapability[] {
    const operations: OperationCapability[] = [
      Object.freeze({
        operationId: operationId("session.prompt"),
        label: "Prompt",
        description: "Send a typed prompt to the active OMP session",
        execution: "typed",
        supported: true,
        metadata: Object.freeze({ rpcCommand: "prompt" }),
      }),
    ];
    const promptOperations = new Map<string, OperationCapability>();
    const headlessNames = new Set<string>();
    for (const command of headlessCommands) {
      const capability: OperationCapability = Object.freeze({
        operationId: operationId(`slash.${command.name}`),
        label: `/${command.name}`,
        ...(command.description ? { description: command.description } : {}),
        execution: "headless",
        supported: true,
        metadata: Object.freeze({ source: command.source, aliases: command.aliases }),
      });
      operations.push(capability);
      headlessNames.add(command.name);
      promptOperations.set(command.name, capability);
      for (const alias of command.aliases)
        if (!promptOperations.has(alias)) promptOperations.set(alias, capability);
    }
    for (const command of TERMINAL_ONLY_COMMANDS) {
      if (headlessNames.has(command.name)) continue;
      const capability: OperationCapability = Object.freeze({
        operationId: operationId(`slash.${command.name}`),
        label: `/${command.name}`,
        description: command.description,
        execution: "terminal-only",
        supported: false,
        disabledReason: Object.freeze({
          code: OPERATION_DISABLED_REASON_CODES.terminalOnly,
          message: `/${command.name} requires the OMP terminal interface.`,
        }),
        metadata: Object.freeze({
          aliases: Object.freeze([...(command.aliases ?? [])]),
          evidence: OFFICIAL_OMP_TERMINAL_ONLY_EVIDENCE,
        }),
      });
      operations.push(capability);
      if (!promptOperations.has(command.name)) promptOperations.set(command.name, capability);
      for (const alias of command.aliases ?? [])
        if (!promptOperations.has(alias)) promptOperations.set(alias, capability);
    }
    this.#operationsById = new Map(
      operations.map((capability) => [capability.operationId, capability]),
    );
    this.#promptOperations = promptOperations;
    return Object.freeze(operations);
  }
}
