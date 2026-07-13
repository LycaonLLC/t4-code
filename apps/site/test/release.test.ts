// Release contract guard: exact v0.1.3 asset names and URLs, and the
// platform-detection rule the hero download button relies on.
import { describe, expect, it } from "vite-plus/test";
import {
  assetsFor,
  detectPlatform,
  primaryAsset,
  RELEASE_ASSETS,
  RELEASE_TAG,
  RELEASE_VERSION,
  REPO_URL,
} from "../src/release.ts";

describe("release assets", () => {
  it("carries the four contracted v0.1.3 filenames", () => {
    expect(RELEASE_ASSETS.map((a) => a.filename)).toEqual([
      "T4-Code-0.1.3-linux-amd64.deb",
      "T4-Code-0.1.3-linux-x86_64.AppImage",
      "T4-Code-0.1.3-mac-arm64.dmg",
      "T4-Code-0.1.3-mac-arm64.zip",
    ]);
  });

  it("builds download URLs under the release tag", () => {
    for (const asset of RELEASE_ASSETS) {
      expect(asset.url).toBe(
        `${REPO_URL}/releases/download/${RELEASE_TAG}/${asset.filename}`,
      );
    }
  });

  it("targets the public LycaonLLC repo", () => {
    expect(REPO_URL).toBe("https://github.com/LycaonLLC/t4-code");
    expect(RELEASE_TAG).toBe("v0.1.3");
    expect(RELEASE_VERSION).toBe("0.1.3");
  });

  it("splits assets by platform with correct architectures", () => {
    expect(assetsFor("linux").every((a) => a.arch === "x86_64")).toBe(true);
    expect(assetsFor("mac").every((a) => a.arch === "arm64")).toBe(true);
    expect(assetsFor("linux")).toHaveLength(2);
    expect(assetsFor("mac")).toHaveLength(2);
  });

  it("picks .deb for Linux and .dmg for macOS as the primary download", () => {
    expect(primaryAsset("linux").kind).toBe("deb");
    expect(primaryAsset("mac").kind).toBe("dmg");
  });
});

describe("detectPlatform", () => {
  it("detects macOS user agents", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      ),
    ).toBe("mac");
  });

  it("detects Linux user agents", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")).toBe(
      "linux",
    );
  });

  it("falls back to Linux for platforms without a build", () => {
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("linux");
    expect(detectPlatform("")).toBe("linux");
  });
});
