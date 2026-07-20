import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const adrDirectory = resolve(import.meta.dirname, "..", "docs", "adr");
const filePattern = /^(\d{3})-.*\.md$/u;
const titlePattern = /^# ADR(?:-| )(\d{3}):/u;

test("ADR file and title numbers are unique and agree", () => {
  const records = readdirSync(adrDirectory)
    .map((file) => ({ file, match: filePattern.exec(file) }))
    .filter((record) => record.match !== null)
    .map(({ file, match }) => {
      const firstLine = readFileSync(join(adrDirectory, file), "utf8").split(/\r?\n/u, 1)[0];
      const title = titlePattern.exec(firstLine);
      assert.ok(title, `${file} must start with \"# ADR-NNN:\" or \"# ADR NNN:\"`);
      assert.equal(title[1], match[1], `${file} title must use ADR ${match[1]}`);
      return { file, number: match[1] };
    });

  const byNumber = new Map();
  for (const record of records) {
    const previous = byNumber.get(record.number);
    assert.equal(previous, undefined, `ADR ${record.number} is used by ${previous} and ${record.file}`);
    byNumber.set(record.number, record.file);
  }

  assert.ok(records.length > 0, "expected at least one ADR");
});
