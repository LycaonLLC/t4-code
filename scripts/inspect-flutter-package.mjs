import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./flutter-packaging.mjs";

export function locateAppRoot(path) {
  const absolute = resolve(path);
  return absolute.endsWith("/Contents") ? absolute : join(absolute, "Contents");
}

export function inspectPackage(contentsPath) {
  const contents = locateAppRoot(contentsPath);
  const executables = join(contents, "MacOS");
  const host = join(contents, "Resources", "runtime", "t4-host");
  if (!existsSync(executables) || !statSync(executables).isDirectory()) {
    throw new Error("Flutter application is missing its macOS executable directory");
  }
  if (!existsSync(host) || !statSync(host).isFile()) {
    throw new Error("Flutter application is missing its bundled t4-host");
  }
  return { bundleFiles: readdirSync(executables).length + 1 };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const artifacts = process.argv.slice(2).filter((value) => value !== "--");
  for (const artifact of artifacts) {
    if (!existsSync(artifact)) throw new Error(`package does not exist: ${artifact}`);
    let listing;
    if (artifact.endsWith(".tar.gz")) listing = run("tar", ["-tzf", artifact], { capture: true });
    else if (extname(artifact) === ".deb") listing = run("dpkg-deb", ["--contents", artifact], { capture: true });
    else if (extname(artifact) === ".zip") listing = run("unzip", ["-Z1", artifact], { capture: true });
    else throw new Error(`unsupported Flutter package: ${artifact}`);
    for (const required of ["t4code", "t4-host"]) {
      if (!listing.includes(required)) throw new Error(`${artifact} is missing ${required}`);
    }
    process.stdout.write(`${artifact}: Flutter bundle verified\n`);
  }
}
