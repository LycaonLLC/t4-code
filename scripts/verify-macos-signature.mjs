#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const zip = resolve(process.argv[2] ?? "");
const dmg = resolve(process.argv[3] ?? "");
if (!zip.endsWith(".zip") || !dmg.endsWith(".dmg")) throw new Error("usage: verify-macos-signature.mjs APP.zip APP.dmg");
const root = mkdtempSync(join(tmpdir(), "t4-macos-signature-"));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}
run("ditto", ["-x", "-k", zip, root]);
const app = readdirSync(root).map((name) => join(root, name)).find((path) => path.endsWith(".app") && statSync(path).isDirectory());
if (!app) throw new Error("signed ZIP did not contain a top-level .app bundle");
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
run("xcrun", ["stapler", "validate", app]);
run("xcrun", ["stapler", "validate", dmg]);
console.log("macOS Developer ID signature, Gatekeeper assessment, and notarization ticket passed");
