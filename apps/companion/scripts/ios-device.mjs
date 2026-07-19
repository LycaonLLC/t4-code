#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const appConfig = JSON.parse(readFileSync(join(packageDirectory, "app.json"), "utf8")).expo;
const bundleIdentifier = appConfig.ios.bundleIdentifier;
const scheme = appConfig.scheme;
const workspaceName = "T4Companion";
const derivedDataPath = join(packageDirectory, ".expo", "ios-device-build");
const builtAppPath = join(derivedDataPath, "Build", "Products", "Release-iphoneos", `${workspaceName}.app`);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? packageDirectory,
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio ?? "pipe",
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
  });
}

function commandOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function runOrThrow(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(commandOutput(result) || `${command} exited with status ${result.status ?? "unknown"}`);
  }
  return result;
}

function runVisible(command, args, options = {}) {
  const result = run(command, args, {
    ...options,
    stdio: "inherit",
    timeout: options.timeout ?? 20 * 60_000,
  });
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
}

export function pairedPhysicalIphones(devices) {
  return devices
    .filter((device) =>
      device?.connectionProperties?.pairingState === "paired"
      && device?.hardwareProperties?.deviceType === "iPhone"
      && device?.hardwareProperties?.reality === "physical")
    .sort((left, right) => {
      const leftDate = Date.parse(left?.connectionProperties?.lastConnectionDate ?? "") || 0;
      const rightDate = Date.parse(right?.connectionProperties?.lastConnectionDate ?? "") || 0;
      return rightDate - leftDate;
    });
}

export function appleTeamIdFromCertificateSubject(subject) {
  return /(?:^|,)\s*OU\s*=\s*([A-Z0-9]{10})(?:,|$)/u.exec(subject)?.[1] ?? "";
}

export function companionDeepLink(address, appScheme = scheme) {
  return `${appScheme}://?address=${encodeURIComponent(address)}`;
}

export function launchFailureIsLocked(output) {
  return /Locked|could not be unlocked/u.test(output);
}

