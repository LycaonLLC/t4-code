import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  collectReleaseConsistencyErrors,
  loadReleaseContractFiles,
} from "./check-release-consistency.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const files = loadReleaseContractFiles(repoRoot);

function changed(path, replace) {
  const copy = new Map(files);
  copy.set(path, replace(copy.get(path)));
  return copy;
}

test("current source tree has one consistent release version", () => {
  assert.deepEqual(collectReleaseConsistencyErrors(files, "v0.1.18"), []);
});

test("rejects a tag that differs from the package version", () => {
  assert.ok(
    collectReleaseConsistencyErrors(files, "v9.9.9").some((error) =>
      error.includes("release tag v9.9.9 does not match v0.1.18"),
    ),
  );
});

test("rejects workspace, site, README, and runtime version drift", () => {
  const cases = [
    ["apps/web/package.json", (text) => text.replace('"version": "0.1.18"', '"version": "0.1.3"')],
    [
      "apps/site/src/release.ts",
      (text) => text.replace('RELEASE_TAG = "v0.1.18"', 'RELEASE_TAG = "v0.1.3"'),
    ],
    ["README.md", (text) => text.replace("Download v0.1.18", "Download v0.1.3")],
    [
      "apps/desktop/src/target-manager.ts",
      (text) => text.replace('version: "0.1.18"', 'version: "0.1.3"'),
    ],
    [
      "apps/site/src/docs/content.ts",
      (text) => text.replace('id: "troubleshooting-large-session"', 'id: "missing-large-session"'),
    ],
  ];
  for (const [path, replace] of cases) {
    assert.ok(
      collectReleaseConsistencyErrors(changed(path, replace)).length > 0,
      `${path} drift should fail`,
    );
  }
});

test("rejects version drift in a newly added workspace package", () => {
  const withNewPackage = new Map(files);
  withNewPackage.set(
    "packages/new-workspace/package.json",
    JSON.stringify({ name: "@t4-code/new-workspace", version: "0.1.3", private: true }),
  );
  assert.ok(
    collectReleaseConsistencyErrors(withNewPackage).some((error) =>
      error.includes("packages/new-workspace/package.json version"),
    ),
  );
});

test("rejects updater channel, stable manifest, and publication-contract drift", () => {
  const cases = [
    [
      "electron-builder.config.mjs",
      (text) => text.replace('repo: "t4-code"', 'repo: "renamed"'),
    ],
    [
      "scripts/generate-release-manifest.mjs",
      (text) => text.replace("RELEASE_MANIFEST_SCHEMA_VERSION = 1", "RELEASE_MANIFEST_SCHEMA_VERSION = 2"),
    ],
    [
      "scripts/wait-for-release-assets.mjs",
      (text) => text.replace(', "latest-linux.yml"', ""),
    ],
    [
      ".github/workflows/release.yml",
      (text) => text.replace("artifacts/latest-linux.yml", "artifacts/missing-linux.yml"),
    ],
    [
      "scripts/reconcile-release-assets.mjs",
      (text) => text.replace('method: "DELETE"', 'method: "POST"'),
    ],
    [
      "scripts/dispatch-site-deployment.mjs",
      (text) => text.replace("body: { ref: tag", 'body: { ref: "main"'),
    ],
    [
      ".github/workflows/deploy-site.yml",
      (text) => text.replace("startsWith(github.ref, 'refs/tags/')", "github.ref == 'refs/heads/main'"),
    ],
  ];
  for (const [path, replace] of cases) {
    assert.ok(
      collectReleaseConsistencyErrors(changed(path, replace)).length > 0,
      `${path} updater drift should fail`,
    );
  }
});

test("rejects app-wire matrix changes until the release surfaces agree", () => {
  const drifted = changed("compat/omp-app-matrix.json", (text) =>
    text.replace('"version": "0.5.5"', '"version": "0.5.1"'),
  );
  assert.ok(collectReleaseConsistencyErrors(drifted).length > 0);
});

test("rejects app-wire provenance changes until the release surfaces agree", () => {
  const drifted = changed("compat/omp-app-matrix.json", (text) =>
    text.replace(
      '"sourceCommit": "6a87fa6407ebff20417b4d52885a6bb3091003ea"',
      '"sourceCommit": "0000000000000000000000000000000000000000"',
    ),
  );
  assert.ok(
    collectReleaseConsistencyErrors(drifted).some(
      (error) => error.startsWith("README.md") || error.startsWith("docs/CURRENT_RELEASE_NOTES.md"),
    ),
  );
});

test("rejects drift between the compatibility matrix and vendored app-wire manifest", () => {
  const drifted = changed("vendor/app-wire/manifest.json", (text) =>
    text.replace(
      '"sourceTreeHash": "a2495fe8781c979184fe7fb9a6d37d8f33bad30f"',
      '"sourceTreeHash": "0000000000000000000000000000000000000000"',
    ),
  );
  assert.ok(
    collectReleaseConsistencyErrors(drifted).some((error) =>
      error.includes("vendor/app-wire/manifest.json sourceTreeHash must match"),
    ),
  );
});

