import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "dist", "out", "target"]);
const allowedRepositoryOwners = new Set(["lycaonllc", "roycorp", "usr-bin-roygbiv"]);
const machineNodePattern = /\bk3s-(?:epyc|worker)-\d+\b/gu;
const semanticT4TailnetPattern = /\bt4-[a-z0-9-]+\.tailb18de3\.ts\.net\b/giu;
const hostedRepositoryPattern =
  /(?:github\.com[/:]|gitlab\.com[/:]|api\.github\.com\/repos\/|raw\.githubusercontent\.com\/)([A-Za-z0-9_.-]+)\/t4-code\b/giu;

async function sourceFiles(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await sourceFiles(path, files);
    } else if (entry.isFile() && (await stat(path)).size <= 2_000_000) {
      files.push(path);
    }
  }
  return files;
}

function matchesFor(path, text) {
  const matches = [];
  for (const value of text.matchAll(machineNodePattern)) {
    matches.push({ file: path, kind: "machine-node", value: value[0] });
  }
  for (const value of text.matchAll(semanticT4TailnetPattern)) {
    matches.push({ file: path, kind: "semantic-tailnet-host", value: value[0] });
  }
  for (const value of text.matchAll(hostedRepositoryPattern)) {
    if (!allowedRepositoryOwners.has(value[1].toLowerCase())) {
      matches.push({ file: path, kind: "repository-owner", value: value[1] });
    }
  }
  return matches;
}

test("repository-owner matching ignores filesystem paths and catches actual remotes", () => {
  const safe = [
    "state/t4-code",
    "$RUNNER_TEMP/t4-code",
    "/tmp/t4-code",
    "https://github.com/LycaonLLC/t4-code",
    "git@github.com:usr-bin-roygbiv/t4-code.git",
    "https://gitlab.com/roycorp/t4-code",
  ].join("\n");
  assert.deepEqual(matchesFor("fixture.txt", safe), []);
  assert.deepEqual(
    matchesFor("fixture.txt", ["https://github.com", "private-owner", "t4-code"].join("/")),
    [{ file: "fixture.txt", kind: "repository-owner", value: "private-owner" }],
  );
});

test("public source contains no machine names or personal repository owners", async () => {
  const matches = [];
  for (const path of await sourceFiles(repoRoot)) {
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;
    matches.push(...matchesFor(relative(repoRoot, path), bytes.toString("utf8")));
  }

  assert.deepEqual(matches, []);
});
