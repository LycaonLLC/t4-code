import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { extractFile, listPackage } from "@electron/asar";
import config from "../electron-builder.config.mjs";

const forbiddenPath =
  /(^|[/\\])(?:reference|references|proof|proofs|\.env(?:$|[.])|auth)(?:[/\\]|$)/iu;

function fail(message) {
  throw new Error(`package inspection failed: ${message}`);
}

const PE_MACHINE_X64 = 0x8664;

function assertNamesSafe(names) {
  for (const name of names) {
    const normalized = name.replaceAll("\\", "/");
    if (forbiddenPath.test(normalized)) fail(`forbidden path ${normalized}`);
    if (normalized.endsWith(".map")) fail(`source map ${normalized}`);
  }
}

function statFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function statDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function assertAsar(asarPath) {
  let names;
  try {
    names = listPackage(asarPath, { isPack: false });
  } catch (error) {
    fail(`cannot read ${asarPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const normalizedNames = names.map((name) => name.replaceAll("\\", "/"));
  assertNamesSafe(normalizedNames);
  for (const required of ["dist-electron/main.cjs", "dist-electron/preload.cjs", "package.json"]) {
    if (!normalizedNames.includes(`/${required}`)) fail(`ASAR is missing ${required}`);
  }
  const manifest = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
  if (manifest.productName !== config.productName) fail(`productName is not ${config.productName}`);
  return { asarEntries: names.length, manifest };
}

export function locateAppRoot(root) {
  const suffix = join("resources", "app.asar").toLowerCase();
  const asars = findFiles(root).filter((path) => path.toLowerCase().endsWith(suffix));
  if (asars.length === 0) return root;
  return asars[0].slice(0, -suffix.length - 1);
}

function resolveChildDirectory(root, name) {
  const entry = readdirSync(root, { withFileTypes: true }).find(
    (candidate) => candidate.isDirectory() && candidate.name.toLowerCase() === name.toLowerCase(),
  );
  return join(root, entry?.name ?? name);
}

function assertResourceTree(root) {
  const resources = resolveChildDirectory(root, "resources");
  const webIndex = join(resolveChildDirectory(resources, "web"), "index.html");
  const license = join(resources, "LICENSE");
  if (!statFile(webIndex)) fail("resources/web/index.html is missing");
  if (!statFile(license)) fail("resources/LICENSE is missing");
  if (readFileSync(webIndex).length === 0 || readFileSync(license).length === 0)
    fail("web index or license is empty");
  const asarPath = join(resources, "app.asar");
  if (!statFile(asarPath)) fail("resources/app.asar is missing");
  return assertAsar(asarPath);
}

function run(command, args, cwd = undefined) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

function findFiles(root, suffix = null) {
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (suffix === null || entry.name.endsWith(suffix)) result.push(path);
    }
  };
  visit(root);
  return result;
}

export function inspectWindowsExecutable(path) {
  const handle = openSync(path, "r");
  try {
    const dosHeader = Buffer.allocUnsafe(64);
    if (readSync(handle, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      fail(`${path} has a truncated DOS header`);
    }
    if (dosHeader.readUInt16LE(0) !== 0x5a4d) fail(`${path} is not a Windows executable`);
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.allocUnsafe(6);
    if (
      peOffset < dosHeader.length ||
      readSync(handle, peHeader, 0, peHeader.length, peOffset) !== peHeader.length
    ) {
      fail(`${path} has a truncated PE header`);
    }
    if (peHeader.readUInt32LE(0) !== 0x0000_4550) fail(`${path} has an invalid PE signature`);
    if (peHeader.readUInt16LE(4) !== PE_MACHINE_X64) fail(`${path} is not an x64 executable`);
    return { architecture: "x64" };
  } finally {
    closeSync(handle);
  }
}

function assertWindowsExecutable(root) {
  const expectedName = `${config.executableName}.exe`.toLowerCase();
  const executables = findFiles(root, ".exe").filter(
    (path) => basename(path).toLowerCase() === expectedName,
  );
  if (executables.length !== 1) {
    fail(`expected exactly one ${config.executableName}.exe, found ${executables.length}`);
  }
  return inspectWindowsExecutable(executables[0]);
}

function assertLinuxMetadata(root) {
  const desktopFiles = findFiles(root, ".desktop");
  if (desktopFiles.length === 0) fail("Linux package has no desktop metadata");
  const metadata = desktopFiles.map((path) => readFileSync(path, "utf8")).join("\n");
  if (!metadata.includes("x-scheme-handler/t4-code"))
    fail("Linux desktop metadata lacks t4-code protocol");
  if (!metadata.includes(`Name=${config.productName}`))
    fail("Linux desktop metadata lacks product name");
}

function findAllRelativeFiles(root) {
  return findFiles(root).map((file) => relative(root, file).replaceAll("\\", "/"));
}

function inspectDirectory(path) {
  assertNamesSafe(findAllRelativeFiles(path));
  const result = assertResourceTree(path);
  const desktopFiles = findFiles(path, ".desktop");
  if (desktopFiles.length > 0) assertLinuxMetadata(path);
  return { kind: "directory", ...result, protocolMetadata: desktopFiles.length > 0 };
}

function inspectArchive(path) {
  const temporary = mkdtempSync(join(tmpdir(), "t4-code-package-"));
  try {
    const extension = extname(path).toLowerCase();
    if (extension === ".deb") run("dpkg-deb", ["-x", path, temporary]);
    else if (extension === ".appimage") run(path, ["--appimage-extract"], temporary);
    else if (extension === ".zip") run("unzip", ["-q", path, "-d", temporary]);
    else if (extension === ".msi") {
      run("msiexec.exe", ["/a", path, "/qn", "/norestart", `TARGETDIR=${temporary}`]);
    } else fail(`unsupported archive type ${extension}; inspect on its native platform`);
    const extractedRoot = extension === ".appimage" ? join(temporary, "squashfs-root") : temporary;
    assertNamesSafe(findAllRelativeFiles(extractedRoot));
    const appRoot = locateAppRoot(extractedRoot);
    const result = assertResourceTree(appRoot);
    const desktopFiles = findFiles(extractedRoot, ".desktop");
    if (desktopFiles.length > 0) assertLinuxMetadata(extractedRoot);
    return {
      kind: extension.slice(1),
      ...result,
      protocolMetadata: desktopFiles.length > 0,
      ...(extension === ".msi" ? assertWindowsExecutable(appRoot) : {}),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function inspectPackage(path) {
  const absolute = resolve(path);
  if (!statFile(absolute) && !statDirectory(absolute)) fail(`package does not exist: ${absolute}`);
  return statDirectory(absolute) ? inspectDirectory(absolute) : inspectArchive(absolute);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const paths = process.argv.slice(2).filter((argument) => argument !== "--");
  if (paths.length === 0) {
    console.error("usage: pnpm inspect:package -- <unpacked-dir-or-artifact> [...]");
    process.exitCode = 1;
  } else {
    try {
      for (const path of paths) {
        const result = inspectPackage(path);
        console.log(
          `${path}: inspected ${result.kind}, ${result.asarEntries} ASAR entries, protocol metadata=${result.protocolMetadata}${result.architecture === undefined ? "" : `, architecture=${result.architecture}`}`,
        );
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
