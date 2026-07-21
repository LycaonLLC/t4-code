import {
	PROJECT_FILE_SEARCH_DEFAULT_LIMIT,
	PROJECT_FILE_SEARCH_MAX_RESULTS,
	type ProjectFileSearchArguments,
	type ProjectFileSearchResult,
	type SessionId,
} from "@t4-code/host-wire";
import { spawn } from "node:child_process";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DesktopOperationsAuthority, OperationContext } from "./operations/dispatcher.ts";

const SEARCH_TIMEOUT_MS = 2_000;
const MAX_ENUMERATED_PATHS = 50_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_CANDIDATES = PROJECT_FILE_SEARCH_MAX_RESULTS * 8;
const SKIPPED_SEGMENTS = new Set([".git", "node_modules"]);

interface RankedPath {
	readonly path: string;
	readonly score: number;
}

interface EnumerationResult {
	readonly available: boolean;
	readonly incomplete: boolean;
}

export interface ProjectFileSearchOptions {
	readonly timeoutMs?: number;
	readonly maxEnumeratedPaths?: number;
	readonly maxGitOutputBytes?: number;
}

function operationError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function ensureActive(signal: AbortSignal): void {
	if (signal.aborted) throw operationError("ABORTED", "operation was cancelled");
}

function safeCandidatePath(path: string): boolean {
	if (path.length === 0 || path.length > 4096 || path.includes("\0") || path.startsWith("/")) return false;
	if ([...path].some(character => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 0x1f || code === 0x7f;
	})) return false;
	const segments = path.split("/");
	return !segments.some(segment => segment === "" || segment === "." || segment === ".." || SKIPPED_SEGMENTS.has(segment));
}

function subsequenceScore(value: string, query: string): number | null {
	let cursor = 0;
	let gap = 0;
	for (const character of query) {
		const index = value.indexOf(character, cursor);
		if (index < 0) return null;
		gap += index - cursor;
		cursor = index + 1;
	}
	return gap;
}

function pathScore(path: string, query: string): number | null {
	const normalizedPath = path.toLowerCase();
	const name = basename(normalizedPath);
	if (name === query) return 0;
	if (name.startsWith(query)) return 10 + name.length - query.length;
	const nameIndex = name.indexOf(query);
	if (nameIndex >= 0) return 100 + nameIndex * 2 + name.length - query.length;
	const pathIndex = normalizedPath.indexOf(query);
	if (pathIndex >= 0) return 250 + pathIndex + normalizedPath.length - query.length;
	const nameFuzzy = subsequenceScore(name, query);
	if (nameFuzzy !== null) return 500 + nameFuzzy * 4 + name.length;
	const pathFuzzy = subsequenceScore(normalizedPath, query);
	return pathFuzzy === null ? null : 800 + pathFuzzy * 4 + normalizedPath.length;
}

function compareRanked(left: RankedPath, right: RankedPath): number {
	return left.score - right.score || left.path.localeCompare(right.path);
}

class CandidateCollector {
	readonly #query: string;
	readonly #retained: RankedPath[] = [];
	#matches = 0;

	constructor(query: string) {
		this.#query = query.toLowerCase();
	}

	add(path: string): void {
		if (!safeCandidatePath(path)) return;
		const score = pathScore(path, this.#query);
		if (score === null) return;
		this.#matches += 1;
		this.#retained.push({ path, score });
		if (this.#retained.length > MAX_RETAINED_CANDIDATES) {
			this.#retained.sort(compareRanked);
			this.#retained.length = MAX_RETAINED_CANDIDATES;
		}
	}

	async result(root: string, limit: number, incomplete: boolean, signal: AbortSignal): Promise<ProjectFileSearchResult> {
		this.#retained.sort(compareRanked);
		const matches: { path: string }[] = [];
		let validMatches = 0;
		for (const candidate of this.#retained) {
			ensureActive(signal);
			try {
				const metadata = await lstat(join(root, ...candidate.path.split("/")));
				if (!metadata.isFile()) continue;
			} catch {
				continue;
			}
			validMatches += 1;
			if (matches.length < limit) matches.push({ path: candidate.path });
		}
		return {
			matches,
			truncated:
				incomplete || validMatches > matches.length || this.#matches > this.#retained.length,
		};
	}
}

function enumerateGit(
	root: string,
	collector: CandidateCollector,
	signal: AbortSignal,
	options: Required<ProjectFileSearchOptions>,
): Promise<EnumerationResult> {
	return new Promise((resolveResult, reject) => {
		const child = spawn(
			"git",
			["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z", "--", "."],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		let pending = Buffer.alloc(0);
		let outputBytes = 0;
		let pathCount = 0;
		let forcedIncomplete = false;
		let settled = false;
		const finish = (result: EnumerationResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			resolveResult(result);
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			reject(error);
		};
		const stopIncomplete = (): void => {
			forcedIncomplete = true;
			child.kill("SIGTERM");
		};
		const onAbort = (): void => {
			child.kill("SIGTERM");
			fail(operationError("ABORTED", "operation was cancelled"));
		};
		const timeout = setTimeout(stopIncomplete, options.timeoutMs);
		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			if (settled || forcedIncomplete) return;
			outputBytes += chunk.length;
			if (outputBytes > options.maxGitOutputBytes) {
				stopIncomplete();
				return;
			}
			pending = Buffer.concat([pending, chunk]);
			let separator = pending.indexOf(0);
			while (separator >= 0) {
				collector.add(pending.subarray(0, separator).toString("utf8"));
				pathCount += 1;
				pending = pending.subarray(separator + 1);
				if (pathCount >= options.maxEnumeratedPaths) {
					stopIncomplete();
					return;
				}
				separator = pending.indexOf(0);
			}
			if (pending.length > 4096) stopIncomplete();
		});
		child.once("error", () => finish({ available: false, incomplete: false }));
		child.once("close", code => {
			if (signal.aborted) return;
			if (forcedIncomplete) {
				finish({ available: true, incomplete: true });
				return;
			}
			finish({ available: code === 0, incomplete: false });
		});
	});
}

