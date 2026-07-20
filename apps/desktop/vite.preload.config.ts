import { builtinModules } from "node:module";
import { defineConfig } from "vite-plus";

const external = new Set([
  "electron",
  "electron-store",
  "electron-updater",
  "ws",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export default defineConfig({
  build: {
    outDir: "dist-electron",
    emptyOutDir: false,
    lib: {
      entry: {
        preload: "src/preload.ts",
        "browser-content-preload": "src/browser-content-preload.ts",
      },
      formats: ["cjs"],
    },
    rollupOptions: {
      external: (id) => external.has(id) || id.startsWith("node:"),
      output: { entryFileNames: "[name].cjs", chunkFileNames: "preload-[name]-[hash].cjs", codeSplitting: true },
    },
  },
});
