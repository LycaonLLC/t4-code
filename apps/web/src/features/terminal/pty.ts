// User-PTY bridge: the seam between the terminal drawer and whatever hosts
// the real shells. The native shell injects a wire-backed bridge (see wire.ts) that
// speaks app-wire 0.4 `term.open` (cwd optional, relative to the project
// root) / `terminal.input` / `terminal.resize` /
// `terminal.close` and consumes `terminal.output` / `terminal.exit`; until
// then the fixture bridge provides a deterministic local sample shell.
// User PTYs only — agent-owned shells are read-only evidence in
// Activity/Terminals and this bridge refuses to open them.

export interface PtyOpenRequest {
  readonly sessionId: string;
  readonly terminalId: string;
  readonly shell: string;
  readonly cwd: string | null;
  readonly cols: number;
  readonly rows: number;
}

export interface PtyExit {
  readonly code: number;
  /** Signal name (e.g. "TERM") when the shell was killed rather than exiting. */
  readonly signal: string | null;
}

export type PtyErrorKind = "permission-denied" | "shell-error";

export interface PtyError {
  readonly kind: PtyErrorKind;
  /** Safe, human-readable message. Never contains user input or secrets. */
  readonly message: string;
}

/** Out-of-band conditions the surface should mark in scrollback. */
export type PtyNotice = "output-skipped" | "resumed";

export interface PtySession {
  readonly terminalId: string;
  /**
   * Send input bytes. Returns false when the transport is saturated and the
   * chunk was NOT accepted — the caller must hold it and retry after drain.
   */
  write(data: string): boolean;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Output chunks, in transport order. Returns an unsubscribe. */
  onData(listener: (chunk: string) => void): () => void;
  onExit(listener: (exit: PtyExit) => void): () => void;
  /** Fired when a saturated transport can accept input again. */
  onDrain(listener: () => void): () => void;
  /** Terminal became unusable (open refused, transport fault). */
  onError(listener: (error: PtyError) => void): () => void;
  /** Reconnect boundaries and transient output drops. */
  onNotice(listener: (notice: PtyNotice) => void): () => void;
}

export interface UserPtyBridge {
  readonly kind: "fixture" | "desktop";
  /** Throws when asked to open an agent-owned terminal id. */
  open(request: PtyOpenRequest): PtySession;
}

interface Listeners {
  readonly data: Set<(chunk: string) => void>;
  readonly exit: Set<(exit: PtyExit) => void>;
  readonly drain: Set<() => void>;
  readonly error: Set<(error: PtyError) => void>;
  readonly notice: Set<(notice: PtyNotice) => void>;
}

const PROMPT = "$ ";

/** Exit codes the fixture reports for `signal <NAME>`. */
const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  HUP: 129,
  INT: 130,
  QUIT: 131,
  KILL: 137,
  TERM: 143,
};

/**
 * Deterministic sample shell: echoes lines, runs a small canned command
 * table, and never touches the real system. Every byte of output is a pure
 * function of the input bytes and the resize history — tests rely on it.
 */
export class FixturePtySession implements PtySession {
  readonly terminalId: string;
  private readonly cwd: string;
  private cols: number;
  private rows: number;
  private line = "";
  private exited = false;
  private rejectNextWrites = 0;
  private readonly listeners: Listeners = {
    data: new Set(),
    exit: new Set(),
    drain: new Set(),
    error: new Set(),
    notice: new Set(),
  };

  constructor(request: PtyOpenRequest) {
    this.terminalId = request.terminalId;
    this.cwd = request.cwd ?? ".";
    this.cols = request.cols;
    this.rows = request.rows;
    queueMicrotask(() => {
      if (this.exited) return;
      this.emitData(
        `OMP sample shell — deterministic fixture, not a real terminal.\r\nType help to list commands.\r\n${PROMPT}`,
      );
    });
  }

  write(data: string): boolean {
    if (this.exited) return true;
    if (this.rejectNextWrites > 0) {
      this.rejectNextWrites -= 1;
      if (this.rejectNextWrites === 0) {
        queueMicrotask(() => {
          for (const listener of this.listeners.drain) listener();
        });
      }
      return false;
    }
    for (const char of data) {
      if (char === "\r" || char === "\n") {
        this.emitData("\r\n");
        this.runLine(this.line);
        this.line = "";
        if (!this.exited) this.emitData(PROMPT);
      } else if (char === "\u007f") {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.emitData("\b \b");
        }
      } else if (char >= " ") {
        this.line += char;
        this.emitData(char);
      }
    }
    return true;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  kill(): void {
    this.exit(130, null);
  }

