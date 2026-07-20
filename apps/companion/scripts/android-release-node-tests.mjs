import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

import {
  androidGradleArguments,
  missingSigningVariables,
  parseAndroidBuildArguments,
} from "./android-build.mjs";

const require = createRequire(import.meta.url);
const { applyAndroidReleaseSigning } = require("../plugins/with-android-release-signing.cjs");

const expoTemplate = `def enableMinifyInReleaseBuilds = (findProperty('android.enableMinifyInReleaseBuilds') ?: false).toBoolean()

android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
        }
    }
}
`;

test("Android release build arguments are closed over supported modes", () => {
  assert.equal(parseAndroidBuildArguments(["check"]), "check");
  assert.equal(parseAndroidBuildArguments(["release"]), "release");
  assert.throws(() => parseAndroidBuildArguments([]), /usage/u);
  assert.throws(() => parseAndroidBuildArguments(["release", "extra"]), /usage/u);
});

test("Android checks skip the incompatible worklets dependency lint task", () => {
  assert.deepEqual(androidGradleArguments("check"), [
    "app:testDebugUnitTest",
    "app:assembleDebug",
    "app:lintDebug",
    "-x",
    "react-native-worklets:lintAnalyzeDebug",
    "-x",
    "react-native-reanimated:lintAnalyzeDebug",
  ]);
  assert.deepEqual(androidGradleArguments("release"), ["app:assembleRelease"]);
});

test("release signing requires every credential without exposing values", () => {
  const complete = {
    T4_ANDROID_KEYSTORE_PATH: "/tmp/release.jks",
    T4_ANDROID_KEYSTORE_PASSWORD: "store-secret",
    T4_ANDROID_KEY_ALIAS: "release",
    T4_ANDROID_KEY_PASSWORD: "key-secret",
  };
  assert.deepEqual(missingSigningVariables(complete), []);
  assert.deepEqual(missingSigningVariables({ ...complete, T4_ANDROID_KEY_PASSWORD: "" }), [
    "T4_ANDROID_KEY_PASSWORD",
  ]);
});

test("config plugin replaces debug release signing idempotently", () => {
  const configured = applyAndroidReleaseSigning(expoTemplate);
  assert.match(configured, /T4 managed release signing/u);
  assert.match(configured, /System\.getenv\('T4_ANDROID_KEYSTORE_PATH'\)/u);
  assert.ok(configured.includes("debug {\n            signingConfig signingConfigs.debug"));
  assert.ok(
    configured.includes(
      "release {\n            signingConfig t4HasReleaseSigning ? signingConfigs.release : signingConfigs.debug",
    ),
  );
  assert.equal(applyAndroidReleaseSigning(configured), configured);
});

test("config plugin fails closed when the Expo template changes", () => {
  assert.throws(() => applyAndroidReleaseSigning("android {}"), /expected release property anchor/u);
});
