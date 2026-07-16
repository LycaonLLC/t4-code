import { Menu, type MenuItemConstructorOptions } from "electron";
import { strings } from "./strings.ts";

export interface ApplicationMenuOptions {
  readonly platform?: NodeJS.Platform;
  readonly onOpenUpdates: () => void;
  readonly menu?: Pick<typeof Menu, "buildFromTemplate" | "setApplicationMenu">;
}

export function installApplicationMenu(options: ApplicationMenuOptions): void {
  const platform = options.platform ?? process.platform;
  const menu = options.menu ?? Menu;
  const updateItem: MenuItemConstructorOptions = {
    label: strings.menu.app.updates,
    click: options.onOpenUpdates,
  };
  const template: MenuItemConstructorOptions[] =
    platform === "darwin"
      ? [
          {
            label: strings.menu.app.label,
            submenu: [
              { role: "about", label: strings.menu.app.about },
              { type: "separator" },
              updateItem,
              { type: "separator" },
              { role: "quit", label: strings.menu.app.quit },
            ],
          },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
        ]
      : [
          { role: "fileMenu" },
          { role: "editMenu" },
          { role: "viewMenu" },
          { role: "windowMenu" },
          { label: strings.menu.help.label, submenu: [updateItem] },
        ];
  menu.setApplicationMenu(menu.buildFromTemplate(template));
}
