import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildFlutter,
  copyTree,
  flutterRoot,
  releaseRoot,
  repoRoot,
  resetDirectory,
  resetReleaseDirectory,
  run,
  stageHost,
  version,
} from "./flutter-packaging.mjs";

if (process.platform !== "darwin") throw new Error(`macOS packaging requires macOS; current platform is ${process.platform}`);

const signed = process.argv.includes("--signed");
const sourceApp = join(flutterRoot, "build", "macos", "Build", "Products", "Release", "t4code.app");
const staging = join(repoRoot, ".artifacts", "flutter-macos-package");
const app = join(staging, "T4 Code.app");
const zip = join(releaseRoot, `T4-Code-${version}-mac-arm64.zip`);
const dmg = join(releaseRoot, `T4-Code-${version}-mac-arm64.dmg`);

buildFlutter("macos");
if (!existsSync(sourceApp)) throw new Error(`Flutter app bundle is missing: ${sourceApp}`);
resetDirectory(staging);
copyTree(sourceApp, app);
const host = stageHost(join(app, "Contents", "Resources"));
resetReleaseDirectory();

if (signed) {
  const identity = process.env.T4_MACOS_SIGNING_IDENTITY?.trim();
  if (!identity) throw new Error("package:mac requires T4_MACOS_SIGNING_IDENTITY");
  run("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", identity, host]);
  run("codesign", [
    "--force", "--deep", "--options", "runtime", "--timestamp",
    "--entitlements", join(flutterRoot, "macos", "Runner", "Release.entitlements"),
    "--sign", identity, app,
  ]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
}

run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);

if (signed) {
  for (const name of ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
    if (!process.env[name]) throw new Error(`package:mac requires ${name}`);
  }
  run("xcrun", [
    "notarytool", "submit", zip,
    "--key", process.env.APPLE_API_KEY,
    "--key-id", process.env.APPLE_API_KEY_ID,
    "--issuer", process.env.APPLE_API_ISSUER,
    "--wait",
  ]);
  run("xcrun", ["stapler", "staple", app]);
  rmSync(zip, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
}

rmSync(dmg, { force: true });
run("hdiutil", ["create", "-volname", "T4 Code", "-srcfolder", app, "-ov", "-format", "UDZO", dmg]);

if (signed) {
  run("xcrun", [
    "notarytool", "submit", dmg,
    "--key", process.env.APPLE_API_KEY,
    "--key-id", process.env.APPLE_API_KEY_ID,
    "--issuer", process.env.APPLE_API_ISSUER,
    "--wait",
  ]);
  run("xcrun", ["stapler", "staple", dmg]);
}
