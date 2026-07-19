#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

function run(command, args = []) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function executableOnPath(name, pathValue = process.env.PATH ?? "") {
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => existsSync(join(directory, name)));
}

function androidSdkRoot(environment = process.env, userHome = homedir()) {
  const candidates = [
    environment.ANDROID_HOME,
    environment.ANDROID_SDK_ROOT,
    join(userHome, "Library", "Android", "sdk"),
    join(userHome, "Android", "Sdk"),
  ];
  return candidates.find((candidate) => typeof candidate === "string" && existsSync(candidate));
}

export function evaluateDoctor(snapshot, platform = "all") {
  const checks = [];
  const includeIos = platform === "all" || platform === "ios";
  const includeAndroid = platform === "all" || platform === "android";
  checks.push({
    name: "Node 24",
    ok: snapshot.nodeMajor === 24,
    detail: snapshot.nodeMajor === 24 ? snapshot.nodeVersion : `found ${snapshot.nodeVersion}; run through mise Node 24`,
  });
  checks.push({
    name: "Checkout path",
    ok: !snapshot.checkoutHasSpaces,
    detail: snapshot.checkoutHasSpaces
      ? "move this checkout to a path without spaces before generating iOS files"
      : "safe for Expo native generation",
  });
  checks.push({
    name: "Tailscale host",
    ok: snapshot.tailnetName.endsWith(".ts.net"),
    detail: snapshot.tailnetName || "connect Tailscale on this Mac",
  });

  if (includeIos) {
    checks.push({
      name: "Xcode",
      ok: snapshot.xcodeAvailable,
      detail: snapshot.xcodeAvailable ? snapshot.xcodeVersion : "install Xcode and select its command-line tools",
    });
    checks.push({
      name: "Physical iPhone",
      ok: snapshot.iphoneAvailable,
      detail: snapshot.iphoneAvailable ? "paired and available" : "connect, unlock, and trust an iPhone",
    });
    checks.push({
      name: "Apple development signing",
      ok: snapshot.appleDevelopmentIdentity,
      detail: snapshot.appleDevelopmentIdentity
        ? "development certificate is available"
        : "open Xcode Settings > Accounts and create an Apple Development certificate",
    });
  }

  if (includeAndroid) {
    checks.push({
      name: "Android SDK",
      ok: snapshot.androidSdkAvailable,
      detail: snapshot.androidSdkAvailable ? snapshot.androidSdkRoot : "install Android Studio and its SDK",
    });
    checks.push({
      name: "Android device tools",
      ok: snapshot.adbAvailable,
      detail: snapshot.adbAvailable ? "adb is available" : "install Android SDK Platform-Tools",
    });
  }
  return checks;
}

export function collectSnapshot() {
  const xcode = run("xcodebuild", ["-version"]);
  const devices = run("xcrun", ["devicectl", "list", "devices"]);
  const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  const tailscale = run("tailscale", ["status", "--json"]);
  let tailnetName = "";
  if (tailscale.ok) {
    try {
      const parsed = JSON.parse(tailscale.output);
      tailnetName = String(parsed?.Self?.DNSName ?? "").replace(/\.$/u, "");
    } catch {
      // The check below supplies the user-facing repair action.
    }
  }
  const sdkRoot = androidSdkRoot();
  return {
    nodeMajor: Number(process.versions.node.split(".")[0]),
    nodeVersion: process.versions.node,
    checkoutHasSpaces: process.cwd().includes(" "),
    tailnetName,
    xcodeAvailable: xcode.ok,
    xcodeVersion: xcode.output.split("\n")[0] ?? "Xcode",
    iphoneAvailable: devices.ok && /available \(paired\).*iPhone/u.test(devices.output),
    appleDevelopmentIdentity:
      identities.ok && /"(?:Apple Development|iPhone Developer):/u.test(identities.output),
    androidSdkAvailable: sdkRoot !== undefined,
    androidSdkRoot: sdkRoot ?? "",
    adbAvailable:
      executableOnPath("adb") || (sdkRoot !== undefined && existsSync(join(sdkRoot, "platform-tools", "adb"))),
  };
}

function selectedPlatform(argumentsList) {
  const index = argumentsList.indexOf("--platform");
  const value = index === -1 ? "all" : argumentsList[index + 1];
  if (value !== "all" && value !== "ios" && value !== "android") {
    throw new Error("Use --platform ios, android, or all.");
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let platform;
  try {
    platform = selectedPlatform(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
  if (platform) {
    const checks = evaluateDoctor(collectSnapshot(), platform);
    console.log(`T4 Companion readiness (${platform})\n`);
    for (const check of checks) console.log(`${check.ok ? "PASS" : "FIX "}  ${check.name}: ${check.detail}`);
    const failing = checks.filter((check) => !check.ok);
    console.log(failing.length === 0 ? "\nReady to build." : `\n${failing.length} item${failing.length === 1 ? "" : "s"} need attention.`);
    process.exitCode = failing.length === 0 ? 0 : 1;
  }
}