test("rejects drift in verified OMP runtime provenance", () => {
  const cases = [
    (text) =>
      text.replace(
        "6e2f2350cfe9e6f5db691c311333cae33cdb62ba",
        "0000000000000000000000000000000000000000",
      ),
    (text) => text.replace('"sourceTag": "t4code-17.0.0-appserver-1"', '"sourceTag": "wrong-tag"'),
    (text) =>
      text.replace(
        '"upstreamCommit": "d5cd24f39a951bfbd50dc8f50bcf095d59694d6c"',
        '"upstreamCommit": "0000000000000000000000000000000000000000"',
      ),
    (text) => text.replace('"complete-session-event-projection"', '"Wrong integration patch"'),
    (text) =>
      text.replace(
        '"upstreamTagContainsIntegrationPatches": false',
        '"upstreamTagContainsIntegrationPatches": true',
      ),
  ];
  for (const replace of cases) {
    const drifted = changed("compat/omp-app-matrix.json", replace);
    assert.ok(collectReleaseConsistencyErrors(drifted).length > 0);
  }
});

test("accepts a coordinated app-wire provenance update without editing the workflow", () => {
  const coordinated = new Map(files);
  coordinated.set(
    "compat/omp-app-matrix.json",
    coordinated
      .get("compat/omp-app-matrix.json")
      .replace('"version": "0.5.5"', '"version": "0.5.6"')
      .replace("oh-my-pi-app-wire-0.5.5.tgz", "oh-my-pi-app-wire-0.5.6.tgz"),
  );
  coordinated.set(
    "apps/site/src/release.ts",
    coordinated
      .get("apps/site/src/release.ts")
      .replace('APP_WIRE_VERSION = "0.5.5"', 'APP_WIRE_VERSION = "0.5.6"'),
  );
  coordinated.set(
    "README.md",
    coordinated
      .get("README.md")
      .replace("`@oh-my-pi/app-wire` 0.5.5", "`@oh-my-pi/app-wire` 0.5.6"),
  );
  coordinated.set(
    "docs/CURRENT_RELEASE_NOTES.md",
    coordinated.get("docs/CURRENT_RELEASE_NOTES.md").replace("app-wire 0.5.5", "app-wire 0.5.6"),
  );
  coordinated.set(
    "vendor/app-wire/manifest.json",
    coordinated
      .get("vendor/app-wire/manifest.json")
      .replace('"version": "0.5.5"', '"version": "0.5.6"')
      .replace("oh-my-pi-app-wire-0.5.5.tgz", "oh-my-pi-app-wire-0.5.6.tgz"),
  );

  assert.deepEqual(collectReleaseConsistencyErrors(coordinated), []);
  assert.equal(
    coordinated.get(".github/workflows/release.yml"),
    files.get(".github/workflows/release.yml"),
  );
});

test("rejects stale README release URLs while allowing historical prose", () => {
  const oldTag = ["v0", "1", "3"].join(".");
  const oldReleaseUrl = `https://github.com/LycaonLLC/t4-code/releases/tag/${oldTag}`;
  const staleLink = changed("README.md", (text) => `${text}\n[Old release](${oldReleaseUrl})\n`);
  assert.ok(
    collectReleaseConsistencyErrors(staleLink).some((error) =>
      error.includes("release URL for v0.1.3; expected v0.1.18"),
    ),
  );
  assert.deepEqual(collectReleaseConsistencyErrors(files), []);
});

