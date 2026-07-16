import { app, net, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { DesktopUpdateController, type NativeUpdaterPort } from "./update-controller.ts";
import { detectNativeLinuxPackage } from "./linux-update-package.ts";

export function createElectronUpdateController(): DesktopUpdateController {
  const nativeLinuxPackage = detectNativeLinuxPackage({
    platform: process.platform,
    isPackaged: app.isPackaged,
    ...(process.env.APPIMAGE === undefined ? {} : { appImagePath: process.env.APPIMAGE }),
    resourcesPath: process.resourcesPath,
  });
  return new DesktopUpdateController({
    currentVersion: app.getVersion(),
    platform: process.platform === "darwin" ? "darwin" : "linux",
    isPackaged: app.isPackaged,
    ...(nativeLinuxPackage === undefined ? {} : { nativeLinuxPackage }),
    nativeUpdater: autoUpdater as NativeUpdaterPort,
    fetchManifest: async (url, options) => {
      const response = await net.fetch(url, { signal: options.signal });
      const body = response.body;
      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        body: body === null ? null : { getReader: () => body.getReader() },
      };
    },
    openExternal: (url) => shell.openExternal(url),
  });
}
