import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeCanonicalTemporaryDirectory(prefix) {
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const canonicalRoot = await realpath(temporaryRoot);
  return realpath(await mkdtemp(join(canonicalRoot, prefix)));
}
