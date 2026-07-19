import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function diagnostic(file, message) { return `${file}: ${message}`; }
function safeTarget(target) {
  if (typeof target !== "string" || !target || path.isAbsolute(target)) return false;
  const normalized = path.posix.normalize(target.replaceAll(path.sep, "/"));
  return normalized === target.replaceAll(path.sep, "/") && normalized !== "." && !normalized.startsWith("../") && !normalized.includes("/../") && !normalized.split("/").includes("..");
}

export async function checkProvenance(root = process.cwd()) {
  const directory = path.join(root, "provenance", "t3code", "imports");
  const failures = [];
  let manifests;
  try { manifests = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort((a, b) => a.localeCompare(b)); }
  catch (error) { return { checked: 0, failures: [diagnostic("provenance/t3code/imports", `cannot read manifests: ${error.message}`)] }; }
  if (!manifests.length) failures.push(diagnostic("provenance/t3code/imports", "no manifests found"));
  const seen = new Set();
  for (const name of manifests) {
    const relative = path.posix.join("provenance/t3code/imports", name);
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")); }
    catch (error) { failures.push(diagnostic(relative, `invalid JSON: ${error.message}`)); continue; }
    if (typeof manifest.license !== "string" || !manifest.license.includes(";")) failures.push(diagnostic(relative, "license must include semicolon-separated attribution and pointer"));
    else {
      const pointer = manifest.license.split(";").at(-1).trim();
      if (!safeTarget(pointer)) failures.push(diagnostic(relative, "license pointer must be a safe repo-relative path"));
      else {
        try { await fs.access(path.join(root, pointer)); } catch { failures.push(diagnostic(relative, "license pointer target does not exist")); }
      }
    }
    if (typeof manifest.batch !== "string" || !manifest.batch) failures.push(diagnostic(relative, "batch must be a non-empty string"));
    for (const field of ["sourceCommit", "adaptationCommit"]) if (typeof manifest[field] !== "string" || !SHA1.test(manifest[field])) failures.push(diagnostic(relative, `${field} must be 40 lowercase hex characters`));
    if (typeof manifest.license !== "string" || !manifest.license.includes(";")) failures.push(diagnostic(relative, "license must include semicolon-separated attribution and pointer"));
    if (!Array.isArray(manifest.records)) { failures.push(diagnostic(relative, "records must be an array")); continue; }
    for (const [index, record] of manifest.records.entries()) {
      const label = `${relative} records[${index}]`;
      for (const field of ["sourcePath", "sourceBlobSha", "targetPath", "classification", "checksum"]) if (!(field in record)) failures.push(diagnostic(label, `missing ${field}`));
      if (typeof record.sourceBlobSha !== "string" || !record.sourceBlobSha.split(";").every((sha) => SHA1.test(sha))) failures.push(diagnostic(label, "sourceBlobSha must be semicolon-separated lowercase 40-hex blobs"));
      const targets = typeof record.targetPath === "string" ? record.targetPath.split(" + ") : [];
      const checksums = typeof record.checksum === "string" ? record.checksum.split(";") : [];
      if (!targets.length || !targets.every(safeTarget)) failures.push(diagnostic(label, "targetPath must be normalized repo-relative without traversal"));
      if (!checksums.length || checksums.length !== targets.length || !checksums.every((checksum) => SHA256.test(checksum))) failures.push(diagnostic(label, "checksum must contain one sha256:<64 lowercase hex> per target"));
      if (targets.length === checksums.length) for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
        const targetPath = targets[targetIndex];
        const checksum = checksums[targetIndex];
        const key = `${manifest.batch}\0${targetPath}\0${record.sourcePath}\0${record.classification}`;
        if (seen.has(key)) failures.push(diagnostic(label, "duplicate batch+target")); else seen.add(key);
        if (safeTarget(targetPath) && SHA256.test(checksum)) {
          try { const digest = `sha256:${createHash("sha256").update(await fs.readFile(path.join(root, targetPath))).digest("hex")}`; if (digest !== checksum) failures.push(diagnostic(label, `checksum mismatch (actual ${digest})`)); }
          catch { failures.push(diagnostic(label, "target file does not exist or is unreadable")); }
        }
      }
    }
  }
  failures.sort((a, b) => a.localeCompare(b));
  return { checked: manifests.length, failures };
}

export function formatReport(result) { return `Checked ${result.checked} provenance manifest${result.checked === 1 ? "" : "s"}; ${result.failures.length} failure${result.failures.length === 1 ? "" : "s"}.${result.failures.length ? `\n${result.failures.join("\n")}` : ""}`; }

if (import.meta.main) { const result = await checkProvenance(process.cwd()); console.log(formatReport(result)); if (result.failures.length) process.exitCode = 1; }
