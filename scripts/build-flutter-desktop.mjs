import { buildFlutter } from "./flutter-packaging.mjs";

if (process.platform === "darwin") buildFlutter("macos");
else if (process.platform === "linux") buildFlutter("linux");
else if (process.platform === "win32") buildFlutter("windows");
else throw new Error(`Flutter desktop builds are unsupported on ${process.platform}`);
