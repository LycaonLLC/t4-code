import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_DIST = resolve(REPO_ROOT, "apps/web/dist");
const JITI = resolve(REPO_ROOT, "packages/fixture-server/node_modules/.bin/jiti");
const FIXTURE_PROCESS = resolve(REPO_ROOT, "e2e/fixture-process.ts");
const SESSION_VIEW_ID = "host-stream/session-stream";
const SESSION_TITLE = "stream-v1 fixture";
const CONNECTED_COPY =
  "This Tailnet connection is live. Choose a session from the list on the left to inspect it.";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function injectBackend(html: string, wsUrl: string): string {
  const payload = JSON.stringify({ wsUrl, label: "Fixture backend" }).replaceAll("<", "\\u003c");
  const tag = `<script id="t4-backend" type="application/json">${payload}</script>`;
  if (!html.includes("</head>")) throw new Error("web dist index is missing </head>");
  return html.replace("</head>", `${tag}</head>`);
}

class BuiltWebServer {
  private readonly server: Server;
  private port = 0;

  constructor(private readonly wsUrl: string) {
    this.server = createServer((request, response) => {
      void this.handle(request.url ?? "/", request.method ?? "GET")
        .then(({ body, contentType, status }) => {
          response.writeHead(status, {
            "cache-control": "no-store",
            "content-type": contentType,
            "x-content-type-options": "nosniff",
          });
          response.end(request.method === "HEAD" ? undefined : body);
        })
        .catch((error: unknown) => {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end(error instanceof Error ? error.message : "fixture web server failed");
        });
    });
  }

  get url(): string {
    if (this.port === 0) throw new Error("fixture web server is not running");
    return `http://127.0.0.1:${this.port}/`;
  }

  async start(): Promise<void> {
    await access(resolve(WEB_DIST, "index.html"));
    await new Promise<void>((resolveStart, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        this.port = (this.server.address() as AddressInfo).port;
        resolveStart();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });
  }

  async stop(): Promise<void> {
    if (this.port === 0) return;
    await new Promise<void>((resolveStop) => this.server.close(() => resolveStop()));
    this.port = 0;
  }

  private async handle(
    rawUrl: string,
    method: string,
  ): Promise<{ body: Buffer | string; contentType: string; status: number }> {
    if (method !== "GET" && method !== "HEAD") {
      return { body: "method not allowed", contentType: "text/plain; charset=utf-8", status: 405 };
    }
    const pathname = decodeURIComponent(new URL(rawUrl, "http://fixture.invalid").pathname);
    if (pathname === "/favicon.ico") {
      return { body: Buffer.alloc(0), contentType: "image/x-icon", status: 204 };
    }
    if (pathname === "/" || pathname === "/index.html") {
      const index = await readFile(resolve(WEB_DIST, "index.html"), "utf8");
      return {
        body: injectBackend(index, this.wsUrl),
        contentType: MIME_TYPES[".html"]!,
        status: 200,
      };
    }

    const candidate = resolve(WEB_DIST, `.${pathname}`);
    if (!candidate.startsWith(`${WEB_DIST}${sep}`)) {
      return { body: "not found", contentType: "text/plain; charset=utf-8", status: 404 };
    }
    try {
      if (!(await stat(candidate)).isFile()) throw new Error("not a file");
      return {
        body: await readFile(candidate),
        contentType: MIME_TYPES[extname(candidate)] ?? "application/octet-stream",
        status: 200,
      };
    } catch {
      return { body: "not found", contentType: "text/plain; charset=utf-8", status: 404 };
    }
  }
}

class FixtureProcess {
  private child: ChildProcess | null = null;
  private controlUrl = "";
  wsUrl = "";

  async start(): Promise<void> {
    await access(JITI);
    const child = spawn(JITI, [FIXTURE_PROCESS], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null)
      throw new Error("fixture process pipes are unavailable");

    let output = "";
    let errors = "";
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    await new Promise<void>((resolveStart, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`fixture process did not start\n${errors}`));
      }, 10_000);
      const fail = (error: Error) => {
        clearTimeout(timeout);
        child.kill("SIGTERM");
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        fail(new Error(`fixture process exited before ready (${code ?? signal})\n${errors}`));
      };
      child.once("error", fail);
      child.once("exit", onExit);
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        output += chunk;
        const line = output
          .split("\n")
          .find((candidate) => candidate.startsWith("T4_FIXTURE_READY "));
        if (line === undefined) return;
        try {
          const ready = JSON.parse(line.slice("T4_FIXTURE_READY ".length)) as {
            wsUrl: string;
            controlUrl: string;
          };
          this.wsUrl = ready.wsUrl;
          this.controlUrl = ready.controlUrl;
          clearTimeout(timeout);
          child.off("error", fail);
          child.off("exit", onExit);
          resolveStart();
        } catch (error) {
          fail(error instanceof Error ? error : new Error("invalid fixture ready line"));
        }
      });
    });
  }

  async advanceBy(ms: number): Promise<void> {
    const response = await fetch(`${this.controlUrl}/advance?ms=${ms}`, { method: "POST" });
    if (!response.ok) throw new Error(`fixture advance failed: ${response.status}`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolveStop) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolveStop();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolveStop();
      });
    });
  }
}

let fixture: FixtureProcess;
let web: BuiltWebServer;

test.beforeAll(async () => {
  fixture = new FixtureProcess();
  await fixture.start();
  web = new BuiltWebServer(fixture.wsUrl);
  await web.start();
});

test.afterAll(async () => {
  await web?.stop();
  await fixture?.stop();
});

