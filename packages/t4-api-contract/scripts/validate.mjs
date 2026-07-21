import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { compileErrors, validate } from "@readme/openapi-parser";

const source = new URL("../openapi.json", import.meta.url);
const document = JSON.parse(await readFile(source, "utf8"));
const validation = await validate(fileURLToPath(source));
if (!validation.valid || validation.warnings.length > 0) throw new Error(compileErrors(validation));

if (document.openapi !== "3.1.0") throw new Error("T4 API contract must remain OpenAPI 3.1.0");
if (!Array.isArray(document.servers) || document.servers.length === 0) throw new Error("T4 API contract requires an HTTPS server");
for (const server of document.servers) {
  if (new URL(server.url).protocol !== "https:") throw new Error("T4 API contract permits only HTTPS servers");
}
if (document.security?.[0]?.BearerAuth === undefined) throw new Error("T4 API contract must default to bearer authentication");
const serializedSchemas = JSON.stringify(document.components?.schemas ?? {}).toLowerCase();
for (const privateType of ["kubernetes.io", "v1alpha1", "postgresql", "ompserver", "podspec"]) {
  if (serializedSchemas.includes(privateType)) throw new Error(`public schema leaks private type ${privateType}`);
}
console.log("T4 API OpenAPI 3.1 contract is valid");