  onData(listener: (chunk: string) => void): () => void {
    this.listeners.data.add(listener);
    return () => this.listeners.data.delete(listener);
  }

  onExit(listener: (exit: PtyExit) => void): () => void {
    this.listeners.exit.add(listener);
    return () => this.listeners.exit.delete(listener);
  }

  onDrain(listener: () => void): () => void {
    this.listeners.drain.add(listener);
    return () => this.listeners.drain.delete(listener);
  }

  onError(listener: (error: PtyError) => void): () => void {
    this.listeners.error.add(listener);
    return () => this.listeners.error.delete(listener);
  }

  onNotice(listener: (notice: PtyNotice) => void): () => void {
    this.listeners.notice.add(listener);
    return () => this.listeners.notice.delete(listener);
  }

  /** Fixture-only: refuse the next `count` writes, then signal drain. */
  simulateBackpressure(count: number): void {
    this.rejectNextWrites = count;
  }

  private emitData(chunk: string): void {
    for (const listener of this.listeners.data) listener(chunk);
  }

  private emitError(error: PtyError): void {
    for (const listener of this.listeners.error) listener(error);
  }

  private exit(code: number, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.listeners.exit) listener({ code, signal });
  }

  private runLine(rawLine: string): void {
    const line = rawLine.trim();
    if (line.length === 0) return;
    const parts = line.split(/\s+/);
    const command = parts[0] ?? "";
    const args = parts.slice(1);
    switch (command) {
      case "help":
        this.emitData(
          "Sample commands: help, pwd, ls, echo <text>, size, lines <n>,\r\n" +
            "exit [code], signal <NAME>, stall <n>, deny, crash\r\n",
        );
        break;
      case "pwd":
        this.emitData(`${this.cwd}\r\n`);
        break;
      case "ls":
        this.emitData("packages  docs  package.json  README.md\r\n");
        break;
      case "echo":
        this.emitData(`${args.join(" ")}\r\n`);
        break;
      case "size":
        this.emitData(`${this.cols} cols × ${this.rows} rows\r\n`);
        break;
      case "lines": {
        const count = Math.min(Math.max(Number.parseInt(args[0] ?? "10", 10) || 10, 1), 1_000);
        for (let index = 1; index <= count; index++) {
          this.emitData(`line ${index} of ${count}\r\n`);
        }
        break;
      }
      case "exit": {
        const code = Number.parseInt(args[0] ?? "0", 10);
        this.exit(Number.isSafeInteger(code) ? code : 0, null);
        break;
      }
      case "signal": {
        const name = (args[0] ?? "TERM").toUpperCase();
        this.exited = true;
        for (const listener of this.listeners.exit) {
          listener({ code: SIGNAL_EXIT_CODES[name] ?? 137, signal: name });
        }
        break;
      }
      case "stall": {
        // QA switch: reject the next <n> writes, then signal drain — lets
        // screenshots and manual testing exercise the backpressure path.
        const count = Math.min(Math.max(Number.parseInt(args[0] ?? "3", 10) || 3, 1), 100);
        this.emitData(`refusing the next ${count} writes\r\n`);
        this.rejectNextWrites = count;
        break;
      }
      case "deny": {
        // QA switch: what a capability refusal from the host looks like.
        this.exited = true;
        this.emitError({
          kind: "permission-denied",
          message: "The host didn't allow this shell.",
        });
        break;
      }
      case "crash": {
        // QA switch: what a transport/shell fault looks like.
        this.exited = true;
        this.emitError({
          kind: "shell-error",
          message: "The shell stopped responding.",
        });
        break;
      }
      default:
        this.emitData(`command not found: ${command} (sample shell — try help)\r\n`);
    }
  }
}

export interface CreateFixtureBridgeOptions {
  /** Terminal ids owned by agents; opening one is a programming error. */
  readonly agentOwnedTerminalIds: readonly string[];
}

export function createFixturePtyBridge(options: CreateFixtureBridgeOptions): UserPtyBridge {
  const agentOwned = new Set(options.agentOwnedTerminalIds);
  return {
    kind: "fixture",
    open(request) {
      if (agentOwned.has(request.terminalId)) {
        throw new Error(
          `Refusing to open agent-owned shell "${request.terminalId}" as a user terminal. Agent shells are read-only.`,
        );
      }
      return new FixturePtySession(request);
    },
  };
}
