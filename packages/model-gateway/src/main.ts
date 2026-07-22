import { loadConfig } from "./config.ts";
import { startServers } from "./server.ts";

const config = await loadConfig();
const servers = startServers(config);
process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), component: "model-gateway", message: "listening" })}\n`);

let stopping = false;
async function stop(): Promise<void> {
	if (stopping) return;
	stopping = true;
	await servers.stop();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
