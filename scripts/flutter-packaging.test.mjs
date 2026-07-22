import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("desktop commands resolve to Flutter packaging", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(manifest.scripts.dev, "node scripts/run-flutter.mjs");
  assert.equal(manifest.scripts["build:desktop"], "node scripts/build-flutter-desktop.mjs");
  assert.equal(manifest.scripts["package:linux"], "pnpm prepackage && node scripts/package-flutter-linux.mjs");
  assert.equal(manifest.scripts["package:mac"], "pnpm prepackage && node scripts/package-mac-signed.mjs");
  assert.equal(existsSync(resolve(root, "apps", "desktop")), false);
});

test("workspace catalog delegates desktop builds to Flutter", () => {
  const workspace = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
  assert.doesNotMatch(workspace, /^\s{2}desktop-runtime:/mu);
});

test("Flutter release configuration owns Android signing", () => {
  const gradle = readFileSync(resolve(root, "apps/flutter/android/app/build.gradle.kts"), "utf8");
  assert.match(gradle, /T4_ANDROID_KEYSTORE_PATH/u);
  assert.match(gradle, /signingConfigs\.getByName\("release"\)/u);
  assert.doesNotMatch(gradle, /signingConfigs\.getByName\("debug"\)/u);
});

test("Flutter macOS release build defers signing to the packaging lane", () => {
  const project = readFileSync(
    resolve(root, "apps/flutter/macos/Runner.xcodeproj/project.pbxproj"),
    "utf8",
  );
  assert.match(project, /CODE_SIGNING_ALLOWED = NO;/u);
  assert.match(project, /CODE_SIGNING_REQUIRED = NO;/u);
  assert.match(project, /CODE_SIGN_STYLE = Manual;/u);
});
