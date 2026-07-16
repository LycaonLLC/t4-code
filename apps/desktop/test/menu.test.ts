import { describe, expect, it } from "vite-plus/test";
import type { MenuItemConstructorOptions } from "electron";
import { installApplicationMenu } from "../src/menu.ts";
import { strings } from "../src/strings.ts";

function capture(platform: NodeJS.Platform) {
  let template: readonly MenuItemConstructorOptions[] = [];
  let installed: unknown;
  const marker = { menu: true };
  let opened = 0;
  installApplicationMenu({
    platform,
    onOpenUpdates: () => {
      opened += 1;
    },
    menu: {
      buildFromTemplate: (value) => {
        template = value as readonly MenuItemConstructorOptions[];
        return marker as never;
      },
      setApplicationMenu: (value) => {
        installed = value;
      },
    },
  });
  return {
    template,
    installed,
    marker,
    get opened() {
      return opened;
    },
  };
}

function updateItem(template: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions {
  for (const top of template) {
    if (!Array.isArray(top.submenu)) continue;
    const item = top.submenu.find(
      (candidate) => candidate.label === strings.menu.app.updates,
    );
    if (item !== undefined) return item;
  }
  throw new Error("update menu item missing");
}

describe("desktop update menu", () => {
  it("installs a macOS app-menu update entry that only requests the update surface", () => {
    const result = capture("darwin");
    expect(result.installed).toBe(result.marker);
    expect(result.template[0]?.label).toBe(strings.menu.app.label);
    const item = updateItem(result.template);
    expect(item.label).toBe("Updates\u2026");
    item.click?.(undefined as never, undefined as never, undefined as never);
    expect(result.opened).toBe(1);
  });

  it("installs the same explicit action under Help on Linux", () => {
    const result = capture("linux");
    const help = result.template.find((item) => item.label === strings.menu.help.label);
    expect(help).toBeDefined();
    const item = updateItem(result.template);
    expect(item.label).toBe("Updates\u2026");
    item.click?.(undefined as never, undefined as never, undefined as never);
    expect(result.opened).toBe(1);
  });
});
