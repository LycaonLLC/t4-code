/**
 * The narrow part of OMP's JSON RPC stream that the T4 host consumes.
 *
 * These are structural wire types, not imports from OMP's private source tree.
 * Keeping them here prevents the T4-owned host from acquiring a build-time
 * dependency on `packages/coding-agent/src/**`. Runtime adapters must validate
 * untrusted frames before they reach the host projections.
 */

export type RpcResponse =
	| {
			type: "response";
			command: string;
			success: true;
			id?: string;
			data?: unknown;
			error?: never;
	  }
	| {
			type: "response";
			command: string;
			success: false;
			id?: string;
			error: string;
			data?: never;
	  };

export type RpcAvailableSlashCommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: RpcAvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}

export type RpcSessionEntry =
	| {
			type: "message";
			message: { role: string; clientCorrelationId?: string; [key: string]: unknown };
			[key: string]: unknown;
	  }
	| {
			type: "custom_message";
			attribution?: string;
			clientCorrelationId?: string;
			[key: string]: unknown;
	  };

export interface RpcSessionEntryFrame {
	type: "session_entry";
	entry: RpcSessionEntry;
}

export interface RpcSubagentMessagesResult {
	sessionFile?: string;
	fromByte: number;
	nextByte: number;
	reset?: boolean;
	entries: unknown[];
	messages?: unknown[];
}

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	description?: string;
	status: string;
	task?: string;
	lastUpdate: number;
	resumable?: boolean;
	progress?: Record<string, unknown>;
}

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: {
		id?: unknown;
		index?: unknown;
		agent?: unknown;
		description?: unknown;
		status?: unknown;
		task?: unknown;
		lastUpdate?: unknown;
		resumable?: unknown;
		[key: string]: unknown;
	};
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: {
		index?: unknown;
		agent?: unknown;
		task?: unknown;
		resumable?: unknown;
		progress?: unknown;
		[key: string]: unknown;
	};
}

export type AgentSessionEventType =
	| "agent_start"
	| "agent_end"
	| "turn_start"
	| "turn_end"
	| "message_start"
	| "message_update"
	| "message_end"
	| "message_persisted"
	| "tool_execution_start"
	| "tool_execution_update"
	| "tool_execution_end"
	| "auto_compaction_start"
	| "auto_compaction_end"
	| "auto_retry_start"
	| "auto_retry_end"
	| "retry_fallback_applied"
	| "retry_fallback_succeeded"
	| "ttsr_triggered"
	| "todo_reminder"
	| "todo_auto_clear"
	| "irc_message"
	| "notice"
	| "thinking_level_changed"
	| "goal_updated";

export type AgentSessionEvent = {
	[Type in AgentSessionEventType]: { type: Type } & Record<string, unknown>;
}[AgentSessionEventType];

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: {
		id?: unknown;
		event?: unknown;
		[key: string]: unknown;
	};
}

export type RpcSessionEventFrame =
	| AgentSessionEvent
	| RpcSessionEntryFrame
	| RpcSubagentLifecycleFrame
	| RpcSubagentProgressFrame
	| RpcSubagentEventFrame;
