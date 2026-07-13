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
  assert.deepEqual(collectReleaseConsistencyErrors(files, "v0.1.5"), []);
});

test("rejects a tag that differs from the package version", () => {
  assert.ok(
    collectReleaseConsistencyErrors(files, "v9.9.9").some((error) =>
      error.includes("release tag v9.9.9 does not match v0.1.5"),
    ),
  );
});

test("rejects workspace, site, README, and runtime version drift", () => {
  const cases = [
    ["apps/web/package.json", (text) => text.replace('"version": "0.1.5"', '"version": "0.1.3"')],
    ["apps/site/src/release.ts", (text) => text.replace('RELEASE_TAG = "v0.1.5"', 'RELEASE_TAG = "v0.1.3"')],
    ["README.md", (text) => text.replace("Download v0.1.5", "Download v0.1.3")],
    ["apps/desktop/src/target-manager.ts", (text) => text.replace('version: "0.1.5"', 'version: "0.1.3"')],
    ["apps/site/src/docs/content.ts", (text) => text.replace('id: "troubleshooting-large-session"', 'id: "missing-large-session"')],
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

test("rejects an app-wire compatibility bump hidden inside a desktop release", () => {
  const drifted = changed("compat/omp-app-matrix.json", (text) =>
    text.replace('"version": "0.5.1"', '"version": "0.5.2"'),
  );
  assert.ok(
    collectReleaseConsistencyErrors(drifted).some((error) => error.includes("must remain 0.5.1")),
  );
});

test("rejects drift in verified OMP runtime provenance", () => {
  const cases = [
    (text) => text.replace(
      "f65bb37970d2186f04ec4b650eb0b53ec3b1337b",
      "0000000000000000000000000000000000000000",
    ),
    (text) => text.replace('"upstreamTagContainsLargeSessionFix": false', '"upstreamTagContainsLargeSessionFix": true'),
  ];
  for (const replace of cases) {
    const drifted = changed("compat/omp-app-matrix.json", replace);
    assert.ok(
      collectReleaseConsistencyErrors(drifted).some((error) => error.includes("verified runtime") || error.includes("stock upstream")),
    );
  }
});

test("rejects stale README release URLs while allowing historical prose", () => {
  const oldTag = ["v0", "1", "3"].join(".");
  const oldReleaseUrl = `https://github.com/LycaonLLC/t4-code/releases/tag/${oldTag}`;
  const staleLink = changed("README.md", (text) =>
    `${text}\n[Old release](${oldReleaseUrl})\n`,
  );
  assert.ok(
    collectReleaseConsistencyErrors(staleLink).some((error) =>
      error.includes("release URL for v0.1.3; expected v0.1.5"),
    ),
  );
  assert.deepEqual(collectReleaseConsistencyErrors(files), []);
});
