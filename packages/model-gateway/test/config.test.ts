import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, parseAllowedPaths, parseUpstreamOrigin, readCredential } from "../src/config.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function credential(value = "Bearer provider-secret\n"): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "t4-model-gateway-"));
	roots.push(root);
	const file = path.join(root, "credential");
	await writeFile(file, value, { mode: 0o400 });
	return file;
}

describe("model gateway configuration", () => {
	it("loads one exact HTTPS origin and a credential file", async () => {
		const file = await credential();
		const config = await loadConfig({
			T4_MODEL_GATEWAY_UPSTREAM_ORIGIN: "https://api.example.test",
			T4_MODEL_GATEWAY_CREDENTIAL_HEADER: "Authorization",
			T4_MODEL_GATEWAY_CREDENTIAL_FILE: file,
			T4_MODEL_GATEWAY_ALLOWED_PATHS: '["/v1/responses","/v1/models"]',
		});
		expect(config.upstreamOrigin.href).toBe("https://api.example.test/");
		expect(config.credentialHeader).toBe("authorization");
		expect(config.credentialFile).toBe(file);
		expect(await readCredential(config.credentialFile)).toBe("Bearer provider-secret");
		expect(config.timeoutMs).toBe(600_000);
		expect(config.allowedPaths).toEqual(["/v1/responses", "/v1/models"]);
	});

	it("requires unique exact model endpoint paths", () => {
		expect(parseAllowedPaths('["/v1/responses","/v1/models"]')).toEqual(["/v1/responses", "/v1/models"]);
		for (const value of ["[]", '["//collector.example/steal"]', '["/v1/responses?admin=true"]', '["/v1/../admin"]', '["/v1/models","/v1/models"]']) {
			expect(() => parseAllowedPaths(value)).toThrow("T4_MODEL_GATEWAY_ALLOWED_PATHS");
		}
	});

	it("rejects insecure, scoped, or credential-bearing upstream URLs", () => {
		for (const value of [
			"http://api.example.test",
			"https://user:password@api.example.test",
			"https://api.example.test/v1",
			"https://api.example.test/?region=west",
			"https://api.example.test/#fragment",
		]) expect(() => parseUpstreamOrigin(value)).toThrow("HTTPS origin");
	});

	it("rejects header injection and unsafe credential sources", async () => {
		const file = await credential("Bearer secret\r\nx-leak: yes");
		await expect(readCredential(file)).rejects.toThrow("invalid character");
		await expect(readCredential("relative-secret")).rejects.toThrow("must be absolute");
		await expect(loadConfig({
			T4_MODEL_GATEWAY_UPSTREAM_ORIGIN: "https://api.example.test",
			T4_MODEL_GATEWAY_CREDENTIAL_HEADER: "x-forwarded-for",
			T4_MODEL_GATEWAY_CREDENTIAL_FILE: file,
			T4_MODEL_GATEWAY_ALLOWED_PATHS: '["/v1/responses"]',
		})).rejects.toThrow("must be one of");
	});
});
