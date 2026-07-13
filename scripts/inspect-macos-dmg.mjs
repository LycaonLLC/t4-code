import { mkdtempSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { inspectPackage, locateAppRoot } from "./inspect-package.mjs";

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function appendCleanupError(primary, cleanup, message) {
  const cleanupError = asError(cleanup);
  if (primary === null) return cleanupError;
  return new AggregateError([primary, cleanupError], message);
}

function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

function defaultIsFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultReadMountedEntries(path) {
  return readdirSync(path, { withFileTypes: true });
}

export function findMountedApp(mountPoint, readMountedEntries = defaultReadMountedEntries) {
  const apps = readMountedEntries(mountPoint)
    .filter((entry) => entry.isDirectory() && extname(entry.name).toLowerCase() === ".app")
    .map((entry) => join(mountPoint, entry.name));
  if (apps.length !== 1) {
    throw new Error(`expected exactly one macOS app in mounted DMG; found ${apps.length}`);
  }
  return apps[0];
}

export function inspectMacosDmg(dmgPath, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(`DMG inspection requires macOS (darwin); current platform is ${platform}`);
  }

  const absoluteDmg = resolve(dmgPath);
  const isFile = dependencies.isFile ?? defaultIsFile;
  if (extname(absoluteDmg).toLowerCase() !== ".dmg" || !isFile(absoluteDmg)) {
    throw new Error(`DMG does not exist or is not a file: ${absoluteDmg}`);
  }

  const createMountPoint =
    dependencies.createMountPoint ?? (() => mkdtempSync(join(tmpdir(), "t4-code-dmg-")));
  const removeMountPoint = dependencies.removeMountPoint ?? rmdirSync;
  const readMountedEntries = dependencies.readMountedEntries ?? defaultReadMountedEntries;
  const inspectArtifact = dependencies.inspectArtifact ?? inspectPackage;
  const resolveAppRoot = dependencies.resolveAppRoot ?? locateAppRoot;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const mountPoint = createMountPoint();

  let failure = null;
  let mounted = false;
  let detached = false;
  let inspection;
  try {
    runCommand("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountPoint,
      absoluteDmg,
    ]);
    mounted = true;
    const appPath = findMountedApp(mountPoint, readMountedEntries);
    inspection = inspectArtifact(resolveAppRoot(appPath));
  } catch (error) {
    failure = asError(error);
  } finally {
    if (mounted) {
      try {
        runCommand("hdiutil", ["detach", mountPoint]);
        detached = true;
      } catch (normalDetachError) {
        try {
          runCommand("hdiutil", ["detach", "-force", mountPoint]);
          detached = true;
        } catch (forceDetachError) {
          failure = appendCleanupError(
            failure,
            new AggregateError(
              [asError(normalDetachError), asError(forceDetachError)],
              `could not detach mounted DMG at ${mountPoint}`,
            ),
            "DMG inspection failed and cleanup could not detach the image",
          );
        }
      }
    }

    if (!mounted || detached) {
      try {
        removeMountPoint(mountPoint);
      } catch (error) {
        failure = appendCleanupError(
          failure,
          error,
          "DMG inspection failed and cleanup could not remove its mount point",
        );
      }
    }
  }

  if (failure !== null) throw failure;
  return inspection;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const paths = process.argv.slice(2).filter((argument) => argument !== "--");
  if (paths.length !== 1) {
    console.error("usage: pnpm inspect:dmg -- <artifact.dmg>");
    process.exitCode = 1;
  } else {
    try {
      const result = inspectMacosDmg(paths[0]);
      console.log(`${paths[0]}: mounted read-only and inspected ${result.asarEntries} ASAR entries`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
