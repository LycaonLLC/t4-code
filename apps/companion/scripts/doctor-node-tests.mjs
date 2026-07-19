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