async function openConnectedRoot(page: Page): Promise<void> {
  await page.goto(web.url, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(CONNECTED_COPY, { exact: true })).toBeVisible();
  await expect(page.getByText("Sample data", { exact: true })).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");
  const injectedBackend = page.locator("#t4-backend");
  await expect(injectedBackend).toHaveCount(1);
  const payload = JSON.parse((await injectedBackend.textContent()) ?? "null") as Record<
    string,
    unknown
  >;
  expect(Object.keys(payload).sort()).toEqual(["label", "wsUrl"]);
  expect(payload.label).toBe("Fixture backend");
  expect(payload.wsUrl).toBe(fixture.wsUrl);
}

async function openSession(page: Page, mobile: boolean): Promise<void> {
  await openConnectedRoot(page);
  if (mobile) {
    const toggle = page.getByRole("button", { name: "Show session list", exact: true });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByRole("dialog", { name: "Projects and sessions" })).toBeVisible();
  }

  const session = page.locator(`[data-session-row="${SESSION_VIEW_ID}"]`);
  await expect(session).toBeVisible();
  await expect(session).toHaveAttribute("aria-label", `${SESSION_TITLE}, fixture-model, working`);
  await session.click();

  await expect(page).toHaveURL(/#\/sessions\//u);
  await expect(page.getByRole("log", { name: "Transcript" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message the session" })).toBeEnabled();
  await expect(page.getByText("Offline", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Cached", { exact: true })).toHaveCount(0);
}

test.describe.configure({ mode: "serial" });

test("uses an injected backend, streams once, settles durably, and reloads history", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await openSession(page, false);

  const rows = page.locator("[data-transcript-row]");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Hello world");

  const composer = page.getByRole("textbox", { name: "Message the session" });
  await composer.fill("browser e2e prompt");
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(composer).toHaveValue("");

  await fixture.advanceBy(0);
  await expect(page.getByRole("button", { name: "Stop the running turn" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible();

  await fixture.advanceBy(10);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Hello");
  const streamingCopy = rows.nth(1).getByRole("button", { name: "Copy response" });
  await expect(streamingCopy).toBeHidden();

  await fixture.advanceBy(10);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Hello world");
  await expect(streamingCopy).toBeHidden();

  await fixture.advanceBy(10);
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText("Hello world");
  await expect(rows.nth(1).getByRole("button", { name: "Copy response" })).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("log", { name: "Transcript" })).toBeVisible();
  const reloadedRows = page.locator("[data-transcript-row]");
  await expect(reloadedRows).toHaveCount(2);
  await expect(reloadedRows.nth(0)).toContainText("Hello world");
  await expect(reloadedRows.nth(1)).toContainText("Hello world");

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 390, height: 500 },
  { width: 360, height: 800 },
  { width: 320, height: 568 },
] as const) {
  test(`keeps navigation and send reachable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openSession(page, true);

    const composer = page.getByRole("textbox", { name: "Message the session" });
    await composer.fill(`reachable at ${viewport.width}x${viewport.height}`);
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeVisible();
    await expect(send).toBeEnabled();
    const geometry = await send.evaluate((element) => {
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
        bodyWidth: document.body.scrollWidth,
      };
    });

    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 0.5);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 0.5);
    expect(geometry.width).toBeGreaterThanOrEqual(44);
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewportWidth);

    const textareaBox = await composer.boundingBox();
    expect(textareaBox).not.toBeNull();
    expect(textareaBox!.x).toBeGreaterThanOrEqual(0);
    expect(textareaBox!.x + textareaBox!.width).toBeLessThanOrEqual(viewport.width + 0.5);

    // Send for real, hold virtual time at the canonical turn.start boundary,
    // and prove all three active-turn actions are visible, tappable, and at
    // least the 44px mobile target size at the smallest supported viewport.
    await send.click();
    await fixture.advanceBy(0);
    await composer.fill("active turn action");
    for (const name of ["Stop", "Queue", "Steer"] as const) {
      const action = page.getByRole("button", { name, exact: true });
      await expect(action).toBeVisible();
      await expect(action).toBeEnabled();
      await action.click({ trial: true });
      const actionGeometry = await action.evaluate((element) => {
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
        };
      });
      expect(actionGeometry.left, name).toBeGreaterThanOrEqual(0);
      expect(actionGeometry.top, name).toBeGreaterThanOrEqual(0);
      expect(actionGeometry.right, name).toBeLessThanOrEqual(
        actionGeometry.viewportWidth + 0.5,
      );
      expect(actionGeometry.bottom, name).toBeLessThanOrEqual(
        actionGeometry.viewportHeight + 0.5,
      );
      expect(actionGeometry.width, name).toBeGreaterThanOrEqual(44);
      expect(actionGeometry.height, name).toBeGreaterThanOrEqual(44);
    }
    // Stop is a challenged command in real OMP. Exercise the actual
    // request -> confirmation -> confirm -> original-request response
    // correlation, rather than letting the fixture grant it immediately.
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByText("Approval needed", { exact: true })).toBeVisible();
    await expect(page.getByText("session.cancel", { exact: true })).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeVisible();
    const approvalGeometry = await approve.evaluate((element) => {
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
      };
    });
    expect(approvalGeometry.left).toBeGreaterThanOrEqual(0);
    expect(approvalGeometry.top).toBeGreaterThanOrEqual(0);
    expect(approvalGeometry.right).toBeLessThanOrEqual(approvalGeometry.viewportWidth + 0.5);
    expect(approvalGeometry.bottom).toBeLessThanOrEqual(approvalGeometry.viewportHeight + 0.5);
    expect(approvalGeometry.width).toBeGreaterThanOrEqual(44);
    expect(approvalGeometry.height).toBeGreaterThanOrEqual(44);
    await approve.click();
    await expect(page.getByText("Approval needed", { exact: true })).toBeHidden();
    await fixture.advanceBy(30);
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  });
}