function listDevices() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "t4-companion-devices-"));
  const jsonPath = join(temporaryDirectory, "devices.json");
  try {
    runOrThrow("xcrun", ["devicectl", "list", "devices", "--json-output", jsonPath, "--quiet"], {
      timeout: 60_000,
    });
    return JSON.parse(readFileSync(jsonPath, "utf8"))?.result?.devices ?? [];
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function resolveDevice(requestedIdentifier) {
  const iphones = pairedPhysicalIphones(listDevices());
  if (requestedIdentifier) {
    const matched = iphones.find((device) =>
      device.identifier === requestedIdentifier || device?.hardwareProperties?.udid === requestedIdentifier);
    if (!matched) throw new Error(`No paired physical iPhone matched ${requestedIdentifier}.`);
    return matched;
  }
  if (iphones.length === 0) {
    throw new Error("No paired physical iPhone found. Connect, unlock, and trust the iPhone first.");
  }
  return iphones[0];
}

function resolveAppleTeamId(explicitTeamId) {
  if (explicitTeamId) return explicitTeamId;
  if (process.env.T4_APPLE_TEAM_ID) return process.env.T4_APPLE_TEAM_ID;
  const certificate = runOrThrow("security", ["find-certificate", "-c", "Apple Development", "-p"]);
  const subject = runOrThrow("openssl", ["x509", "-noout", "-subject"], { input: certificate.stdout });
  const teamId = appleTeamIdFromCertificateSubject(subject.stdout);
  if (!teamId) throw new Error("Could not infer the Apple team. Re-run with --team YOUR_TEAM_ID.");
  return teamId;
}

function resolveTailnetAddress(explicitAddress) {
  if (explicitAddress) return explicitAddress.replace(/\/$/u, "");
  const status = runOrThrow("tailscale", ["status", "--json"]);
  const dnsName = String(JSON.parse(status.stdout)?.Self?.DNSName ?? "").replace(/\.$/u, "");
  if (!dnsName.endsWith(".ts.net")) throw new Error("This Mac does not have a stable Tailscale DNS name.");
  return `https://${dnsName}:8445`;
}

function argumentValue(argumentsList, name) {
  const index = argumentsList.indexOf(name);
  if (index === -1) return "";
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

function printUsage() {
  console.log(`Build, install, and open T4 Companion on a physical iPhone.

Usage:
  pnpm --filter @t4-code/companion ios:device

Options:
  --device ID       Use a specific CoreDevice identifier or iPhone UDID
  --team TEAM_ID    Override the Apple team inferred from the development certificate
  --url URL         Override the stable Tailnet address inferred from Tailscale
  --reuse-build     Reinstall the last build without rebuilding it
  --launch-only     Open the installed app without rebuilding or reinstalling
  --no-launch       Install the app but do not open it
  --help            Show this help

Environment:
  T4_APPLE_TEAM_ID  Apple team fallback for unusual certificate setups`);
}

export function parseArguments(argumentsList) {
  const known = new Set(["--device", "--team", "--url", "--reuse-build", "--launch-only", "--no-launch", "--help"]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!known.has(argument)) throw new Error(`Unknown option: ${argument}`);
    if (["--device", "--team", "--url"].includes(argument)) index += 1;
  }
  const parsed = {
    device: argumentValue(argumentsList, "--device"),
    team: argumentValue(argumentsList, "--team"),
    url: argumentValue(argumentsList, "--url"),
    reuseBuild: argumentsList.includes("--reuse-build"),
    launchOnly: argumentsList.includes("--launch-only"),
    noLaunch: argumentsList.includes("--no-launch"),
    help: argumentsList.includes("--help"),
  };
  if (parsed.launchOnly && parsed.noLaunch) throw new Error("--launch-only and --no-launch cannot be used together.");
  return parsed;
}

function ensureNativeWorkspace() {
  const workspacePath = join(packageDirectory, "ios", `${workspaceName}.xcworkspace`);
  if (existsSync(workspacePath)) return;
  console.log("Generating the native iOS project and installing CocoaPods…");
  runVisible("pnpm", ["--filter", "@t4-code/companion", "exec", "expo", "prebuild", "--platform", "ios"], {
    cwd: repositoryRoot,
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function launchCompanion(deviceIdentifier, deepLink, waitMilliseconds = 60_000) {
  const deadline = Date.now() + waitMilliseconds;
  let announcedWait = false;
  while (true) {
    const launch = run("xcrun", [
      "devicectl", "device", "process", "launch",
      "--device", deviceIdentifier,
      "--terminate-existing",
      "--payload-url", deepLink,
      bundleIdentifier,
    ], { timeout: 60_000 });
    if (launch.status === 0) return commandOutput(launch);
    const output = commandOutput(launch);
    if (!launchFailureIsLocked(output) || Date.now() >= deadline) throw new Error(output || "The app installed but did not open.");
    if (!announcedWait) {
      announcedWait = true;
      console.log("The iPhone is locked. Unlock it now; waiting up to one minute…");
    }
    await delay(2_000);
  }
}

async function main(argumentsList) {
  const options = parseArguments(argumentsList);
  if (options.help) {
    printUsage();
    return;
  }
  const device = resolveDevice(options.device);
  const deviceIdentifier = device.identifier;
  const deviceUdid = device.hardwareProperties.udid;
  const model = device.hardwareProperties.marketingName;
  const teamId = options.launchOnly ? "" : resolveAppleTeamId(options.team);
  const address = resolveTailnetAddress(options.url);
  const deepLink = companionDeepLink(address);

  console.log(`iPhone: ${model} (${deviceUdid})`);
  if (teamId !== "") console.log(`Apple team: ${teamId}`);
  console.log(`T4 host: ${address}`);

  if (!options.launchOnly && !options.reuseBuild) {
    ensureNativeWorkspace();
    console.log("Building a signed Release app…");
    runOrThrow("xcodebuild", [
      "-workspace", join(packageDirectory, "ios", `${workspaceName}.xcworkspace`),
      "-scheme", workspaceName,
      "-configuration", "Release",
      "-destination", `platform=iOS,id=${deviceUdid}`,
      "-derivedDataPath", derivedDataPath,
      "-allowProvisioningUpdates",
      "-allowProvisioningDeviceRegistration",
      `DEVELOPMENT_TEAM=${teamId}`,
      "CODE_SIGN_STYLE=Automatic",
      "build",
      "-quiet",
    ], { timeout: 20 * 60_000 });
    console.log("Signed Release build finished.");
  } else if (!options.launchOnly && !existsSync(builtAppPath)) {
    throw new Error(`No reusable build exists at ${builtAppPath}. Run once without --reuse-build.`);
  }

  if (!options.launchOnly) {
    console.log("Installing T4 Companion…");
    runVisible("xcrun", ["devicectl", "device", "install", "app", "--device", deviceIdentifier, builtAppPath], {
      timeout: 5 * 60_000,
    });
  }

  if (options.noLaunch) {
    console.log(`Installed. Open T4 Companion on the iPhone; its host is ${address}`);
    return;
  }

  console.log("Opening T4 Companion with the saved Tailnet address…");
  try {
    console.log(await launchCompanion(deviceIdentifier, deepLink));
  } catch (caught) {
    const output = caught instanceof Error ? caught.message : String(caught);
    if (launchFailureIsLocked(output)) {
      throw new Error(`The app is installed, but the iPhone stayed locked. Unlock it and run:\n\n  pnpm --filter @t4-code/companion ios:device --launch-only`);
    }
    throw caught;
  }
  console.log("T4 Companion is installed, open, and configured.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`\nT4 iPhone setup stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
