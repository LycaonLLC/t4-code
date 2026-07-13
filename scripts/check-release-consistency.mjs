import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_CONTRACT_PATHS = [
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/workflows/deploy-site.yml",
  ".github/workflows/release.yml",
  "README.md",
  "SECURITY.md",
  "apps/desktop/src/target-manager.ts",
  "apps/site/src/docs/content.ts",
  "apps/site/src/release.ts",
  "apps/web/src/platform/browser-shell-port.ts",
  "compat/omp-app-matrix.json",
  "packages/client/src/omp-client-frames.ts",
];

const REPOSITORY_URL = "https://github.com/LycaonLLC/t4-code";
const OMP_RUNTIME_VERSION = "16.4.8";
const OMP_RUNTIME_FIX_COMMIT = "f65bb37970d2186f04ec4b650eb0b53ec3b1337b";
const OMP_RUNTIME_REPOSITORY = "https://github.com/lyc-aon/oh-my-pi";
const OMP_RUNTIME_FIX_URL = `${OMP_RUNTIME_REPOSITORY}/commit/${OMP_RUNTIME_FIX_COMMIT}`;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

export function expectedReleaseAssetNames(version) {
  return [
    `T4-Code-${version}-linux-amd64.deb`,
    `T4-Code-${version}-linux-x86_64.AppImage`,
    `T4-Code-${version}-mac-arm64.dmg`,
    `T4-Code-${version}-mac-arm64.zip`,
  ];
}

export function discoverReleasePackagePaths(repoRoot) {
  const paths = ["package.json"];
  for (const parent of ["apps", "packages"]) {
    const entries = readdirSync(resolve(repoRoot, parent), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) paths.push(`${parent}/${entry.name}/package.json`);
    }
  }
  return paths.sort((a, b) => a.localeCompare(b));
}

export function loadReleaseContractFiles(repoRoot) {
  const paths = [...new Set([...discoverReleasePackagePaths(repoRoot), ...RELEASE_CONTRACT_PATHS])];
  return new Map(
    paths.map((relativePath) => [
      relativePath,
      readFileSync(resolve(repoRoot, relativePath), "utf8"),
    ]),
  );
}