test("deploys release site source only after artifact publication", () => {
  const ciWorkflow = files.get(".github/workflows/ci.yml");
  const releaseWorkflow = files.get(".github/workflows/release.yml");
  const deployWorkflow = files.get(".github/workflows/deploy-site.yml");

  assert.ok(ciWorkflow.includes("android-debug:"));
  assert.ok(ciWorkflow.includes("java-version: \"21\""));
  assert.ok(ciWorkflow.includes('sdkmanager --install "platforms;android-36" "build-tools;36.0.0"'));
  assert.ok(ciWorkflow.includes("pnpm --filter @t4-code/mobile check:android:debug"));
  assert.ok(!ciWorkflow.includes("T4_ANDROID_KEYSTORE_BASE64"));
  assert.equal(
    JSON.parse(files.get("apps/mobile/package.json")).scripts["check:android:debug"],
    "pnpm sync:android && node ./scripts/run-gradle.mjs testDebugUnitTest assembleDebug lintDebug",
  );

  assert.ok(releaseWorkflow.includes("github.ref == 'refs/heads/main'"));
  assert.ok(releaseWorkflow.includes("Check out trusted release-control source"));
  assert.ok(releaseWorkflow.includes("fetch-depth: 0"));
  assert.ok(releaseWorkflow.includes("Resolve immutable release source"));
  assert.ok(
    releaseWorkflow.includes('git merge-base --is-ancestor "$source_sha" refs/remotes/origin/main'),
  );
  assert.ok(releaseWorkflow.includes("ref: ${{ steps.source.outputs.source_sha }}"));
  assert.ok(releaseWorkflow.includes("ref: ${{ needs.verify.outputs.source_sha }}"));
  assert.ok(releaseWorkflow.includes("needs: [verify, build-android, build-linux, build-macos]"));
  assert.ok(releaseWorkflow.includes("pnpm --filter @t4-code/mobile build:android:release"));
  assert.ok(releaseWorkflow.includes("T4_ANDROID_KEYSTORE_BASE64"));
  assert.ok(releaseWorkflow.includes("node scripts/inspect-android-release.mjs"));
  assert.ok(releaseWorkflow.includes('--metadata "$metadata"'));
  assert.ok(releaseWorkflow.includes('--aapt "$build_tools/aapt"'));
  assert.ok(releaseWorkflow.includes('--apksigner "$build_tools/apksigner"'));
  assert.ok(
    releaseWorkflow.includes("Confirm the release tag still resolves to the verified source"),
  );
  assert.ok(
    releaseWorkflow.includes('test "$(git rev-parse "${RELEASE_TAG}^{commit}")" = "$SOURCE_SHA"'),
  );
  assert.ok(!releaseWorkflow.includes("ref: ${{ env.RELEASE_TAG }}"));
  assert.ok(
    releaseWorkflow.includes(
      "Preserve an exact release or prepare an incomplete release for repair",
    ),
  );
  assert.ok(releaseWorkflow.includes("Verify the exact remote release bundle"));
  assert.ok(
    releaseWorkflow.indexOf("--mode prepare") <
      releaseWorkflow.indexOf("softprops/action-gh-release@"),
  );
  assert.ok(
    releaseWorkflow.includes("if: steps.release-assets.outputs.publish_required == 'true'"),
  );
  assert.ok(releaseWorkflow.indexOf("softprops/action-gh-release@") < releaseWorkflow.indexOf("--mode verify"));
  assert.ok(releaseWorkflow.includes("needs: [verify, publish]"));
  assert.ok(releaseWorkflow.includes("actions: write"));
  assert.ok(releaseWorkflow.includes("node scripts/dispatch-site-deployment.mjs"));
  assert.ok(releaseWorkflow.includes('--tag "$RELEASE_TAG"'));
  assert.ok(releaseWorkflow.includes('--commit "$SOURCE_SHA"'));
  assert.ok(!releaseWorkflow.includes("gh workflow run deploy-site.yml"));
  assert.ok(!releaseWorkflow.includes("--ref main"));

  assert.ok(deployWorkflow.includes("workflow_dispatch:"));
  assert.ok(deployWorkflow.includes("release_tag:"));
  assert.ok(deployWorkflow.includes("dispatch_nonce:"));
  assert.ok(deployWorkflow.includes("inputs.dispatch_nonce || github.sha"));
  assert.ok(deployWorkflow.includes("startsWith(github.ref, 'refs/tags/')"));
  assert.ok(deployWorkflow.includes('[[ "$GITHUB_REF" != "refs/tags/${expected_tag}" ]]'));
  assert.ok(deployWorkflow.includes('expected_tag="v${TRUSTED_VERSION}"'));
  assert.ok(deployWorkflow.includes('release_tag="$expected_tag"'));
  assert.ok(deployWorkflow.includes("releases/tags/${release_tag}"));
  assert.ok(deployWorkflow.includes('[[ "$source_sha" != "$TRUSTED_SHA" ]]'));
  assert.ok(deployWorkflow.includes('git merge-base --is-ancestor "$source_sha" "$TRUSTED_SHA"'));
  assert.ok(deployWorkflow.includes("ref: ${{ steps.immutable_source.outputs.source_sha }}"));
  assert.ok(!deployWorkflow.includes('source_sha="$MAIN_SHA"'));
  assert.ok(!deployWorkflow.includes("cache: pnpm"));
  assert.ok(
    deployWorkflow.indexOf("Resolve immutable deployment source") >
      deployWorkflow.indexOf("Classify the stable release referenced by an ordinary main push"),
  );
  assert.ok(!deployWorkflow.includes("source_ref:"));
  assert.ok(!deployWorkflow.includes("release_published:"));
  assert.ok(deployWorkflow.includes("steps.release_state.outputs.state == 'not-published'"));
  assert.ok(!deployWorkflow.includes("continue-on-error: true"));
  assert.ok(deployWorkflow.includes("branches: [main, master]"));
});
