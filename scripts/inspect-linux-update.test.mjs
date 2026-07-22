import assert from "node:assert/strict";
import test from "node:test";

import {
  parseLinuxUpdateMetadata,
  validateLinuxUpdateMetadata,
} from "./inspect-linux-update.mjs";

const version = "0.1.17";
const deb = `T4-Code-${version}-linux-amd64.deb`;
const archive = `T4-Code-${version}-linux-x86_64.tar.gz`;
const debHash = Buffer.alloc(64, 1).toString("base64");
const appImageHash = Buffer.alloc(64, 2).toString("base64");
const valid = `version: ${version}
files:
  - url: ${archive}
    sha512: ${appImageHash}
    size: 200
  - url: ${deb}
    sha512: ${debHash}
    size: 100
path: ${archive}
sha512: ${appImageHash}
releaseDate: '2026-07-15T20:00:00.000Z'
`;
const artifacts = new Map([
  [deb, { size: 100, sha512: debHash }],
  [archive, { size: 200, sha512: appImageHash }],
]);

test("parses Flutter Linux metadata without a general YAML dependency", () => {
  assert.deepEqual(parseLinuxUpdateMetadata(valid), {
    version,
    files: [
      { url: archive, sha512: appImageHash, size: "200" },
      { url: deb, sha512: debHash, size: "100" },
    ],
    path: archive,
    sha512: appImageHash,
    releaseDate: "2026-07-15T20:00:00.000Z",
  });
});

test("accepts exact deb and portable archive names, sizes, and SHA-512 digests", () => {
  assert.equal(validateLinuxUpdateMetadata(valid, { version, artifacts }).files.length, 2);
});

test("rejects missing, renamed, duplicated, or mismatched Linux updater entries", () => {
  const cases = [
    valid.replace(`  - url: ${deb}\n    sha512: ${debHash}\n    size: 100\n`, ""),
    valid.replace(deb, "renamed.deb"),
    valid.replace(`  - url: ${deb}`, `  - url: ${archive}`),
    valid.replace(debHash, Buffer.alloc(64, 3).toString("base64")),
    valid.replace("size: 100", "size: 99"),
    valid.replace("    size: 200", "    size: 200\n    blockMapSize: 20"),
    valid.replace(`path: ${archive}\nsha512: ${appImageHash}`, `path: ${archive}\nsha512: ${debHash}`),
  ];
  for (const candidate of cases) {
    assert.throws(() => validateLinuxUpdateMetadata(candidate, { version, artifacts }));
  }
});

test("rejects metadata version drift and unsupported YAML structure", () => {
  assert.throws(
    () => validateLinuxUpdateMetadata(valid.replace(version, "9.9.9"), { version, artifacts }),
    /version/u,
  );
  assert.throws(() => parseLinuxUpdateMetadata(`${valid}  nested: nope\n`), /unsupported syntax/u);
});
