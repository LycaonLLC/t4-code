#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { companionDeepLink } from "./ios-device.mjs";

const packageDirectory = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const applicationId = "com.roycorp.t4companion";
const defaultAvd = "T4_Pixel_API_36";
const releaseApk = join(packageDirectory, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");

function commandOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function run(command, args = [], options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 30_000, ...options });
}

function runOrThrow(command, args = [], options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(commandOutput(result) || `${command} exited with status ${result.status}.`);
  return commandOutput(result);
}

function argumentValue(argumentsList, name) {
  const index = argumentsList.indexOf(name);
  if (index === -1) return "";
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

export function parseAndroidArguments(argumentsList) {
  const valued = new Set(["--device", "--avd", "--url"]);
  const switches = new Set(["--reuse-build", "--launch-only", "--no-launch", "--help"]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!valued.has(argument) && !switches.has(argument)) throw new Error(`Unknown option: ${argument}`);
    if (valued.has(argument)) index += 1;
  }
  const parsed = {
    device: argumentValue(argumentsList, "--device"),
    avd: argumentValue(argumentsList, "--avd") || defaultAvd,
    url: argumentValue(argumentsList, "--url"),
    reuseBuild: argumentsList.includes("--reuse-build"),
    launchOnly: argumentsList.includes("--launch-only"),
    noLaunch: argumentsList.includes("--no-launch"),
    help: argumentsList.includes("--help"),
  };
  if (parsed.launchOnly && parsed.noLaunch) throw new Error("--launch-only and --no-launch cannot be used together.");
  return parsed;
}

export function parseAdbDevices(output) {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /\sdevice(?:\s|$)/u.test(line))
    .map((line) => {
      const [serial] = line.split(/\s+/u);
      const model = /(?:^|\s)model:([^\s]+)/u.exec(line)?.[1]?.replaceAll("_", " ") ?? serial;
      return { serial, model };
    });
}

export function resolveAndroidSdkRoot(environment = process.env, userHome = homedir(), pathExists = existsSync) {
  const candidates = [
    environment.ANDROID_HOME,
    environment.ANDROID_SDK_ROOT,
    join(userHome, "Library", "Android", "sdk"),
    join(userHome, "Android", "Sdk"),
    "/opt/homebrew/share/android-commandlinetools",
    "/usr/local/share/android-commandlinetools",
  ];
  return candidates.find((candidate) => typeof candidate === "string" && pathExists(join(candidate, "platforms"))) ?? "";
}

export function resolveAndroidJavaHome(environment = process.env, pathExists = existsSync) {
  const candidates = [
    environment.JAVA_HOME,
    "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
  ];
  return candidates.find((candidate) => {
    if (typeof candidate !== "string" || !pathExists(join(candidate, "bin", "java"))) return false;
    const version = run(join(candidate, "bin", "java"), ["-version"]);
    const major = /version "(\d+)/u.exec(commandOutput(version))?.[1] ?? "";
    return major === "17" || major === "21";
  }) ?? "";
}

function printUsage() {
  console.log(`Build, install, and open T4 Companion on Android.

Usage:
  pnpm --filter @t4-code/companion android:device

Options:
  --device SERIAL   Use a connected Android device or emulator
  --avd NAME        Boot this virtual device when none is running (default: ${defaultAvd})
  --url URL         Override the stable Tailnet address inferred from Tailscale
  --reuse-build     Reinstall the last Release APK without rebuilding it
  --launch-only     Open the installed app without rebuilding or reinstalling
  --no-launch       Install the app but do not open it
  --help            Show this help`);
}

function resolveTailnetAddress(override) {
  if (override) return override;
  const result = run("tailscale", ["status", "--json"]);
  if (result.status !== 0) throw new Error("Connect Tailscale on this Mac, or pass --url with the stable T4 host address.");
  const parsed = JSON.parse(result.stdout);
  const dnsName = String(parsed?.Self?.DNSName ?? "").replace(/\.$/u, "");
  if (!dnsName.endsWith(".ts.net")) throw new Error("Tailscale did not return a stable .ts.net name for this Mac.");
  return `https://${dnsName}:8445`;
}

function androidEnvironment(sdkRoot, javaHome) {
  return {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    JAVA_HOME: javaHome,
    PATH: [join(javaHome, "bin"), join(sdkRoot, "platform-tools"), process.env.PATH ?? ""].join(delimiter),
  };
}

function adbPath(sdkRoot) {
  const bundled = join(sdkRoot, "platform-tools", "adb");
  return existsSync(bundled) ? bundled : "adb";
}

function connectedDevices(adb, environment) {
  const output = runOrThrow(adb, ["devices", "-l"], { env: environment });
  return parseAdbDevices(output);
}

