import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

function isAppImageRuntime(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && !value.includes("\0") && isAbsolute(value);
}

/** Mirror electron-updater's package selection without enabling unsupported runtimes. */
export function detectNativeLinuxPackage(options: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly appImagePath?: string;
  readonly resourcesPath: string;
}): "appimage" | "deb" | undefined {
  if (!options.isPackaged || options.platform !== "linux") return undefined;
  try {
    const packageTypePath = join(options.resourcesPath, "package-type");
    if (statSync(packageTypePath).size > 32) return undefined;
    const packageType = readFileSync(packageTypePath, "utf8").trim();
    if (packageType === "deb") return "deb";
    if (["rpm", "pacman"].includes(packageType)) return undefined;
  } catch {
    // AppImage distributions do not require a package-type marker.
  }
  return isAppImageRuntime(options.appImagePath) ? "appimage" : undefined;
}
