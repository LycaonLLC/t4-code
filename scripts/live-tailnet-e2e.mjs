#!/usr/bin/env node

import { chromium } from "@playwright/test";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function parseArguments(values) {
  const options = { exerciseCancel: false };
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (name === "--exercise-cancel") {
      options.exerciseCancel = true;
      continue;
    }
    if (!name?.startsWith("--")) throw new Error(`unexpected argument: ${name ?? ""}`);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
    index += 1;
    if (name === "--url") options.url = value;
    else if (name === "--session") options.sessionId = value;
    else if (name === "--expect-before") options.expectBefore = value;
    else if (name === "--prompt") options.prompt = value;
    else if (name === "--expect-after") options.expectAfter = value;
    else if (name === "--screenshot") options.screenshot = value;
    else throw new Error(`unknown argument: ${name}`);
  }
  if (options.url === undefined) throw new Error("--url is required");
  const url = new URL(options.url);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".ts.net")) {
    throw new Error("--url must be a Tailnet HTTPS URL");
  }
  if (options.sessionId === undefined || !UUID.test(options.sessionId)) {
    throw new Error("--session must be a UUID");
  }
  if (options.prompt === undefined || options.expectAfter === undefined) {
    throw new Error("--prompt and --expect-after are required");
  }
  return { ...options, url: url.toString() };
}

async function waitForText(page, text, timeout = 120_000) {
  const locator = page.getByText(text, { exact: true }).first();
  await locator.waitFor({ state: "visible", timeout });
  return locator;
}

async function controlGeometry(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
}

function assertReachable(name, geometry) {
  if (
    geometry.left < 0 ||
    geometry.top < 0 ||
    geometry.right > geometry.viewportWidth + 0.5 ||
    geometry.bottom > geometry.viewportHeight + 0.5 ||
    geometry.width < 44 ||
    geometry.height < 44 ||
    geometry.documentWidth > geometry.viewportWidth
  ) {
    throw new Error(`${name} is not mobile-reachable: ${JSON.stringify(geometry)}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const launchOptions = { headless: true };
  if (process.env.T4_CHROME_PATH) launchOptions.executablePath = process.env.T4_CHROME_PATH;
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForText(
      page,
      "This Tailnet connection is live. Choose a session from the list on the left to inspect it.",
      30_000,
    );
    const injectedBackend = await page.locator("#t4-backend").textContent();
    const backend = JSON.parse(injectedBackend ?? "null");
    if (typeof backend?.wsUrl !== "string" || !backend.wsUrl.startsWith("wss://")) {
      throw new Error("Tailnet page did not inject a secure backend");
    }

    await page.getByRole("button", { name: "Show session list", exact: true }).click();
    const session = page.locator(`[data-session-row$="/${options.sessionId}"]`);
    await session.waitFor({ state: "visible", timeout: 30_000 });
    const sessionLabel = await session.getAttribute("aria-label");
    await session.click();
    const composer = page.getByRole("textbox", { name: "Message the session" });
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    if (!(await composer.isEnabled())) throw new Error("session composer is disabled");
    if (options.expectBefore !== undefined) await waitForText(page, options.expectBefore, 30_000);

    const send = page.getByRole("button", { name: "Send", exact: true });
    await composer.fill(options.prompt);
    assertReachable("composer", await controlGeometry(composer));
    assertReachable("send", await controlGeometry(send));
    await send.click();
    await waitForText(page, options.expectAfter);

    let cancelProof = "not requested";
    if (options.exerciseCancel) {
      await composer.fill(
        "T4 live cancellation check. Work silently for a while before replying so the remote Stop control can be tested.",
      );
      await send.click();
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      await stop.waitFor({ state: "visible", timeout: 30_000 });
      assertReachable("stop", await controlGeometry(stop));
      await stop.click();
      await waitForText(page, "Approval needed", 30_000);
      await waitForText(page, "session.cancel", 30_000);
      const approve = page.getByRole("button", { name: "Approve", exact: true });
      await approve.waitFor({ state: "visible", timeout: 30_000 });
      assertReachable("approve", await controlGeometry(approve));
      await approve.click();
      await page.getByText("Approval needed", { exact: true }).waitFor({ state: "hidden", timeout: 30_000 });
      await send.waitFor({ state: "visible", timeout: 30_000 });
      cancelProof = "request -> confirmation -> approve -> original command settled";
    }

    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    // The transcript virtualizes older rows, so durable reload proof must use
    // the response produced by this run rather than an arbitrarily old seed.
    await waitForText(page, options.expectAfter, 30_000);
    await page.waitForTimeout(1_000);
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    await waitForText(page, options.expectAfter, 30_000);
    assertReachable("reloaded composer", await controlGeometry(composer));
    assertReachable("reloaded send", await controlGeometry(send));
    const body = await page.locator("body").innerText();
    if (body.split("\n").includes("Offline") || body.split("\n").includes("Cached")) {
      throw new Error("session did not reload in a live state");
    }
    if (options.screenshot !== undefined) {
      await page.screenshot({ path: options.screenshot, fullPage: true });
    }
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(
        `browser errors: ${JSON.stringify({ consoleErrors, pageErrors })}`,
      );
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          url: page.url(),
          viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
          backend,
          sessionId: options.sessionId,
          sessionLabel,
          historyReloaded: true,
          cancelProof,
          consoleErrors,
          pageErrors,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

await main();
