import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface BundledRuntimeManifest {
  readonly version: 1;
  readonly tag: string;
  readonly platform: "darwin";
  readonly arch: "arm64";
  readonly executable: "omp";
  readonly size: number;
  readonly sha256: string;
}

function decodeManifest(value: unknown): BundledRuntimeManifest {
  const record = value as Partial<BundledRuntimeManifest> | null;
  if (
    record?.version !== 1 ||
    record.platform !== "darwin" ||
    record.arch !== "arm64" ||
    record.executable !== "omp" ||
    typeof record.tag !== "string" ||
    !/^t4code-[0-9]+\.[0-9]+\.[0-9]+-appserver-[1-9][0-9]*$/u.test(record.tag) ||
    !Number.isSafeInteger(record.size) ||
    (record.size ?? 0) < 1 ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.sha256)
  ) throw new Error("bundled OMP runtime manifest is invalid");
  return record as BundledRuntimeManifest;
}

async function matches(path: string, manifest: BundledRuntimeManifest): Promise<boolean> {
  try {
    if ((await stat(path)).size !== manifest.size) return false;
    const hash = createHash("sha256").update(await readFile(path)).digest("hex");
    return hash === manifest.sha256;
  } catch {
    return false;
  }
}

export async function installBundledOmpRuntime(options: {
  readonly resourcesPath: string;
  readonly applicationSupportPath: string;
}): Promise<string> {
  const sourceRoot = join(options.resourcesPath, "runtime");
  const manifest = decodeManifest(JSON.parse(await readFile(join(sourceRoot, "manifest.json"), "utf8")));
  const source = join(sourceRoot, manifest.executable);
  if (!(await matches(source, manifest))) throw new Error("bundled OMP runtime failed its integrity check");
  const destinationRoot = join(options.applicationSupportPath, "runtime", manifest.tag);
  const destination = join(destinationRoot, "omp");
  if (await matches(destination, manifest)) {
    await chmod(destination, 0o755);
    return destination;
  }
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const temporary = join(destinationRoot, `.omp-${randomUUID()}.partial`);
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o755);
    if (!(await matches(temporary, manifest))) throw new Error("installed OMP runtime failed its integrity check");
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return destination;
}
