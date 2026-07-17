const runtimeExternalDependencies = [
  "node_modules/electron-store/**/*",
  "node_modules/electron-updater/**/*",
  "node_modules/ws/**/*",
];

export const linuxUpdatePublish = {
  provider: "github",
  owner: "LycaonLLC",
  repo: "t4-code",
  channel: "latest",
};

/** @type {import("electron-builder").Configuration} */
const config = {
  appId: "com.lycaonsolutions.t4code",
  productName: "T4 Code",
  executableName: "t4-code",
  electronVersion: "41.5.0",
  artifactName: "T4-Code-${version}-${os}-${arch}.${ext}",
  directories: {
    app: "apps/desktop",
    output: "release",
  },
  asar: true,
  files: ["dist-electron/**/*", "package.json", ...runtimeExternalDependencies, "!**/*.map"],
  extraResources: [
    { from: "apps/web/dist", to: "web" },
    { from: "LICENSE", to: "LICENSE" },
  ],
  protocols: [{ name: "T4 Code", schemes: ["t4-code"] }],
  linux: {
    category: "Development",
    icon: "apps/desktop/build/icons",
    publish: [linuxUpdatePublish],
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
  },
  win: {
    icon: "apps/desktop/build/icon.png",
    // MSI does not support electron-updater. Publish it through the verified
    // release manifest and keep updates on the explicit-download path.
    publish: [],
    target: [{ target: "msi", arch: ["x64"] }],
  },
  msi: {
    oneClick: false,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: false,
    upgradeCode: "{9638C287-93D5-4483-AEBE-57DBEA156676}",
  },
  mac: {
    category: "public.app-category.developer-tools",
    icon: "apps/desktop/build/icon.png",
    // The public macOS build is intentionally unsigned and unnotarized. Keep
    // it on the explicit-download path until there is an honest signed update
    // channel; do not emit latest-mac.yml for electron-updater.
    publish: [],
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
  },
};

export { runtimeExternalDependencies };
export default config;
