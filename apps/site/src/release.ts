// Single source of truth for the public release: repo, tag, asset names,
// download URLs, and the platform-detection rule the hero button uses.

export const SITE_URL = "https://t4code.net";
export const DOCS_URL = `${SITE_URL}/docs`;
export const REPO_URL = "https://github.com/LycaonLLC/t4-code";
export const OMP_URL = "https://github.com/can1357/oh-my-pi";
export const RELEASE_TAG = "v0.1.3";
export const RELEASE_VERSION = "0.1.3";
export const RELEASES_URL = `${REPO_URL}/releases/tag/${RELEASE_TAG}`;

export type Platform = "linux" | "mac";
export type AssetKind = "deb" | "appimage" | "dmg" | "zip";

export interface ReleaseAsset {
  readonly platform: Platform;
  readonly kind: AssetKind;
  readonly arch: string;
  readonly filename: string;
  readonly label: string;
  readonly url: string;
}

function asset(
  platform: Platform,
  kind: AssetKind,
  arch: string,
  filename: string,
  label: string,
): ReleaseAsset {
  return {
    platform,
    kind,
    arch,
    filename,
    label,
    url: `${REPO_URL}/releases/download/${RELEASE_TAG}/${encodeURIComponent(filename)}`,
  };
}

export const RELEASE_ASSETS: readonly ReleaseAsset[] = [
  asset("linux", "deb", "x86_64", "T4-Code-0.1.3-linux-amd64.deb", "Linux .deb"),
  asset("linux", "appimage", "x86_64", "T4-Code-0.1.3-linux-x86_64.AppImage", "Linux AppImage"),
  asset("mac", "dmg", "arm64", "T4-Code-0.1.3-mac-arm64.dmg", "macOS .dmg"),
  asset("mac", "zip", "arm64", "T4-Code-0.1.3-mac-arm64.zip", "macOS .zip"),
];

export function assetsFor(platform: Platform): readonly ReleaseAsset[] {
  return RELEASE_ASSETS.filter((a) => a.platform === platform);
}

/** Preferred single download per platform: .deb on Linux, .dmg on macOS. */
export function primaryAsset(platform: Platform): ReleaseAsset {
  const kind: AssetKind = platform === "linux" ? "deb" : "dmg";
  const found = RELEASE_ASSETS.find((a) => a.platform === platform && a.kind === kind);
  if (!found) throw new Error(`no ${kind} asset for ${platform}`);
  return found;
}

/**
 * Detect the visitor's platform from a user-agent string. Only Linux and
 * Apple Silicon macOS builds exist; anything else falls back to Linux so the
 * button always points at a real file.
 */
export function detectPlatform(userAgent: string): Platform {
  if (/mac os x|macintosh/i.test(userAgent)) return "mac";
  return "linux";
}
