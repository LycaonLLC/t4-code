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
const sseSchema = document.paths?.["/v1/sessions/{sessionId}/events"]?.get?.responses?.["200"]?.content?.["text/event-stream"]?.schema;
if (sseSchema?.["x-t4-sse-data-schema"] !== "#/components/schemas/WatchEvent") throw new Error("watch SSE data must remain linked to WatchEvent");
const errorResponses = { 400: "Error400", 401: "Error401", 403: "Error403", 404: "Error404", 406: "Error406", 409: "Error409", 410: "Error410", 422: "Error422", 503: "Error503" };
for (const path of Object.values(document.paths ?? {})) {
  for (const operation of Object.values(path)) {
    if (operation === null || typeof operation !== "object" || operation.responses === undefined) continue;
    for (const [status, component] of Object.entries(errorResponses)) {
      const response = operation.responses[status];
      if (response !== undefined && response.$ref !== `#/components/responses/${component}`) throw new Error(`${status} responses must use ${component}`);
    }
  }
}
const serializedSchemas = JSON.stringify(document.components?.schemas ?? {}).toLowerCase();
for (const privateType of ["kubernetes.io", "v1alpha1", "postgresql", "ompserver", "podspec"]) {
  if (serializedSchemas.includes(privateType)) throw new Error(`public schema leaks private type ${privateType}`);
}
console.log("T4 API OpenAPI 3.1 contract is valid");
