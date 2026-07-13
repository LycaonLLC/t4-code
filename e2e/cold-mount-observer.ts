import type { Page } from "@playwright/test";

export interface ColdMountSample {
  readonly overlayCopies: number;
  readonly visibleCopies: number;
}

export async function installColdMountObserver(page: Page, expectedText: string): Promise<void> {
  await page.addInitScript((text) => {
    const samples: ColdMountSample[] = [];
    Object.assign(window, { __t4ColdMountSamples: samples });
    const inspect = () => {
      const log = document.querySelector('[role="log"][aria-label="Transcript"]');
      if (!(log instanceof HTMLElement)) return;
      const overlay = log.querySelector<HTMLElement>("[data-cold-mount-overlay]");
      if (overlay === null) return;
      const matches = (paragraph: HTMLElement) => paragraph.textContent?.trim() === text;
      const overlayCopies = [...overlay.querySelectorAll<HTMLElement>("p")].filter(matches).length;
      const visibleCopies = [...log.querySelectorAll<HTMLElement>("p")].filter((paragraph) => {
        if (!matches(paragraph)) return false;
        const style = getComputedStyle(paragraph);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      }).length;
      samples.push({ overlayCopies, visibleCopies });
    };
    const observer = new MutationObserver(inspect);
    const start = () => {
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      inspect();
    };
    if (document.documentElement === null) {
      document.addEventListener("readystatechange", start, { once: true });
    } else {
      start();
    }
  }, expectedText);
}

export async function readColdMountSamples(page: Page): Promise<readonly ColdMountSample[]> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __t4ColdMountSamples?: readonly ColdMountSample[];
        }
      ).__t4ColdMountSamples ?? [],
  );
}
