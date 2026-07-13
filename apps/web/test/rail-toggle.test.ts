import { describe, expect, it } from "vite-plus/test";

import { resolveRailTogglePresentation } from "../src/components/rail-toggle.ts";

describe("session-list titlebar control", () => {
  it("follows the phone sheet instead of the persisted desktop collapse setting", () => {
    expect(
      resolveRailTogglePresentation({
        overlaid: true,
        overlayOpen: false,
        collapsed: false,
      }),
    ).toEqual({ expanded: false, label: "Show session list" });

    expect(
      resolveRailTogglePresentation({
        overlaid: true,
        overlayOpen: true,
        collapsed: true,
      }),
    ).toEqual({ expanded: true, label: "Hide session list" });
  });

  it("follows collapsed state when the rail is docked", () => {
    expect(
      resolveRailTogglePresentation({
        overlaid: false,
        overlayOpen: true,
        collapsed: true,
      }),
    ).toEqual({ expanded: false, label: "Show session list" });
  });
});
