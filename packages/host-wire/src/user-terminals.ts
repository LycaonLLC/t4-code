import { boundedMap, controlFree, inputObject } from "./guards.js";
import { type HostId, hostId, type SessionId, sessionId, type TerminalId, terminalId } from "./ids.js";
export interface UserTerminal {
	terminalId: TerminalId;
	hostId: HostId;
	sessionId: SessionId;
	shell: string;
	cwd?: string;
	env?: Record<string, string>;
}
export function decodeUserTerminal(input: unknown, path = "terminal"): UserTerminal {
	const terminal = path === "terminal" ? inputObject(input) : boundedMap(input, path);
	terminalId(terminal.terminalId, `${path}.terminalId`);
	hostId(terminal.hostId, `${path}.hostId`);
	sessionId(terminal.sessionId, `${path}.sessionId`);
	controlFree(terminal.shell, `${path}.shell`, 256);
	if (terminal.cwd !== undefined) controlFree(terminal.cwd, `${path}.cwd`, 4096);
	if (terminal.env !== undefined) {
		const env = boundedMap(terminal.env, `${path}.env`);
		for (const [key, entry] of Object.entries(env)) controlFree(entry, `${path}.env.${key}`, 8192);
	}
	return terminal as unknown as UserTerminal;
}
