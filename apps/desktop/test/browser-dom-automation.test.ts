import { describe, expect, it } from "vitest";

import {
  executeBrowserDomAutomation,
  resetBrowserDomAutomation,
} from "../src/browser-dom-automation.ts";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function exposeGlobal(name: "document" | "window", value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function restoreGlobals(): void {
  resetBrowserDomAutomation();
  if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
  else Object.defineProperty(globalThis, "document", originalDocument);
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
  else Object.defineProperty(globalThis, "window", originalWindow);
}

describe("browser DOM Design Mode", () => {
  it("restores every document exactly and reports only T4-owned edit state", async () => {
    const pageWindow = {
      alert: () => undefined,
      confirm: () => false,
      prompt: () => null,
      getSelection: () => null,
    };
    const mainDocument = { designMode: "off" };
    const frameDocument = { designMode: "on" };
    try {
      exposeGlobal("window", pageWindow);

      exposeGlobal("document", mainDocument);
      expect(
        await executeBrowserDomAutomation("browser.design_mode.set", { enabled: true }),
      ).toEqual({ enabled: true, selection: "" });
      expect(mainDocument.designMode).toBe("on");

      exposeGlobal("document", frameDocument);
      expect(
        await executeBrowserDomAutomation("browser.design_mode.set", { enabled: true }),
      ).toEqual({ enabled: true, selection: "" });

      expect(
        await executeBrowserDomAutomation("browser.design_mode.set", { enabled: false }),
      ).toEqual({ enabled: false, selection: "" });
      expect(mainDocument.designMode).toBe("off");
      expect(frameDocument.designMode).toBe("on");
    } finally {
      restoreGlobals();
    }
  });
});
