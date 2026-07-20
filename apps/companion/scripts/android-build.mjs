#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const packageDirectory = resolve(import.meta.dirname, "..");
const androidDirectory = join(packageDirectory, "android");
const releaseApk = join(androidDirectory, "app", "build", "outputs", "apk", "release", "app-release.apk");
const signingVariables = Object.freeze([
  "T4_ANDROID_KEYSTORE_PATH",
  "T4_ANDROID_KEYSTORE_PASSWORD",
  "T4_ANDROID_KEY_ALIAS",
  "T4_ANDROID_KEY_PASSWORD",
]);

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 20 * 60_000,
    ...options,
  });
  if (result.status !== 0) throw new Error(output(result) || `${command} exited with status ${result.status}.`);
}

export function parseAndroidBuildArguments(argumentsList) {
  if (argumentsList.length !== 1 || !["check", "release", "--help"].includes(argumentsList[0])) {
    throw new Error("usage: android-build.mjs <check|release>");
  }
  return argumentsList[0];
}

export function missingSigningVariables(environment = process.env) {
  return signingVariables.filter((name) => typeof environment[name] !== "string" || environment[name].length === 0);
}

export function androidGradleArguments(mode) {
  return mode === "check"
    ? [
        "app:testDebugUnitTest",
        "app:assembleDebug",
        "app:lintDebug",
        // Worklets and Reanimated 4 crash under AGP 9 lint analysis; app lint still runs.
        "-x",
        "react-native-worklets:lintAnalyzeDebug",
        "-x",
        "react-native-reanimated:lintAnalyzeDebug",
      ]
    : ["app:assembleRelease"];
}

function printUsage() {
  console.log(`Generate and compile the native Expo Android project.

Usage:
  node scripts/android-build.mjs check
  node scripts/android-build.mjs release

The release command requires ${signingVariables.join(", ")}.`);
}

function generateNativeProject() {
  run("pnpm", ["exec", "expo", "prebuild", "--clean", "--platform", "android", "--no-install"], {
    timeout: 5 * 60_000,
  });
  const wrapper = join(androidDirectory, "gradlew");
  if (!existsSync(wrapper)) throw new Error("Expo prebuild completed without generating android/gradlew.");
  return wrapper;
}

function main(argumentsList) {
  const mode = parseAndroidBuildArguments(argumentsList);
  if (mode === "--help") {
    printUsage();
    return;
  }
  if (mode === "release") {
    const missing = missingSigningVariables();
    if (missing.length > 0) throw new Error(`Android release signing is incomplete: ${missing.join(", ")}.`);
    if (!existsSync(process.env.T4_ANDROID_KEYSTORE_PATH)) {
      throw new Error("T4_ANDROID_KEYSTORE_PATH does not point to a file.");
    }
  }

  const wrapper = generateNativeProject();
  run(wrapper, androidGradleArguments(mode), { cwd: androidDirectory });

  if (mode === "release" && !existsSync(releaseApk)) {
    throw new Error("The Android build completed without producing app-release.apk.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
