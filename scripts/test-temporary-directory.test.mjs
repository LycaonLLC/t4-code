import assert from "node:assert/strict";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { test } from "node:test";

import { makeCanonicalTemporaryDirectory } from "./test-temporary-directory.mjs";

test("canonical test directories stay directly under the platform temporary root", async (t) => {
  const directory = await makeCanonicalTemporaryDirectory("t4-canonical-temp-");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  assert.equal(directory, await realpath(directory));
  assert.equal(dirname(directory), await realpath(temporaryRoot));
});

test("canonical test directories reject path-shaped prefixes", async () => {
  for (const prefix of ["", ".", "..", "../escape-", "nested/prefix-", "nested\\prefix-", "bad\0prefix-"]) {
    await assert.rejects(
      makeCanonicalTemporaryDirectory(prefix),
      /temporary directory prefix must be a simple filename prefix/u,
    );
  }
});
