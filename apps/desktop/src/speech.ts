import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { decodeSpeechText, type SpeechRequest, type SpeechResult } from "@t4-code/protocol/desktop-ipc";
const MAX_STOP_WAIT_MS = 1_500;
const TEMP_PREFIX = "t4-speech-";
type SpeechChild = { readonly child: ChildProcess; readonly directory: string; readonly exited: Promise<void>; readonly settle: (result: SpeechResult) => void; settled: boolean; cancelled: boolean; failed: boolean };
export interface DesktopSpeechServiceOptions { readonly discoverExecutable: () => Promise<string | undefined>; readonly spawn?: typeof spawn; readonly makeTempDirectory?: () => Promise<string> }
export interface DesktopSpeechService { speakText(request: SpeechRequest): Promise<SpeechResult>; stopSpeaking(): Promise<SpeechResult>; dispose(): Promise<void> }
function killTree(child: ChildProcess): void { try { if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch { /* exited */ } }
export function createDesktopSpeechService(options: DesktopSpeechServiceOptions): DesktopSpeechService {
  const spawnProcess = options.spawn ?? spawn; const makeDirectory = options.makeTempDirectory ?? (() => mkdtemp(join(tmpdir(), TEMP_PREFIX))); let active: SpeechChild | undefined; let disposed = false; let generation = 0;
  async function reap(item: SpeechChild): Promise<void> { killTree(item.child); const timeout = Promise.withResolvers<void>(); const timer = setTimeout(timeout.resolve, MAX_STOP_WAIT_MS); timer.unref?.(); await Promise.race([item.exited, timeout.promise]); clearTimeout(timer); if (item.child.exitCode === null && item.child.signalCode === null) { try { if (item.child.pid !== undefined && process.platform !== "win32") process.kill(-item.child.pid, "SIGKILL"); else item.child.kill("SIGKILL"); } catch { /* exited */ } await item.exited; } }
  async function cleanup(item: SpeechChild, result: SpeechResult): Promise<void> { await rm(item.directory, { recursive: true, force: true }).catch(() => undefined); if (!item.settled) { item.settled = true; item.settle(result); } if (active === item) active = undefined; }
  async function stopSpeaking(): Promise<SpeechResult> { const item = active; generation += 1; if (item === undefined) return { accepted: true }; active = undefined; item.cancelled = true; await reap(item); await cleanup(item, { accepted: false, error: "Speech cancelled" }); return { accepted: true }; }
  return {
    async speakText(request): Promise<SpeechResult> {
      let text: string; try { text = decodeSpeechText(request.text); } catch (error) { return { accepted: false, error: error instanceof Error ? error.message : "invalid speech text" }; }
      if (disposed) return { accepted: false, error: "Speech service is stopped" }; await stopSpeaking(); const currentGeneration = ++generation; const executable = await options.discoverExecutable().catch(() => undefined); if (disposed || currentGeneration !== generation || executable === undefined) return { accepted: false, error: "Speech is unavailable" };
      const directory = await makeDirectory().catch(() => undefined); if (directory === undefined || disposed || currentGeneration !== generation) { if (directory !== undefined) await rm(directory, { recursive: true, force: true }); return { accepted: false, error: "Speech is unavailable" }; }
      const file = join(directory, "speech.txt"); let handle; try { handle = await open(file, "wx", 0o600); await handle.writeFile(text, { encoding: "utf8" }); await handle.close(); } catch { await handle?.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }); return { accepted: false, error: "Speech is unavailable" }; }
      if (disposed || currentGeneration !== generation) { await rm(directory, { recursive: true, force: true }); return { accepted: false, error: "Speech cancelled" }; }
      let child: ChildProcess; try { child = spawnProcess(executable, ["say", "--file", file], { shell: false, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore"] }); } catch { await rm(directory, { recursive: true, force: true }); return { accepted: false, error: "Speech is unavailable" }; }
      const { promise, resolve } = Promise.withResolvers<SpeechResult>(); let failed = false; const exited = Promise.withResolvers<void>(); child.once("exit", (code) => { failed = code !== 0; exited.resolve(); }); child.once("error", () => { failed = true; exited.resolve(); }); const item: SpeechChild = { child, directory, exited: exited.promise, settle: resolve, settled: false, cancelled: false, failed }; active = item; void exited.promise.then(() => cleanup(item, item.cancelled ? { accepted: false, error: "Speech cancelled" } : failed ? { accepted: false, error: "Speech synthesis failed" } : { accepted: true })); return promise;
    }, stopSpeaking, async dispose(): Promise<void> { disposed = true; await stopSpeaking(); },
  };
}
