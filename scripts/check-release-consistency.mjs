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
  "docs/CURRENT_RELEASE_NOTES.md",
  "packages/client/src/omp-client-frames.ts",
  "vendor/app-wire/manifest.json",
];

const REPOSITORY_URL = "https://github.com/LycaonLLC/t4-code";
const OMP_RUNTIME_REPOSITORY = "https://github.com/lyc-aon/oh-my-pi";
const OMP_UPSTREAM_REPOSITORY = "https://github.com/can1357/oh-my-pi";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PATCH_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function expectedReleaseAssetNames(version) {
  return [
    `T4-Code-${version}-android.apk`,
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
    errors.push(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    .filter(
      (path) => path === "package.json" || /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(path),
    )
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

  const matrixPath = "compat/omp-app-matrix.json";
  const matrix = parseJson(files, matrixPath, errors);
  if (matrix?.desktop?.version !== version) {
    errors.push(`${matrixPath} desktop version must be ${version}`);
  }

  // The compatibility matrix is the release's provenance authority. These
  // checks validate its shape and internal relationships; the cross-surface
  // checks below ensure the site, README, and release notes match it.
  const appWire = matrix?.appWire;
  const appWireVersion = appWire?.version;
  const appWireSourceCommit = typeof appWire?.sourceCommit === "string" ? appWire.sourceCommit : "";
  const appWireSourceTree =
    typeof appWire?.sourceTreeHash === "string" ? appWire.sourceTreeHash : "";
  if (appWire?.package !== "@oh-my-pi/app-wire") {
    errors.push(`${matrixPath} app-wire package must be @oh-my-pi/app-wire`);
  }
  if (typeof appWireVersion !== "string" || !VERSION_PATTERN.test(appWireVersion)) {
    errors.push(`${matrixPath} app-wire version must be a stable x.y.z version`);
  }
  if (appWire?.sourceRepository !== OMP_RUNTIME_REPOSITORY) {
    errors.push(`${matrixPath} app-wire repository must be ${OMP_RUNTIME_REPOSITORY}`);
  }
  if (!SHA_PATTERN.test(appWireSourceCommit)) {
    errors.push(`${matrixPath} app-wire commit must be a lowercase 40-character Git SHA`);
  }
  if (!SHA_PATTERN.test(appWireSourceTree)) {
    errors.push(`${matrixPath} app-wire source tree must be a lowercase 40-character Git SHA`);
  }
  if (
    typeof appWireVersion === "string" &&
    appWire?.tarball !== `vendor/app-wire/oh-my-pi-app-wire-${appWireVersion}.tgz`
  ) {
    errors.push(`${matrixPath} app-wire tarball path must match its version`);
  }
  if (typeof appWire?.tarballSha256 !== "string" || !SHA256_PATTERN.test(appWire.tarballSha256)) {
    errors.push(`${matrixPath} app-wire tarball SHA-256 must be 64 lowercase hex characters`);
  }
  if (
    typeof appWire?.goldenCorpusSha256 !== "string" ||
    !SHA256_PATTERN.test(appWire.goldenCorpusSha256)
  ) {
    errors.push(`${matrixPath} golden corpus SHA-256 must be 64 lowercase hex characters`);
  }

  const appWireManifestPath = "vendor/app-wire/manifest.json";
  const appWireManifest = parseJson(files, appWireManifestPath, errors);
  const expectedManifest = {
    package: appWire?.package,
    version: appWireVersion,
    sourceRepository: appWire?.sourceRepository,
    sourceCommit: appWireSourceCommit,
    sourceTreeHash: appWireSourceTree,
    tarball:
      typeof appWire?.tarball === "string"
        ? appWire.tarball.replace(/^vendor\/app-wire\//u, "")
        : undefined,
    tarballSha256: appWire?.tarballSha256,
    appProtocol: matrix?.appProtocol,
    goldenCorpusSha256: appWire?.goldenCorpusSha256,
  };
  for (const [field, expected] of Object.entries(expectedManifest)) {
    if (appWireManifest?.[field] !== expected) {
      errors.push(`${appWireManifestPath} ${field} must match ${matrixPath}`);
    }
  }
  const manifestCreatedAt = appWireManifest?.createdAt;
  if (
    typeof manifestCreatedAt !== "string" ||
    !Number.isFinite(Date.parse(manifestCreatedAt)) ||
    new Date(manifestCreatedAt).toISOString().replace(".000Z", "Z") !== manifestCreatedAt
  ) {
    errors.push(`${appWireManifestPath} createdAt must be a canonical ISO timestamp`);
  }

  const verifiedRuntime = matrix?.verifiedRuntime;
  const ompRuntimeVersion = verifiedRuntime?.version;
  const ompRuntimeCommit = verifiedRuntime?.sourceCommit;
  const ompRuntimeSourceTag = verifiedRuntime?.sourceTag;
  const ompUpstreamTag = verifiedRuntime?.upstreamTag;
  const ompUpstreamCommit = verifiedRuntime?.upstreamCommit;
  const ompRuntimeCommitUrl = `${OMP_RUNTIME_REPOSITORY}/commit/${ompRuntimeCommit ?? ""}`;
  const ompRuntimeSourceUrl = `${OMP_RUNTIME_REPOSITORY}/tree/${ompRuntimeSourceTag ?? ""}`;
  const ompUpstreamTagUrl = `${OMP_UPSTREAM_REPOSITORY}/tree/${ompUpstreamTag ?? ""}`;
  const ompUpstreamCommitUrl = `${OMP_UPSTREAM_REPOSITORY}/commit/${ompUpstreamCommit ?? ""}`;

  if (verifiedRuntime?.package !== "omp") {
    errors.push(`${matrixPath} verified runtime package must be omp`);
  }
  if (typeof ompRuntimeVersion !== "string" || !VERSION_PATTERN.test(ompRuntimeVersion)) {
    errors.push(`${matrixPath} verified runtime version must be a stable x.y.z version`);
  }
  if (verifiedRuntime?.sourceRepository !== OMP_RUNTIME_REPOSITORY) {
    errors.push(`${matrixPath} verified runtime repository must be ${OMP_RUNTIME_REPOSITORY}`);
  }
  if (typeof ompRuntimeCommit !== "string" || !SHA_PATTERN.test(ompRuntimeCommit)) {
    errors.push(`${matrixPath} verified runtime commit must be a lowercase 40-character Git SHA`);
  }
  if (verifiedRuntime?.sourceUrl !== ompRuntimeCommitUrl) {
    errors.push(`${matrixPath} verified runtime URL must be ${ompRuntimeCommitUrl}`);
  }
  if (
    typeof ompRuntimeVersion === "string" &&
    (typeof ompRuntimeSourceTag !== "string" ||
      !new RegExp(
        `^t4code-${ompRuntimeVersion.replaceAll(".", "\\.")}-appserver-[1-9]\\d*$`,
        "u",
      ).test(ompRuntimeSourceTag))
  ) {
    errors.push(
      `${matrixPath} verified runtime tag must identify the OMP version and appserver revision`,
    );
  }
  if (verifiedRuntime?.upstreamRepository !== OMP_UPSTREAM_REPOSITORY) {
    errors.push(`${matrixPath} upstream repository must be ${OMP_UPSTREAM_REPOSITORY}`);
  }
  if (typeof ompRuntimeVersion === "string" && ompUpstreamTag !== `v${ompRuntimeVersion}`) {
    errors.push(`${matrixPath} upstream tag must be v${ompRuntimeVersion}`);
  }
  if (typeof ompUpstreamCommit !== "string" || !SHA_PATTERN.test(ompUpstreamCommit)) {
    errors.push(`${matrixPath} upstream commit must be a lowercase 40-character Git SHA`);
  }
  const integrationPatches = verifiedRuntime?.integrationPatches;
  if (
    !Array.isArray(integrationPatches) ||
    integrationPatches.length === 0 ||
    integrationPatches.some(
      (patch) => typeof patch !== "string" || !PATCH_NAME_PATTERN.test(patch),
    ) ||
    new Set(integrationPatches).size !== integrationPatches.length
  ) {
    errors.push(
      `${matrixPath} verified runtime integration patches must be unique kebab-case names`,
    );
  }
  if (verifiedRuntime?.upstreamTagContainsIntegrationPatches !== false) {
    errors.push(`${matrixPath} must record that stock upstream lacks the integration patches`);
  }

  const site = files.get("apps/site/src/release.ts") ?? "";
  requireText(
    site,
    `export const RELEASE_TAG = "${expectedTag}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const RELEASE_VERSION = "${version}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_VERSION = "${ompRuntimeVersion}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_COMMIT = "${ompRuntimeCommit}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_RUNTIME_TAG = "${ompRuntimeSourceTag}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_UPSTREAM_TAG = "${ompUpstreamTag}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const OMP_UPSTREAM_COMMIT = "${ompUpstreamCommit}";`,
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    "export const OMP_UPSTREAM_URL = `${OMP_URL}/tree/${OMP_UPSTREAM_TAG}`;",
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    "export const OMP_RUNTIME_URL = `https://github.com/lyc-aon/oh-my-pi/tree/${OMP_RUNTIME_TAG}`;",
    "apps/site/src/release.ts",
    errors,
  );
  requireText(
    site,
    `export const APP_WIRE_VERSION = "${appWireVersion}";`,
    "apps/site/src/release.ts",
    errors,
  );
  for (const filename of expectedReleaseAssetNames(version)) {
    requireText(site, `"${filename}"`, "apps/site/src/release.ts", errors);
  }
  const siteAssetVersions = new Set(
    [...site.matchAll(/T4-Code-(\d+\.\d+\.\d+)-(?:android|linux|mac)(?:\.|-)/gu)].map(
      (match) => match[1],
    ),
  );
  for (const assetVersion of siteAssetVersions) {
    if (assetVersion !== version) {
      errors.push(
        `apps/site/src/release.ts contains an asset for ${assetVersion}; expected ${version}`,
      );
    }
  }

  const readme = files.get("README.md") ?? "";
  requireText(
    readme,
    `[**Download ${expectedTag}**](${REPOSITORY_URL}/releases/tag/${expectedTag})`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `T4 Code ${expectedTag} was verified with OMP ${ompRuntimeVersion} built from [\`${String(ompRuntimeCommit).slice(0, 8)}\`](${ompRuntimeCommitUrl}), tagged [\`${ompRuntimeSourceTag}\`](${ompRuntimeSourceUrl}).`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `official upstream [\`${ompUpstreamTag}\`](${ompUpstreamTagUrl}) tag at [\`${String(ompUpstreamCommit).slice(0, 8)}\`](${ompUpstreamCommitUrl})`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `The official upstream ${ompUpstreamTag} tag has no \`appserver\` command, so it cannot host T4 Code.`,
    "README.md",
    errors,
  );
  requireText(
    readme,
    `T4 Code vendors \`@oh-my-pi/app-wire\` ${appWireVersion} from integration commit [\`${appWireSourceCommit.slice(0, 8)}\`](${OMP_RUNTIME_REPOSITORY}/commit/${appWireSourceCommit}), source tree \`${appWireSourceTree}\`.`,
    "README.md",
    errors,
  );
  requireText(readme, `## What changed in ${expectedTag}`, "README.md", errors);
  for (const filename of expectedReleaseAssetNames(version)) {
    requireText(
      readme,
      `${REPOSITORY_URL}/releases/download/${expectedTag}/${filename}`,
      "README.md",
      errors,
    );
  }
  const linkedReleaseTags = new Set(
    [
      ...readme.matchAll(
        /https:\/\/github\.com\/LycaonLLC\/t4-code\/releases\/(?:tag|download)\/(v\d+\.\d+\.\d+)/gu,
      ),
    ].map((match) => match[1]),
  );
  for (const linkedTag of linkedReleaseTags) {
    if (linkedTag !== expectedTag) {
      errors.push(`README.md contains a release URL for ${linkedTag}; expected ${expectedTag}`);
    }
  }

  const releaseNotes = files.get("docs/CURRENT_RELEASE_NOTES.md") ?? "";
  for (const expected of [
    `app-wire ${appWireVersion}`,
    `[${appWireSourceCommit.slice(0, 8)}](${OMP_RUNTIME_REPOSITORY}/commit/${appWireSourceCommit})`,
    `OMP ${ompRuntimeVersion}`,
    `[${String(ompRuntimeCommit).slice(0, 8)}](${ompRuntimeCommitUrl})`,
    `[${ompRuntimeSourceTag}](${ompRuntimeSourceUrl})`,
    `[${ompUpstreamTag} tag](${ompUpstreamTagUrl})`,
    `[${String(ompUpstreamCommit).slice(0, 8)}](${ompUpstreamCommitUrl})`,
  ]) {
    requireText(releaseNotes, expected, "docs/CURRENT_RELEASE_NOTES.md", errors);
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

  const runtimeIdentifiers = [
    ["apps/desktop/src/target-manager.ts", [`version: "${version}"`, 'build: "desktop"']],
    ["apps/web/src/platform/browser-shell-port.ts", [`version: "${version}"`]],
    ["packages/client/src/omp-client-frames.ts", [`version: "${version}"`, 'build: "client"']],
  ];
  for (const [path, expectedValues] of runtimeIdentifiers) {
    for (const expected of expectedValues) {
      requireText(files.get(path) ?? "", expected, path, errors);
    }
  }

  const siteDocs = files.get("apps/site/src/docs/content.ts") ?? "";
  requireText(siteDocs, "OMP_RUNTIME_URL", "apps/site/src/docs/content.ts", errors);
  requireText(siteDocs, "OMP_UPSTREAM_URL", "apps/site/src/docs/content.ts", errors);
  requireText(siteDocs, "OMP_UPSTREAM_COMMIT", "apps/site/src/docs/content.ts", errors);
  requireText(
    siteDocs,
    "Official upstream OMP v${OMP_RUNTIME_VERSION} does not ship the \\`appserver\\` command, so it cannot host T4 Code.",
    "apps/site/src/docs/content.ts",
    errors,
  );
  requireText(
    siteDocs,
    'id: "troubleshooting-large-session"',
    "apps/site/src/docs/content.ts",
    errors,
  );

  const releaseWorkflow = files.get(".github/workflows/release.yml") ?? "";
  requireText(
    releaseWorkflow,
    'node scripts/check-release-consistency.mjs --tag "$RELEASE_TAG"',
    ".github/workflows/release.yml",
    errors,
  );
  requireText(
    releaseWorkflow,
    "body_path: docs/CURRENT_RELEASE_NOTES.md",
    ".github/workflows/release.yml",
    errors,
  );
  for (const expected of [
    "github.ref == 'refs/heads/main'",
    "Check out trusted release-control source",
    "Resolve immutable release source",
    'git merge-base --is-ancestor "$source_sha" refs/remotes/origin/main',
    "ref: ${{ steps.source.outputs.source_sha }}",
    "ref: ${{ needs.verify.outputs.source_sha }}",
    "Confirm the release tag still resolves to the verified source",
    'test "$(git rev-parse "${RELEASE_TAG}^{commit}")" = "$SOURCE_SHA"',
    "build-android:",
    "T4_ANDROID_KEYSTORE_BASE64",
    "T4_ANDROID_KEYSTORE_PASSWORD",
    "T4_ANDROID_KEY_ALIAS",
    "T4_ANDROID_KEY_PASSWORD",
    "pnpm --filter @t4-code/mobile build:android:release",
    "apksigner verify --verbose",
    "T4-Code-${VERSION}-android.apk",
    "needs: [verify, build-android, build-linux, build-macos]",
  ]) {
    requireText(releaseWorkflow, expected, ".github/workflows/release.yml", errors);
  }
  if (releaseWorkflow.includes("ref: ${{ env.RELEASE_TAG }}")) {
    errors.push(
      ".github/workflows/release.yml must build from the verified immutable source SHA, not env.RELEASE_TAG",
    );
  }
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    'node scripts/wait-for-release-assets.mjs --version "$RELEASE_VERSION" --timeout-ms 2400000 --interval-ms 15000',
    ".github/workflows/deploy-site.yml",
    errors,
  );
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    "releases/tags/${release_tag}",
    ".github/workflows/deploy-site.yml",
    errors,
  );
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    'git merge-base --is-ancestor "$source_sha" "$MAIN_SHA"',
    ".github/workflows/deploy-site.yml",
    errors,
  );
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    "ref: ${{ steps.immutable_source.outputs.source_sha }}",
    ".github/workflows/deploy-site.yml",
    errors,
  );
  requireText(
    files.get(".github/workflows/deploy-site.yml") ?? "",
    'release_tag="$expected_tag"',
    ".github/workflows/deploy-site.yml",
    errors,
  );
  if ((files.get(".github/workflows/deploy-site.yml") ?? "").includes('source_sha="$MAIN_SHA"')) {
    errors.push(
      ".github/workflows/deploy-site.yml must deploy the published release tag, not a same-version main SHA",
    );
  }
  if ((files.get(".github/workflows/deploy-site.yml") ?? "").includes("cache: pnpm")) {
    errors.push(
      ".github/workflows/deploy-site.yml must not save a pnpm cache on the no-install release-defer path",
    );
  }
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

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const errors = checkReleaseConsistency(process.cwd(), parseTagArgument(process.argv.slice(2)));
    if (errors.length > 0) {
      console.error(
        `Release consistency check failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:`,
      );
      for (const error of errors) console.error(`- ${error}`);
      process.exitCode = 1;
    } else {
      const version = JSON.parse(
        readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
      ).version;
      console.log(`Release consistency check passed for v${version}.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
