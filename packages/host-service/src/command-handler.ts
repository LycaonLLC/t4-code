import type { CommandFrame } from "@t4-code/host-wire";
import type { CommandOutcome } from "./types.ts";

/** Local extension seam: later Wave handlers register without editing the dispatcher. */
export type AppserverCommandHandler = (command: CommandFrame) => Promise<CommandOutcome> | CommandOutcome;

export class AppserverCommandHandlers {
	readonly #handlers = new Map<string, AppserverCommandHandler>();

	register(command: string, handler: AppserverCommandHandler): void {
		if (this.#handlers.has(command)) throw new Error(`duplicate appserver command handler: ${command}`);
		this.#handlers.set(command, handler);
	}

	has(command: string): boolean {
		return this.#handlers.has(command);
	}

	async dispatch(command: CommandFrame): Promise<CommandOutcome | undefined> {
		const handler = this.#handlers.get(command.command);
		return handler ? await handler(command) : undefined;
	}
}
