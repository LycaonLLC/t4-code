import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const electronPackagePath = desktopRequire.resolve("electron/package.json");
const electronDirectory = dirname(electronPackagePath);
const electronRequire = createRequire(electronPackagePath);
const { version } = JSON.parse(readFileSync(electronPackagePath, "utf8"));
const platformExecutable =
  process.platform === "darwin"
    ? "Electron.app/Contents/MacOS/Electron"
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
const distributionDirectory = join(electronDirectory, "dist");
const executablePath = join(distributionDirectory, platformExecutable);
const pathFile = join(electronDirectory, "path.txt");

if (!existsSync(executablePath) || !existsSync(pathFile)) {
  const { downloadArtifact } = electronRequire("@electron/get");
  const checksums = electronRequire("./checksums.json");
  const archive = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: process.platform,
    arch: process.arch,
    checksums,
  });
  mkdirSync(distributionDirectory, { recursive: true });
  execFileSync("unzip", ["-q", "-o", archive, "-d", distributionDirectory]);
  const bundledTypes = join(distributionDirectory, "electron.d.ts");
  if (existsSync(bundledTypes)) renameSync(bundledTypes, join(electronDirectory, "electron.d.ts"));
  writeFileSync(pathFile, platformExecutable);
}

if (!existsSync(executablePath)) throw new Error("Electron binary repair did not produce an executable");
process.stdout.write(`Electron ${version} ready for ${process.platform}/${process.arch}\n`);
