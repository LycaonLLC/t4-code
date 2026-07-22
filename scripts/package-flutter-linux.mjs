import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFlutter,
  copyTree,
  flutterRoot,
  releaseRoot,
  repoRoot,
  resetDirectory,
  resetReleaseDirectory,
  run,
  stageHost,
  version,
} from "./flutter-packaging.mjs";

if (process.platform !== "linux") throw new Error(`package:linux requires Linux; current platform is ${process.platform}`);

buildFlutter("linux");
resetReleaseDirectory();

const architecture = process.arch === "x64" ? "x86_64" : process.arch;
const sourceBundle = join(flutterRoot, "build", "linux", "x64", "release", "bundle");
stageHost(join(sourceBundle, "lib"));

const archive = join(releaseRoot, `T4-Code-${version}-linux-${architecture}.tar.gz`);
run("tar", ["-C", sourceBundle, "-czf", archive, "."]);

const staging = join(repoRoot, ".artifacts", "flutter-linux-package");
resetDirectory(staging);
const installRoot = join(staging, "opt", "t4-code");
mkdirSync(installRoot, { recursive: true });
copyTree(sourceBundle, installRoot);
mkdirSync(join(staging, "usr", "bin"), { recursive: true });
symlinkSync("/opt/t4-code/t4code", join(staging, "usr", "bin", "t4-code"));
mkdirSync(join(staging, "usr", "share", "applications"), { recursive: true });
writeFileSync(
  join(staging, "usr", "share", "applications", "t4-code.desktop"),
  "[Desktop Entry]\nType=Application\nName=T4 Code\nExec=/usr/bin/t4-code\nTerminal=false\nCategories=Development;\n",
);
const control = join(staging, "DEBIAN");
mkdirSync(control, { recursive: true });
writeFileSync(
  join(control, "control"),
  `Package: t4-code\nVersion: ${version}\nArchitecture: amd64\nMaintainer: Lycaon LLC\nDescription: Flutter desktop client for Oh My Pi\nDepends: libgtk-3-0, libglib2.0-0\n`,
);
chmodSync(control, 0o755);
run("dpkg-deb", ["--root-owner-group", "--build", staging, join(releaseRoot, `T4-Code-${version}-linux-amd64.deb`)]);

const deb = join(releaseRoot, `T4-Code-${version}-linux-amd64.deb`);
const artifacts = [deb, archive].map((path) => ({
  name: path.split("/").at(-1),
  size: statSync(path).size,
  sha512: createHash("sha512").update(readFileSync(path)).digest("base64"),
}));
writeFileSync(
  join(releaseRoot, "latest-linux.yml"),
  [
    `version: ${version}`,
    "files:",
    ...artifacts.flatMap((artifact) => [
      `  - url: ${artifact.name}`,
      `    sha512: ${artifact.sha512}`,
      `    size: ${artifact.size}`,
    ]),
    `path: ${artifacts[0].name}`,
    `sha512: ${artifacts[0].sha512}`,
    `releaseDate: ${new Date().toISOString()}`,
    "",
  ].join("\n"),
);
