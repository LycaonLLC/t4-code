import { expect, type Page, test } from "@playwright/test";

import { BuiltWebServer } from "./built-web-server.ts";

let web: BuiltWebServer;

async function dragWithData(
  page: Page,
  sourceSelector: string,
  targetSelector: string,
  payload: string,
): Promise<void> {
  await page.evaluate(
    ({ sourceSelector, targetSelector, payload }) => {
      const source = document.querySelector(sourceSelector);
      const target = document.querySelector(targetSelector);
      if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) {
        throw new Error("drag fixture target is missing");
      }
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", payload);
      source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    },
    { sourceSelector, targetSelector, payload },
  );
}

test.beforeAll(async () => {
  web = new BuiltWebServer();
  await web.start();
});

test.afterAll(async () => {
  await web?.stop();
});

test("matches the Codex rail organization, project actions, and manual drag behavior", async ({
  page,
}) => {
  await page.goto(`${web.url}fixture?reset=1`, { waitUntil: "domcontentloaded" });
  const rail = page.getByRole("navigation", { name: "Working folders and sessions" });

  await rail.getByRole("button", { name: "Organize sessions", exact: true }).click();
  const organize = page.getByRole("dialog", { name: "Organize sidebar", exact: true });
  await expect(organize.getByRole("button", { name: "By project", exact: true })).toBeVisible();
  await expect(organize.getByRole("button", { name: "In one list", exact: true })).toBeVisible();
  await expect(organize.getByRole("button", { name: "Priority", exact: true })).toBeVisible();
  await expect(organize.getByRole("button", { name: "Last updated", exact: true })).toBeVisible();
  await organize.getByRole("button", { name: "Manual order", exact: true }).click();

  const projects = rail.locator("[data-project-id]");
  await expect(projects).toHaveCount(3);
  await dragWithData(
    page,
    '[data-project-drag-handle="proj-omp"]',
    '[data-project-drag-handle="proj-t4"]',
    "project:proj-omp",
  );
  await expect(projects.first()).toHaveAttribute("data-project-id", "proj-t4");

  const t4Sessions = rail.locator('[data-project-id="proj-t4"] [data-session-item]');
  await expect(t4Sessions).toHaveCount(4);
  await dragWithData(
    page,
    '[data-session-item="sess-fixtures"]',
    '[data-session-item="sess-motion"]',
    "session:sess-fixtures",
  );
  await expect(t4Sessions.first()).toHaveAttribute("data-session-item", "sess-motion");

  await expect(
    rail.getByRole("button", { name: "Pin chat Trace duplicate stream frames after reconnect" }),
  ).toBeVisible();
  await expect(
    rail.getByRole("button", {
      name: "Archive chat Trace duplicate stream frames after reconnect",
    }),
  ).toBeVisible();

  await rail.getByRole("button", { name: "Errors", exact: true }).click();
  await rail.getByRole("button", { name: "Actions for t4-code", exact: true }).click();
  await page.getByRole("button", { name: "Mark all as read", exact: true }).click();
  await rail.getByRole("button", { name: "All", exact: true }).click();
  await expect(
    rail.getByRole("button", { name: "t4-code, 4 sessions", exact: true }),
  ).toBeVisible();

  await rail.getByRole("button", { name: "Actions for oh-my-pi", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pin project", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rename project", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal in Finder", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark all as read", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive chats", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename project", exact: true }).click();

  const rename = page.getByRole("dialog", { name: "Rename project", exact: true });
  await rename.getByRole("textbox", { name: "Project name", exact: true }).fill("Runtime Core");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(rail.getByRole("region", { name: "Runtime Core", exact: true })).toBeVisible();

  await rail.getByRole("button", { name: "Actions for Runtime Core", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Remove Hides this project in T4. Files and sessions stay unchanged.",
      exact: true,
    })
    .click();
  await expect(rail.getByRole("region", { name: "Runtime Core", exact: true })).toHaveCount(0);

  await rail.getByRole("button", { name: "Organize sessions", exact: true }).click();
  await page.getByRole("button", { name: "Show Runtime Core", exact: true }).click();
  await expect(rail.getByRole("region", { name: "Runtime Core", exact: true })).toBeVisible();
});
