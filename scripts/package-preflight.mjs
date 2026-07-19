import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

import { verifyDesktopIcon } from "./desktop-icon-checks.mjs";

export const runtimeExternalDependencies = ["electron-store", "electron-updater", "ws"];
const forbiddenPath = /(^|[/\\])(?:reference|references|proof|proofs|\.env(?:$|[.])|auth)(?:[/\\]|$)/iu;
const localModuleReference = /\b(?:require\s*\(\s*|import\s*(?:\(\s*)?|from\s+)["'`](?:\.{1,2}[\\/]|\/)/u;
const preloadBridgeMarker = /\bexposeInMainWorld\s*\(/u;

const rootAbsoluteAsset = /(?:\bsrc|\bhref)\s*=\s*["']\/(?!\/)/iu;
const scriptTag = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
const scriptSource = /\bsrc\s*=\s*["'][^"']+["']/iu;
const executableScriptType = /(?:^|["'\s])(?:text|application)\/(?:java|ecma)script|module|importmap/iu;
const bootstrapScript = /<script\b[^>]*\bsrc\s*=\s*["']\.\/t4-bootstrap\.js["'][^>]*>/iu;

export function validateWebIndex(source) {
  const errors = [];
  if (rootAbsoluteAsset.test(source)) errors.push("web index contains a root-absolute local src or href");
  let match;
  let hasBootstrap = false;
  while ((match = scriptTag.exec(source)) !== null) {
    const attributes = match[1] ?? "";
    if (bootstrapScript.test(match[0])) hasBootstrap = true;
    if (!scriptSource.test(attributes) && (!/\btype\s*=/iu.test(attributes) || executableScriptType.test(attributes))) {
      errors.push("web index contains an executable inline script");
    }
  }
  scriptTag.lastIndex = 0;
  if (!hasBootstrap) errors.push("web index is missing external ./t4-bootstrap.js");
  return errors;
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function packagePath(root, dependency) {
  return join(root, "apps", "desktop", "node_modules", ...dependency.split("/"));
}

export function validatePreloadArtifact(file) {
  const source = readFileSync(file, "utf8");
  const errors = [];
  if (localModuleReference.test(source)) errors.push("preload contains a relative or local module require/import");
  if (!preloadBridgeMarker.test(source)) errors.push("preload is missing the exposeInMainWorld bridge marker");
  return errors;
}

export function runPreflight(repoRoot = resolve(import.meta.dirname, "..")) {
  const desktopRoot = join(repoRoot, "apps", "desktop");
  const electronDist = join(desktopRoot, "dist-electron");
  const webDist = join(repoRoot, "apps", "web", "dist");
  const preloadEntry = join(electronDist, "preload.cjs");
  const errors = [];

  if (process.env.T4_REQUIRE_BUNDLED_OMP === "1") {
    const runtimeRoot = join(repoRoot, ".artifacts", "omp-runtime");
    const manifestPath = join(runtimeRoot, "manifest.json");
    const executablePath = join(runtimeRoot, "omp");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const matrix = JSON.parse(readFileSync(join(repoRoot, "compat", "omp-app-matrix.json"), "utf8"));
      const pinned = matrix.verifiedRuntime?.artifacts?.["darwin-arm64"];
      const digest = createHash("sha256").update(readFileSync(executablePath)).digest("hex");
      if (
        manifest.tag !== matrix.verifiedRuntime?.sourceTag || manifest.sha256 !== pinned?.sha256 ||
        manifest.size !== pinned?.size || lstatSync(executablePath).size !== pinned?.size || digest !== pinned?.sha256
      ) errors.push("staged OMP runtime does not match compat/omp-app-matrix.json");
    } catch {
      errors.push("missing or invalid staged OMP runtime");
    }
  }

  for (const required of [join(electronDist, "main.cjs"), preloadEntry, join(webDist, "index.html")]) {
    if (!existsSync(required) || !lstatSync(required).isFile() || lstatSync(required).size === 0) {
      errors.push(`missing built entry: ${relative(repoRoot, required)}`);
    }
  }
  if (existsSync(preloadEntry) && lstatSync(preloadEntry).isFile()) {
    for (const error of validatePreloadArtifact(preloadEntry)) errors.push(`${relative(repoRoot, preloadEntry)}: ${error}`);
  }

  const webIndex = join(webDist, "index.html");
  if (existsSync(webIndex) && lstatSync(webIndex).isFile()) {
    for (const error of validateWebIndex(readFileSync(webIndex, "utf8"))) errors.push(`${relative(repoRoot, webIndex)}: ${error}`);
  }

  for (const output of [electronDist, webDist]) {
    for (const file of walkFiles(output)) {
      const relativePath = relative(repoRoot, file).split(sep).join("/");
      if (forbiddenPath.test(relativePath)) errors.push(`forbidden packaged path: ${relativePath}`);
      if (relativePath.endsWith(".map")) errors.push(`source map is not allowed in package inputs: ${relativePath}`);
    }
  }

  for (const dependency of runtimeExternalDependencies) {
    const dependencyRoot = packagePath(repoRoot, dependency);
    const manifest = join(dependencyRoot, "package.json");
    if (!existsSync(dependencyRoot) || !existsSync(manifest)) {
      errors.push(`missing runtime external dependency: ${dependency}`);
    }
  }

  errors.push(...verifyDesktopIcon(repoRoot).errors);

  if (errors.length > 0) {
    throw new Error(`desktop packaging preflight failed:\n- ${errors.join("\n- ")}`);
  }

  return {
    electronEntry: join(electronDist, "main.cjs"),
    preloadEntry: join(electronDist, "preload.cjs"),
    webIndex: join(webDist, "index.html"),
    runtimeExternalDependencies: [...runtimeExternalDependencies],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    const result = runPreflight();
    console.log(`desktop packaging preflight passed (${result.runtimeExternalDependencies.join(", ")})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
