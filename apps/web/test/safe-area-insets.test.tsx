// Safe-area layout contract: one token layer in packages/ui/src/tokens.css
// (Android's SystemBars CSS variables falling back to env()), consumed
// structurally by every edge-anchored surface. Source assertions follow the
// mobile-touch-targets convention; the connection screen renders for real.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MobileConnectionScreen } from "../src/components/MobileConnectionScreen.tsx";

function read(relativePath: string): string {
  return readFileSync(join(import.meta.dirname, relativePath), "utf8");
}

const SIDES = ["top", "right", "bottom", "left"] as const;

describe("safe-area insets", () => {
  it("defines the single inset token layer: Android CSS variables falling back to env()", () => {
    const tokens = read("../../../packages/ui/src/tokens.css");
    for (const side of SIDES) {
      expect(tokens).toContain(
        `--app-safe-area-${side}: var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px));`,
      );
    }
    // Titlebar control geometry rides the same layer.
    expect(tokens).toContain("--workspace-controls-left: calc(var(--app-safe-area-left) + 0.75rem);");
    expect(tokens).toContain("--workspace-controls-right: calc(var(--app-safe-area-right) + 0.75rem);");
  });

  it("keeps the token layer the only consumer of env(safe-area-inset-*)", () => {
    const appCss = read("../src/app.css");
    expect(appCss).not.toContain("env(safe-area-inset");
    expect(appCss).toContain("padding-top: var(--app-safe-area-top)");
    expect(appCss).toContain(
      "height: calc(var(--workspace-topbar-height) + var(--app-safe-area-top))",
    );
    for (const source of [
      "../src/features/transcript/SessionMain.tsx",
      "../src/components/MobileConnectionScreen.tsx",
      "../../../packages/ui/src/primitives/sheet.tsx",
      "../../../packages/ui/src/primitives/dialog.tsx",
    ]) {
      expect(read(source)).not.toContain("env(safe-area-inset");
    }
  });

  it("pads the composer dock with bottom and side insets", () => {
    expect(read("../src/features/transcript/SessionMain.tsx")).toContain(
      "pr-[max(1rem,var(--app-safe-area-right))] pb-[max(1rem,var(--app-safe-area-bottom))] pl-[max(1rem,var(--app-safe-area-left))]",
    );
  });

  it("keeps rail and session sheets clear of the system bars on their anchored edges", () => {
    const sheet = read("../../../packages/ui/src/primitives/sheet.tsx");
    // Bottom sheets: gesture line; top sheets: status bar.
    expect(sheet).toContain("border-t pb-(--app-safe-area-bottom)");
    expect(sheet).toContain("border-b pt-(--app-safe-area-top)");
    // Side sheets (rail overlay, session panels) span full height and touch
    // one screen edge: top + bottom + their own side.
    expect(sheet).toContain(
      "border-e pt-(--app-safe-area-top) pb-(--app-safe-area-bottom) pl-(--app-safe-area-left)",
    );
    expect(sheet).toContain(
      "border-s pt-(--app-safe-area-top) pb-(--app-safe-area-bottom) pr-(--app-safe-area-right)",
    );
  });

  it("keeps bottom-stuck dialog actions above the navigation bar on phones only", () => {
    const dialog = read("../../../packages/ui/src/primitives/dialog.tsx");
    expect(dialog).toContain(
      "max-sm:pb-(--app-safe-area-bottom) max-sm:pl-(--app-safe-area-left) max-sm:pr-(--app-safe-area-right)",
    );
    // Desktop geometry is untouched: insets are gated behind max-sm on the
    // bottom-stick variant, never on the centered popup base.
    expect(dialog).not.toMatch(/className=\{cn\(\s*"[^"]*pb-\(--app-safe-area-bottom\)/);
  });

  it("keeps the terminal drawer prompt above the gesture line", () => {
    expect(read("../src/features/terminal/TerminalDrawer.tsx")).toContain(
      "border-border border-t bg-background pb-(--app-safe-area-bottom)",
    );
  });

  it("pads Settings, Targets, and Usage scroll ends and the save bar", () => {
    const scrollEnd =
      "pr-[max(1rem,var(--app-safe-area-right))] pb-[calc(1rem+var(--app-safe-area-bottom))] pl-[max(1rem,var(--app-safe-area-left))]";
    expect(read("../src/features/settings/SettingsWorkspace.tsx")).toContain(scrollEnd);
    expect(read("../src/features/targets/TargetsScreen.tsx")).toContain(scrollEnd);
    expect(read("../src/features/usage/UsageScreen.tsx")).toContain(scrollEnd);
    // The save-changes action bar owns the bottom edge while visible.
    expect(read("../src/features/settings/SettingsWorkspace.tsx")).toContain(
      "pt-2 pr-[max(1rem,var(--app-safe-area-right))] pb-[calc(0.5rem+var(--app-safe-area-bottom))] pl-[max(1rem,var(--app-safe-area-left))]",
    );
  });

  it("renders the mobile connection screen with structural insets on every edge", () => {
    const markup = renderToStaticMarkup(<MobileConnectionScreen />);
    expect(markup).toContain("pt-(--app-safe-area-top)");
    expect(markup).toContain("pb-[calc(2.5rem+var(--app-safe-area-bottom))]");
    expect(markup).toContain("pr-[max(1.25rem,var(--app-safe-area-right))]");
    expect(markup).toContain("pl-[max(1.25rem,var(--app-safe-area-left))]");
  });
});