async function enumerateDirectory(
	root: string,
	collector: CandidateCollector,
	signal: AbortSignal,
	options: Required<ProjectFileSearchOptions>,
): Promise<boolean> {
	const deadline = Date.now() + options.timeoutMs;
	const directories = [""];
	let paths = 0;
	while (directories.length > 0) {
		ensureActive(signal);
		if (Date.now() >= deadline || paths >= options.maxEnumeratedPaths) return true;
		const current = directories.pop();
		if (current === undefined) break;
		let directory;
		try {
			directory = await opendir(current === "" ? root : join(root, ...current.split("/")));
		} catch {
			continue;
		}
		for await (const entry of directory) {
			ensureActive(signal);
			if (Date.now() >= deadline || paths >= options.maxEnumeratedPaths) return true;
			if (SKIPPED_SEGMENTS.has(entry.name) || entry.isSymbolicLink()) continue;
			const path = current === "" ? entry.name : `${current}/${entry.name}`;
			paths += 1;
			if (entry.isDirectory()) directories.push(path);
			else if (entry.isFile()) collector.add(path);
		}
	}
	return false;
}

async function canonicalProjectRoot(root: string): Promise<string> {
	const canonical = await realpath(root).catch(() => {
		throw operationError("NOT_FOUND", "project root was not found");
	});
	const metadata = await stat(canonical).catch(() => {
		throw operationError("NOT_FOUND", "project root was not found");
	});
	if (!metadata.isDirectory()) throw operationError("NOT_FOUND", "project root was not found");
	return canonical;
}

export class ProjectFileSearchAuthority {
	readonly #active = new Map<string, AbortController>();
	readonly #options: Required<ProjectFileSearchOptions>;

	constructor(
		private readonly projectRootForSession: (sessionId: SessionId) => Promise<string>,
		options: ProjectFileSearchOptions = {},
	) {
		this.#options = {
			timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
			maxEnumeratedPaths: options.maxEnumeratedPaths ?? MAX_ENUMERATED_PATHS,
			maxGitOutputBytes: options.maxGitOutputBytes ?? MAX_GIT_OUTPUT_BYTES,
		};
	}

	async search(args: ProjectFileSearchArguments, context: OperationContext): Promise<ProjectFileSearchResult> {
		const sessionId = context.sessionId;
		if (sessionId === undefined) throw operationError("NOT_FOUND", "session was not found");
		const previous = this.#active.get(sessionId);
		previous?.abort();
		const controller = new AbortController();
		this.#active.set(sessionId, controller);
		const onContextAbort = (): void => controller.abort();
		context.abortSignal.addEventListener("abort", onContextAbort, { once: true });
		try {
			ensureActive(controller.signal);
			const root = await canonicalProjectRoot(await this.projectRootForSession(sessionId));
			ensureActive(controller.signal);
			const collector = new CandidateCollector(args.query);
			const git = await enumerateGit(root, collector, controller.signal, this.#options);
			const incomplete = git.available
				? git.incomplete
				: await enumerateDirectory(root, collector, controller.signal, this.#options);
			return await collector.result(
				root,
				args.limit ?? PROJECT_FILE_SEARCH_DEFAULT_LIMIT,
				incomplete,
				controller.signal,
			);
		} finally {
			context.abortSignal.removeEventListener("abort", onContextAbort);
			if (this.#active.get(sessionId) === controller) this.#active.delete(sessionId);
		}
	}

	operations(): Pick<DesktopOperationsAuthority, "filesSearch"> {
		return {
			filesSearch: (args, context) =>
				this.search(args as unknown as ProjectFileSearchArguments, context) as unknown as Promise<
					Record<string, unknown>
				>,
		};
	}
}
