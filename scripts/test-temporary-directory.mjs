import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeCanonicalTemporaryDirectory(prefix) {
  if (
    typeof prefix !== "string" ||
    prefix.length === 0 ||
    prefix === "." ||
    prefix === ".." ||
    /[\\/]/u.test(prefix) ||
    prefix.includes("\0")
  ) {
    throw new TypeError("temporary directory prefix must be a simple filename prefix");
  }
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const canonicalRoot = await realpath(temporaryRoot);
  return realpath(await mkdtemp(join(canonicalRoot, prefix)));
}