function parseJson(files, path, errors) {
  try {
    return JSON.parse(files.get(path) ?? "");
  } catch (error) {
    errors.push(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function requireText(text, expected, path, errors) {
  if (!text.includes(expected)) errors.push(`${path} is missing ${JSON.stringify(expected)}`);
}

export function collectReleaseConsistencyErrors(files, releaseTag) {
  const errors = [];
  const rootManifest = parseJson(files, "package.json", errors);
  const version = rootManifest?.version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    errors.push("package.json version must be a stable x.y.z release version");
    return errors;
  }
  const expectedTag = `v${version}`;

  const packagePaths = [...files.keys()]
    .filter((path) => path === "package.json" || /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path))
    .sort((a, b) => a.localeCompare(b));
  for (const path of packagePaths) {
    const manifest = parseJson(files, path, errors);
    if (manifest && manifest.version !== version) {
      errors.push(`${path} version ${JSON.stringify(manifest.version)} does not match ${version}`);
    }
  }

  if (releaseTag !== undefined && releaseTag !== expectedTag) {
    errors.push(`release tag ${releaseTag} does not match ${expectedTag}`);
  }

  const matrix = parseJson(files, "compat/omp-app-matrix.json", errors);
  if (matrix?.desktop?.version !== version) {
    errors.push(`compat/omp-app-matrix.json desktop version must be ${version}`);
  }
  if (matrix?.appWire?.version !== "0.5.1") {
    errors.push("compat/omp-app-matrix.json app-wire version must remain 0.5.1 for this release");
  }
  const verifiedRuntime = matrix?.verifiedRuntime;
  if (verifiedRuntime?.package !== "omp") {
    errors.push("compat/omp-app-matrix.json verified runtime package must be omp");
  }
  if (verifiedRuntime?.version !== OMP_RUNTIME_VERSION) {
    errors.push(`compat/omp-app-matrix.json verified runtime version must be ${OMP_RUNTIME_VERSION}`);
  }
  if (verifiedRuntime?.sourceRepository !== OMP_RUNTIME_REPOSITORY) {
    errors.push(`compat/omp-app-matrix.json verified runtime repository must be ${OMP_RUNTIME_REPOSITORY}`);
  }
  if (verifiedRuntime?.sourceCommit !== OMP_RUNTIME_FIX_COMMIT) {
    errors.push(`compat/omp-app-matrix.json verified runtime commit must be ${OMP_RUNTIME_FIX_COMMIT}`);
  }
  if (verifiedRuntime?.sourceUrl !== OMP_RUNTIME_FIX_URL) {
    errors.push(`compat/omp-app-matrix.json verified runtime URL must be ${OMP_RUNTIME_FIX_URL}`);
  }
  if (verifiedRuntime?.largeSessionFix !== "bounded-growing-session-replay") {
    errors.push("compat/omp-app-matrix.json must identify the bounded growing-session replay fix");
  }
  if (verifiedRuntime?.upstreamTagContainsLargeSessionFix !== false) {
    errors.push("compat/omp-app-matrix.json must record that stock upstream v16.4.8 lacks the large-session fix");
  }

  const site = files.get("apps/site/src/release.ts") ?? "";
  requireText(site, `export const RELEASE_TAG = "${expectedTag}";`, "apps/site/src/release.ts", errors);
  requireText(site, `export const RELEASE_VERSION = "${version}";`, "apps/site/src/release.ts", errors);
  requireText(site, `export const OMP_RUNTIME_VERSION = "${OMP_RUNTIME_VERSION}";`, "apps/site/src/release.ts", errors);
  requireText(site, `export const OMP_RUNTIME_FIX_COMMIT = "${OMP_RUNTIME_FIX_COMMIT}";`, "apps/site/src/release.ts", errors);
  for (const filename of expectedReleaseAssetNames(version)) {
    requireText(site, `"${filename}"`, "apps/site/src/release.ts", errors);
  }
  const siteAssetVersions = new Set(
    [...site.matchAll(/T4-Code-(\d+\.\d+\.\d+)-(?:linux|mac)-/gu)].map((match) => match[1]),
  );
  for (const assetVersion of siteAssetVersions) {
    if (assetVersion !== version) {
      errors.push(`apps/site/src/release.ts contains an asset for ${assetVersion}; expected ${version}`);
    }
  }

  const readme = files.get("README.md") ?? "";
  requireText(readme, `[**Download ${expectedTag}**](${REPOSITORY_URL}/releases/tag/${expectedTag})`, "README.md", errors);
  requireText(
    readme,
    `T4 Code ${expectedTag} was verified with OMP ${OMP_RUNTIME_VERSION} built from [\`f65bb379\`](${OMP_RUNTIME_FIX_URL}).`,
    "README.md",
    errors,
  );
  requireText(readme, "The stock upstream v16.4.8 tag does not contain this appserver fix", "README.md", errors);
  requireText(readme, "T4 Code's vendored protocol package remains `@oh-my-pi/app-wire` 0.5.1.", "README.md", errors);
  requireText(readme, `## What changed in ${expectedTag}`, "README.md", errors);
  for (const filename of expectedReleaseAssetNames(version)) {
    requireText(readme, `${REPOSITORY_URL}/releases/download/${expectedTag}/${filename}`, "README.md", errors);
  }
  const linkedReleaseTags = new Set(
    [...readme.matchAll(/https:\/\/github\.com\/LycaonLLC\/t4-code\/releases\/(?:tag|download)\/(v\d+\.\d+\.\d+)/gu)]
      .map((match) => match[1]),
  );
  for (const linkedTag of linkedReleaseTags) {
    if (linkedTag !== expectedTag) {
      errors.push(`README.md contains a release URL for ${linkedTag}; expected ${expectedTag}`);
    }
  }

  requireText(
    files.get("SECURITY.md") ?? "",
    `The macOS ${expectedTag} build is unsigned and unnotarized`,
    "SECURITY.md",
    errors,
  );
  requireText(
    files.get(".github/ISSUE_TEMPLATE/bug_report.yml") ?? "",
    `placeholder: "${version}"`,
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    errors,
  );

  const runtimeVersions = [
    ["apps/desktop/src/target-manager.ts", `version: "${version}", build: "desktop"`],
    ["apps/web/src/platform/browser-shell-port.ts", `version: "${version}"`],
    ["packages/client/src/omp-client-frames.ts", `version: "${version}", build: "client"`],
  ];
  for (const [path, expected] of runtimeVersions) {
    requireText(files.get(path) ?? "", expected, path, errors);
  }

  const siteDocs = files.get("apps/site/src/docs/content.ts") ?? "";
  requireText(siteDocs, "OMP_RUNTIME_FIX_URL", "apps/site/src/docs/content.ts", errors);
  requireText(
    siteDocs,
    "The stock upstream OMP v${OMP_RUNTIME_VERSION} tag does not contain this appserver fix.",
    "apps/site/src/docs/content.ts",
    errors,
  );
  requireText(siteDocs, 'id: "troubleshooting-large-session"', "apps/site/src/docs/content.ts", errors);

  requireText(
    files.get(".github/workflows/release.yml") ?? "",
    'node scripts/check-release-consistency.mjs --tag "$RELEASE_TAG"',
    ".github/workflows/release.yml",
    errors,
  );
  requireText(files.get(".github/workflows/release.yml") ?? "", OMP_RUNTIME_FIX_URL, ".github/workflows/release.yml", errors);
  requireText(
    files.get(".github/workflows/release.yml") ?? "",
    "Stock upstream OMP v16.4.8 does not include that bounded large-session snapshot and replay fix.",
    ".github/workflows/release.yml",
    errors,
  );
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    "node scripts/wait-for-release-assets.mjs --timeout-ms 2400000 --interval-ms 15000",
    ".github/workflows/deploy-site.yml",
    errors,
  );
  return errors;
}

export function checkReleaseConsistency(repoRoot, releaseTag) {
  return collectReleaseConsistencyErrors(loadReleaseContractFiles(repoRoot), releaseTag);
}

function parseTagArgument(args) {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--tag" && args[1]) return args[1];
  throw new Error("usage: node scripts/check-release-consistency.mjs [--tag vX.Y.Z]");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const errors = checkReleaseConsistency(process.cwd(), parseTagArgument(process.argv.slice(2)));
    if (errors.length > 0) {
      console.error(`Release consistency check failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:`);
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
    } else {
      const version = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")).version;
      console.log(`Release consistency check passed for v${version}.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
