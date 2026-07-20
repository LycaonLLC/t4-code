const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// T4 managed release signing";

function applyAndroidReleaseSigning(contents) {
  if (contents.includes(MARKER)) return contents;

  const propertyAnchor =
    "def enableMinifyInReleaseBuilds = (findProperty('android.enableMinifyInReleaseBuilds') ?: false).toBoolean()";
  const signingAnchor = "    signingConfigs {\n        debug {";
  const buildTypesAnchor = "    buildTypes {";
  const releaseBlockAnchor = "\n        release {";
  const releaseBlockEndAnchor = "\n        }\n    }";
  const releaseSigningAnchor = "            signingConfig signingConfigs.debug";

  if (!contents.includes(propertyAnchor)) {
    throw new Error("Expo Android template no longer exposes the expected release property anchor.");
  }
  if (!contents.includes(signingAnchor)) {
    throw new Error("Expo Android template no longer exposes the expected signingConfigs anchor.");
  }
  const buildTypesStart = contents.indexOf(buildTypesAnchor);
  const releaseBlockStart = contents.indexOf(releaseBlockAnchor, buildTypesStart);
  const releaseBlockEnd = contents.indexOf(releaseBlockEndAnchor, releaseBlockStart);
  const releaseSigningStart = contents.indexOf(releaseSigningAnchor, releaseBlockStart);
  if (
    buildTypesStart < 0 ||
    releaseBlockStart < 0 ||
    releaseBlockEnd < 0 ||
    releaseSigningStart < 0 ||
    releaseSigningStart > releaseBlockEnd
  ) {
    throw new Error("Expo Android template no longer exposes the expected release signing anchor.");
  }

  const properties = `${propertyAnchor}\n\n${MARKER}\ndef t4ReleaseKeystorePath = System.getenv('T4_ANDROID_KEYSTORE_PATH')\ndef t4ReleaseKeystorePassword = System.getenv('T4_ANDROID_KEYSTORE_PASSWORD')\ndef t4ReleaseKeyAlias = System.getenv('T4_ANDROID_KEY_ALIAS')\ndef t4ReleaseKeyPassword = System.getenv('T4_ANDROID_KEY_PASSWORD')\ndef t4HasReleaseSigning = [\n    t4ReleaseKeystorePath,\n    t4ReleaseKeystorePassword,\n    t4ReleaseKeyAlias,\n    t4ReleaseKeyPassword,\n].every { value -> value != null && !value.isBlank() }`;

  const signing = `    signingConfigs {\n        if (t4HasReleaseSigning) {\n            release {\n                storeFile file(t4ReleaseKeystorePath)\n                storePassword t4ReleaseKeystorePassword\n                keyAlias t4ReleaseKeyAlias\n                keyPassword t4ReleaseKeyPassword\n            }\n        }\n        debug {`;

  const releaseConfigured = `${contents.slice(0, releaseSigningStart)}            signingConfig t4HasReleaseSigning ? signingConfigs.release : signingConfigs.debug${contents.slice(releaseSigningStart + releaseSigningAnchor.length)}`;
  return releaseConfigured.replace(propertyAnchor, properties).replace(signingAnchor, signing);
}

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== "groovy") {
      throw new Error("T4 Android release signing requires a Groovy app/build.gradle file.");
    }
    modConfig.modResults.contents = applyAndroidReleaseSigning(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = withAndroidReleaseSigning;
module.exports.applyAndroidReleaseSigning = applyAndroidReleaseSigning;
