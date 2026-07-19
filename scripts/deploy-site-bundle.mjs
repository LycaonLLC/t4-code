import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deployDemo } from "./deploy-demo.mjs";
import { deploySite, resolveDeployConfig } from "./deploy-site.mjs";

export function deploySiteBundle(
  config,
  immutableSiteRoot,
  demoRoot = resolve(import.meta.dirname, ".."),
  deploySiteCommand = deploySite,
  deployDemoCommand = deployDemo,
) {
  if (!isAbsolute(immutableSiteRoot)) {
    throw new Error("T4_IMMUTABLE_SITE_SOURCE must be an absolute path");
  }
  deploySiteCommand(config, immutableSiteRoot);
  deployDemoCommand(config, demoRoot);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const immutableSiteRoot = process.env.T4_IMMUTABLE_SITE_SOURCE?.trim() ?? "";
    deploySiteBundle(resolveDeployConfig(), immutableSiteRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
