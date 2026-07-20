import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDoctor, hasPairedIphone } from "./doctor.mjs";
import {
  appleTeamIdFromCertificateSubject,
  companionDeepLink,
  launchFailureIsLocked,
  pairedPhysicalIphones,
  parseArguments,
} from "./ios-device.mjs";
import {
  parseAdbDevices,
  parseAndroidArguments,
  resolveAndroidSdkRoot,
} from "./android-device.mjs";

const ready = Object.freeze({
  nodeMajor: 24,
  nodeVersion: "24.17.0",
  checkoutHasSpaces: false,
  tailnetName: "mac.example.ts.net",
  xcodeAvailable: true,
  xcodeVersion: "Xcode 26.5",
  iphoneAvailable: true,
  appleDevelopmentIdentity: true,
  androidSdkAvailable: true,
  androidSdkRoot: "/sdk",
  adbAvailable: true,
  androidJavaVersion: "17",
  androidTargetAvailable: true,
});

test("all-platform readiness passes when every prerequisite is present", () => {
  assert.equal(evaluateDoctor(ready).every((check) => check.ok), true);
});

test("iOS mode reports signing and path problems without requiring Android", () => {
  const checks = evaluateDoctor({
    ...ready,
    checkoutHasSpaces: true,
    appleDevelopmentIdentity: false,
    androidSdkAvailable: false,
    adbAvailable: false,
  }, "ios");
  assert.deepEqual(
    checks.filter((check) => !check.ok).map((check) => check.name),
    ["Checkout path", "Apple development signing"],
  );
  assert.equal(checks.some((check) => check.name === "Android SDK"), false);
});

test("Android mode reports the SDK and device-tools repair actions", () => {
  const checks = evaluateDoctor({ ...ready, androidSdkAvailable: false, adbAvailable: false }, "android");
  assert.deepEqual(
    checks.filter((check) => !check.ok).map((check) => check.name),
    ["Android SDK", "Android device tools"],
  );
  assert.equal(checks.some((check) => check.name === "Xcode"), false);
});

test("Android mode does not claim readiness without Java and a target", () => {
  const checks = evaluateDoctor({ ...ready, androidJavaVersion: "", androidTargetAvailable: false }, "android");
  assert.deepEqual(
    checks.filter((check) => !check.ok).map((check) => check.name),
    ["Android Java", "Android target"],
  );
});

test("physical-iPhone detection accepts Apple's current table order", () => {
  const output = [
    "Name     Identifier    State                Model",
    "iPhone   device-id    available (paired)   iPhone 16 Pro (iPhone17,1)",
  ].join("\n");
  assert.equal(hasPairedIphone(output), true);
});

test("physical-iPhone detection ignores a paired iPad with an iPhone device name", () => {
  const output = "iPhone   device-id   available (paired)   iPad Pro 11-inch (iPad17,1)";
  assert.equal(hasPairedIphone(output), false);
});

test("native installer selects only paired physical iPhones and prefers the latest", () => {
  const device = (type, date, pairingState = "paired") => ({
    connectionProperties: { pairingState, lastConnectionDate: date },
    hardwareProperties: { deviceType: type, reality: "physical" },
  });
  const olderIphone = device("iPhone", "2026-01-01T00:00:00Z");
  const newerIphone = device("iPhone", "2026-07-01T00:00:00Z");
  assert.deepEqual(
    pairedPhysicalIphones([
      olderIphone,
      device("iPad", "2026-08-01T00:00:00Z"),
      newerIphone,
      device("iPhone", "2026-09-01T00:00:00Z", "unpaired"),
    ]),
    [newerIphone, olderIphone],
  );
});

test("native installer extracts the signing team and builds an encoded deep link", () => {
  assert.equal(
    appleTeamIdFromCertificateSubject("subject=UID=person, CN=Apple Development: Person, OU=ABCDEFGHIJ, O=Person, C=US"),
    "ABCDEFGHIJ",
  );
  assert.equal(
    companionDeepLink("https://mac.example.ts.net:8445"),
    "t4companion://?address=https%3A%2F%2Fmac.example.ts.net%3A8445",
  );
});

test("native installer parses safe workflow switches", () => {
  assert.deepEqual(parseArguments(["--device", "phone-id", "--reuse-build", "--no-launch"]), {
    device: "phone-id",
    team: "",
    url: "",
    reuseBuild: true,
    launchOnly: false,
    noLaunch: true,
    help: false,
  });
  assert.throws(() => parseArguments(["--mystery"]), /Unknown option/u);
  assert.throws(() => parseArguments(["--launch-only", "--no-launch"]), /cannot be used together/u);
  assert.equal(launchFailureIsLocked("request denied: Locked"), true);
});

test("Android installer selects connected devices from adb output", () => {
  const output = [
    "List of devices attached",
    "emulator-5554 device product:sdk_phone model:Pixel_8 device:emu64a transport_id:1",
    "offline-phone offline transport_id:2",
  ].join("\n");
  assert.deepEqual(parseAdbDevices(output), [{ serial: "emulator-5554", model: "Pixel 8" }]);
});

test("Android installer parses the repeatable build workflow", () => {
  assert.deepEqual(parseAndroidArguments(["--device", "emulator-5554", "--reuse-build", "--no-launch"]), {
    device: "emulator-5554",
    avd: "T4_Pixel_API_36",
    url: "",
    reuseBuild: true,
    launchOnly: false,
    noLaunch: true,
    help: false,
  });
  assert.throws(() => parseAndroidArguments(["--mystery"]), /Unknown option/u);
  assert.throws(() => parseAndroidArguments(["--launch-only", "--no-launch"]), /cannot be used together/u);
});

test("Android installer recognizes a standard SDK", () => {
  const existing = new Set([
    "/Users/test/Library/Android/sdk/platforms",
  ]);
  const pathExists = (path) => existing.has(path);
  assert.equal(resolveAndroidSdkRoot({ ANDROID_HOME: "/missing" }, "/Users/test", pathExists), "/Users/test/Library/Android/sdk");
});
