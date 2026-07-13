import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join, resolve } from "node:path";
import config from "../electron-builder.config.mjs";
import { createPackage } from "@electron/asar";
import { runPreflight, validatePreloadArtifact, validateWebIndex } from "./package-preflight.mjs";
import { inspectPackage, locateAppRoot } from "./inspect-package.mjs";
import { LINUX_ICON_SIZES, verifyDesktopIcon } from "./desktop-icon-checks.mjs";
import {
  buildElectronBuilderArgs,
  PUBLIC_ARTIFACT_UMASK,
  withPublicArtifactUmask,
  withPublicReadAccess,
} from "./run-electron-builder.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

test("builder config keeps release contract", () => {
  assert.equal(config.appId, "com.lycaonsolutions.t4code");
  assert.equal(config.productName, "T4 Code");
  assert.equal(config.asar, true);
  assert.deepEqual(config.protocols[0].schemes, ["t4-code"]);
  assert.equal(config.linux.category, "Development");
  assert.equal(config.mac.category, "public.app-category.developer-tools");
  assert.equal(config.artifactName, "T4-Code-${version}-${os}-${arch}.${ext}");
});

test("builder never publishes implicitly from a release tag", () => {
  assert.deepEqual(buildElectronBuilderArgs(["--linux", "--x64"], repoRoot).slice(-2), ["--publish", "never"]);
});

test("builder uses a public artifact umask without changing its caller", () => {
  const original = process.umask(0o077);
  try {
    let observed;
    withPublicArtifactUmask(() => {
      observed = process.umask();
    });
    assert.equal(observed, PUBLIC_ARTIFACT_UMASK);
    assert.equal(process.umask(), 0o077);
  } finally {
    process.umask(original);
  }
});

test("builder exposes restrictive source assets only while packaging", () => {
  const scratch = mkdtempSync(join(tmpdir(), "t4-package-mode-"));
  const asset = join(scratch, "icon.png");
  try {
    writeFileSync(asset, "fixture");
    chmodSync(asset, 0o600);
    withPublicReadAccess([asset], () => {
      assert.equal(statSync(asset).mode & 0o777, 0o644);
    });
    assert.equal(statSync(asset).mode & 0o777, 0o600);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("preflight accepts built desktop inputs", () => {
  const result = runPreflight(repoRoot);
  assert.ok(existsSync(result.electronEntry));
  assert.ok(existsSync(result.webIndex));
});

test("web index preflight rejects absolute assets, inline executable scripts, and missing bootstrap", () => {
  const valid = '<script src="./t4-bootstrap.js"></script><script type="module" src="./assets/main.js"></script><link rel="stylesheet" href="./assets/main.css">';
  assert.deepEqual(validateWebIndex(valid), []);
  assert.ok(validateWebIndex('<script src="/src/main.js"></script><script src="./t4-bootstrap.js"></script>').some((error) => error.includes("root-absolute")));
  assert.ok(validateWebIndex('<script src="./t4-bootstrap.js"></script><script>window.x=1</script>').some((error) => error.includes("inline")));
  assert.ok(validateWebIndex('<script type="module" src="./main.js"></script>').some((error) => error.includes("missing external")));
});

test("preload artifact guard rejects local edges and requires the bridge marker", () => {
  const scratch = mkdtempSync(join(tmpdir(), "t4-preload-guard-"));
  try {
    const bad = join(scratch, "bad.cjs");
    writeFileSync(bad, 'require("./chunks/desktop-ipc.cjs");');
    assert.deepEqual(validatePreloadArtifact(bad), [
      "preload contains a relative or local module require/import",
      "preload is missing the exposeInMainWorld bridge marker",
    ]);

    const good = join(scratch, "good.cjs");
    writeFileSync(good, 'require("electron").contextBridge.exposeInMainWorld("ompShell", {});');
    assert.deepEqual(validatePreloadArtifact(good), []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("artifact inspector reads unpacked package metadata", () => {
  const unpacked = resolve(repoRoot, "release/linux-unpacked");
  if (!existsSync(unpacked)) return;
  const result = inspectPackage(unpacked);
  assert.equal(result.manifest.productName, "T4 Code");
  assert.ok(result.asarEntries > 0);
});

test("artifact inspector reads macOS bundles with capitalized Resources", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "t4-code-mac-root-"));
  try {
    const contents = join(scratch, "t4-code.app", "Contents");
    const resources = join(contents, "Resources");
    const asarSource = join(scratch, "asar-source");
    mkdirSync(join(resources, "web"), { recursive: true });
    mkdirSync(join(asarSource, "dist-electron"), { recursive: true });
    writeFileSync(join(resources, "web", "index.html"), "<!doctype html>");
    writeFileSync(join(resources, "LICENSE"), "MIT");
    writeFileSync(join(asarSource, "dist-electron", "main.cjs"), "");
    writeFileSync(join(asarSource, "dist-electron", "preload.cjs"), "");
    writeFileSync(join(asarSource, "package.json"), JSON.stringify({ productName: config.productName }));
    await createPackage(asarSource, join(resources, "app.asar"));
    assert.equal(locateAppRoot(scratch), contents);
    const result = inspectPackage(contents);
    assert.equal(result.manifest.productName, config.productName);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("builder config wires the T4 icon set for linux and the 1024 master for mac", () => {
  assert.equal(config.linux.icon, "apps/desktop/build/icons");
  assert.equal(config.mac.icon, "apps/desktop/build/icon.png");
  assert.ok(existsSync(resolve(repoRoot, config.mac.icon)));
  assert.ok(existsSync(resolve(repoRoot, "apps/desktop/build/icon.svg")));
  for (const size of LINUX_ICON_SIZES) {
    assert.ok(existsSync(resolve(repoRoot, config.linux.icon, `${size}x${size}.png`)), `missing ${size}x${size}.png`);
  }
});

test("desktop icon set satisfies the brand raster contract at every size", () => {
  const { errors } = verifyDesktopIcon(repoRoot);
  assert.deepEqual(errors, []);
});

test("icon verification fails closed when assets are missing", () => {
  const scratch = mkdtempSync(join(tmpdir(), "t4-icon-check-"));
  try {
    const { errors } = verifyDesktopIcon(scratch);
    assert.ok(errors.some((message) => message.includes("icon.svg")));
    assert.ok(errors.some((message) => message.includes("icon.png")));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