function selectDevice(devices, requested) {
  if (requested) {
    const match = devices.find((device) => device.serial === requested || device.model === requested);
    if (!match) throw new Error(`Android device ${requested} is not connected.`);
    return match;
  }
  return devices[0];
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function ensureDevice(adb, sdkRoot, environment, requested, avdName) {
  let devices = connectedDevices(adb, environment);
  if (devices.length > 0) return selectDevice(devices, requested);
  if (requested) throw new Error(`Android device ${requested} is not connected.`);

  const emulator = join(sdkRoot, "emulator", "emulator");
  if (!existsSync(emulator)) throw new Error("No Android device is connected and the SDK emulator is not installed.");
  const avds = runOrThrow(emulator, ["-list-avds"], { env: environment }).split("\n").filter(Boolean);
  if (!avds.includes(avdName)) {
    throw new Error(`No Android device is connected and virtual device ${avdName} does not exist. Run doctor:android for setup instructions.`);
  }
  console.log(`Starting Android virtual device ${avdName}…`);
  const child = spawn(emulator, [`@${avdName}`, "-no-boot-anim", "-no-audio", "-no-metrics", "-no-snapshot-save", "-gpu", "host"], {
    detached: true,
    env: environment,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await delay(2_000);
    devices = connectedDevices(adb, environment);
    const device = devices[0];
    if (!device) continue;
    const booted = run(adb, ["-s", device.serial, "shell", "getprop", "sys.boot_completed"], { env: environment });
    if (booted.stdout?.trim() === "1") return device;
  }
  throw new Error(`Virtual device ${avdName} did not finish starting within two minutes.`);
}

function ensureNativeProject(environment) {
  if (existsSync(join(packageDirectory, "android", "gradlew"))) return;
  console.log("Generating the native Android project…");
  runOrThrow("pnpm", ["--filter", "@t4-code/companion", "exec", "expo", "prebuild", "--platform", "android", "--no-install"], {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
    timeout: 5 * 60_000,
  });
}

function buildRelease(adb, device, environment) {
  ensureNativeProject(environment);
  const abi = runOrThrow(adb, ["-s", device.serial, "shell", "getprop", "ro.product.cpu.abi"], { env: environment });
  console.log(`Building the Android Release app for ${abi}…`);
  runOrThrow(join(packageDirectory, "android", "gradlew"), ["app:assembleRelease", `-PreactNativeArchitectures=${abi}`], {
    cwd: join(packageDirectory, "android"),
    env: environment,
    stdio: "inherit",
    timeout: 20 * 60_000,
  });
  if (!existsSync(releaseApk)) throw new Error("The Android build completed without producing the expected Release APK.");
}

async function main(argumentsList) {
  const options = parseAndroidArguments(argumentsList);
  if (options.help) {
    printUsage();
    return;
  }
  const sdkRoot = resolveAndroidSdkRoot();
  if (!sdkRoot) throw new Error("Android SDK not found. Run doctor:android for the exact setup steps.");
  const javaHome = resolveAndroidJavaHome();
  if (!javaHome) throw new Error("Java 17 or 21 not found. Install openjdk@17, then rerun this command.");
  const environment = androidEnvironment(sdkRoot, javaHome);
  const adb = adbPath(sdkRoot);
  const device = await ensureDevice(adb, sdkRoot, environment, options.device, options.avd);
  const address = resolveTailnetAddress(options.url);
  const deepLink = companionDeepLink(address);

  console.log(`Android: ${device.model} (${device.serial})`);
  console.log(`T4 host: ${address}`);

  if (!options.launchOnly) {
    if (!options.reuseBuild) buildRelease(adb, device, environment);
    if (!existsSync(releaseApk)) throw new Error("No reusable Release APK exists. Run without --reuse-build first.");
    console.log("Installing the Release app…");
    runOrThrow(adb, ["-s", device.serial, "install", "-r", releaseApk], { env: environment, timeout: 3 * 60_000 });
  }

  if (options.noLaunch) {
    console.log(`Installed. Open T4 Companion on Android; its host is ${address}`);
    return;
  }
  console.log("Opening T4 Companion with the saved Tailnet address…");
  run(adb, ["-s", device.serial, "shell", "am", "force-stop", applicationId], { env: environment });
  runOrThrow(adb, ["-s", device.serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", deepLink, applicationId], { env: environment });
  await delay(2_000);
  const pid = runOrThrow(adb, ["-s", device.serial, "shell", "pidof", applicationId], { env: environment });
  console.log(`T4 Companion is installed, open, and configured (process ${pid}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`\nT4 Android setup stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
