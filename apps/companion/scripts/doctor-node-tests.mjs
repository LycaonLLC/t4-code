import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDoctor } from "./doctor.mjs";

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
