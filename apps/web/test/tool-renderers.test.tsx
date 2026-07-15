import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  adaptToolRender,
  type ToolRenderInput,
} from "../src/features/transcript/tool-render/adapter.ts";
import { resolveToolRenderer } from "../src/features/transcript/tool-render/registry.ts";
import { DiffBlock, Output, ResultImages } from "../src/features/transcript/tool-render/parts.tsx";
import type { ToolRenderProps } from "../src/features/transcript/tool-render/types.ts";

function renderTool(
  input: Omit<ToolRenderInput, "state"> & { readonly state?: ToolRenderInput["state"] },
) {
  const view = adaptToolRender({ ...input, state: input.state ?? "ok" });
  const renderer = resolveToolRenderer(view.name);
  const props: ToolRenderProps = {
    name: view.name,
    args: view.args,
    result: view.result,
    running: input.state === "running",
  };
  const Summary = renderer.Summary;
  const Body = renderer.Body;
  return {
    view,
    summary: renderToStaticMarkup(<Summary {...props} />),
    body: Body === undefined ? "" : renderToStaticMarkup(<Body {...props} />),
  };
}

describe("OMP semantic tool renderers", () => {
  it("renders apply-patch input as a file summary and diff instead of an args dump", () => {
    const rendered = renderTool({
      tool: "edit",
      args: {
        input:
          "*** Begin Patch\n*** Update File: src/alpha.ts\n@@\n-oldValue\n+newValue\n*** End Patch",
      },
      result: {
        additions: 1,
        deletions: 1,
        diff: "@@ -1 +1 @@\n-oldValue\n+newValue",
      },
    });

    expect(rendered.view.known).toBe(true);
    expect(rendered.summary).toContain("src/alpha.ts");
    expect(rendered.summary).toContain("+1");
    expect(rendered.body).toContain("tv-diff-row--del");
    expect(rendered.body).toContain("tv-diff-row--add");
    expect(rendered.body.indexOf("tv-diff")).toBeLessThan(rendered.body.indexOf("input"));
    expect(rendered.summary).not.toContain("&quot;input&quot;");
  });

  it("renders a phased todo board with task statuses", () => {
    const rendered = renderTool({
      tool: "todo",
      args: {
        op: "write",
        list: [{ name: "Build", items: ["Wire renderer", "Verify"] }],
      },
      result: {
        content: [],
        details: {
          phases: [
            {
              name: "Build",
              tasks: [
                { content: "Wire renderer", status: "in_progress" },
                { content: "Verify", status: "pending" },
              ],
            },
          ],
        },
      },
    });

    expect(rendered.summary).toContain("write");
    expect(rendered.body).toContain("I. Build");
    expect(rendered.body).toContain("tv-task--in_progress");
    expect(rendered.body).toContain('aria-hidden="true"');
    expect(rendered.body).toContain('class="sr-only">In progress:');
    expect(rendered.body).toContain("tv-task-content");
    expect(rendered.body).toContain("Wire renderer");
    expect(rendered.body).toContain("→");
  });

  it("renders task assignments and agent results with status and output", () => {
    const rendered = renderTool({
      tool: "task",
      args: {
        agent: "reviewer",
        tasks: [
          {
            id: "ui.audit",
            description: "Audit renderer fidelity",
            assignment: "Inspect the tool events and report gaps.",
          },
        ],
      },
      result: {
        content: [],
        details: {
          results: [
            {
              id: "ui.audit",
              description: "Audit renderer fidelity",
              exitCode: 0,
              output: "All requested event families are covered.",
              durationMs: 1250,
            },
          ],
        },
      },
    });

    expect(rendered.summary).toContain("reviewer");
    expect(rendered.body).toContain("ui&gt;audit");
    expect(rendered.body).toContain("assignment");
    expect(rendered.body).toContain("done");
    expect(rendered.body).toContain("All requested event families are covered.");
    expect(rendered.body).toContain("1 succeeded");
  });

  it("renders read selectors, resolved metadata, and full live content", () => {
    const rendered = renderTool({
      tool: "read",
      args: { path: "src/session.ts", range: "20-30" },
      result: {
        content: [{ type: "text", text: "export const session = true;" }],
        details: { resolvedPath: "/workspace/src/session.ts" },
      },
    });

    expect(rendered.summary).toContain("src/session.ts");
    expect(rendered.summary).toContain("20-30");
    expect(rendered.body).toContain("resolved");
    expect(rendered.body).toContain("export const session = true;");
  });

  it("renders shell, search, and fetch payloads semantically", () => {
    const shell = renderTool({
      tool: "bash",
      args: { command: "pnpm test", cwd: "/workspace" },
      result: { output: "3 tests passed", exitCode: 0 },
    });
    expect(shell.summary).toContain("pnpm test");
    expect(shell.body).toContain("tv-cmd-prompt");
    expect(shell.body).toContain("3 tests passed");

    const search = renderTool({
      tool: "search",
      args: { pattern: "ToolCallRow", path: "apps/web" },
      result: { matches: 2, files: ["apps/web/a.tsx", "apps/web/b.tsx"] },
    });
    expect(search.summary).toContain("/ToolCallRow/");
    expect(search.body).toContain("2 matches");
    expect(search.body).toContain("2 files");
    expect(search.body).toContain("apps/web/a.tsx");

    const fetch = renderTool({
      tool: "fetch",
      args: { url: "https://example.test/page" },
      result: {
        output: "# Page title",
        url: "https://example.test/page",
        finalUrl: "https://example.test/final",
        contentType: "text/markdown",
      },
    });
    expect(fetch.summary).toContain("https://example.test/page");
    expect(fetch.body).toContain("final url");
    expect(fetch.body).toContain("https://example.test/final");
    expect(fetch.body).toContain("# Page title");
  });

  it("adapts both structured live results and old durable output records", () => {
    const live = renderTool({
      tool: "bash",
      args: { command: "pwd" },
      result: {
        content: [{ type: "text", text: "/workspace" }],
        details: { exitCode: 0, wallTimeMs: 12 },
      },
    });
    expect(live.body).toContain("/workspace");
    expect(live.body).toContain("wall 12ms");

    const durable = renderTool({
      tool: "bash",
      args: { command: "echo durable" },
      result: { output: "durable output", exitCode: 0 },
    });
    expect(durable.body).toContain("durable output");
    expect(durable.view.result?.details).toMatchObject({ exitCode: 0 });
  });

  it("keeps malformed known tools semantic and reserves raw JSON for unknown tools", () => {
    const malformed = renderTool({
      tool: "bash",
      args: { command: 42 },
      result: { output: "bad command" },
      state: "error",
    });
    expect(malformed.view.known).toBe(true);
    expect(malformed.summary).toContain("[invalid command]");
    expect(malformed.body).toContain("[invalid command]");
    expect(malformed.body).not.toContain("&quot;command&quot;");

    const unknown = renderTool({
      tool: "future_quantum_tool",
      args: { mode: "entangle", count: 3 },
      result: { output: "complete" },
    });
    expect(unknown.view.known).toBe(false);
    expect(unknown.body).toContain("args");
    expect(unknown.body).toContain("&quot;mode&quot;");
    expect(unknown.body).toContain("entangle");
    expect(unknown.body).toContain("complete");
  });

  it("strips internal intent for clean display and avoids duplicate inline images", () => {
    const kept = adaptToolRender({
      tool: "read",
      args: { i: "Inspect the generated diagram", path: "diagram.png" },
      result: {
        content: [
          { type: "text", text: "generated" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      },
      state: "ok",
    });
    expect(kept.intent).toBe("Inspect the generated diagram");
    expect(kept.args).not.toHaveProperty("i");
    expect(kept.result?.content).toHaveLength(2);

    const omitted = adaptToolRender({
      tool: "read",
      args: { path: "diagram.png" },
      result: {
        content: [
          { type: "text", text: "generated" },
          { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
        ],
      },
      state: "ok",
      omitInlineImages: true,
    });
    expect(omitted.result?.content).toEqual([{ type: "text", text: "generated" }]);
  });

  it("exposes expandable blocks and inline result images to assistive technology", () => {
    const output = renderToStaticMarkup(<Output maxLines={1} text={"first\nsecond\nthird"} />);
    const diff = renderToStaticMarkup(<DiffBlock diff={"+first\n+second\n+third"} maxLines={1} />);
    const images = renderToStaticMarkup(
      <ResultImages
        result={{
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
            },
          ],
        }}
      />,
    );

    for (const markup of [output, diff]) {
      expect(markup).toContain('aria-expanded="false"');
      expect(markup).toContain("aria-controls=");
    }
    expect(images).toContain('class="tv-image-button"');
    expect(images).toContain('aria-label="Open tool result image 1"');
    expect(images).toContain('<img alt="" class="tv-img" decoding="async" loading="lazy"');
  });

  it("renders web-search sources as identifiable external links", () => {
    const rendered = renderTool({
      tool: "web_search",
      args: { query: "T4 Code" },
      result: {
        content: [],
        details: {
          response: {
            sources: [{ title: "T4 Code docs", url: "https://example.test/docs" }],
          },
        },
      },
    });

    expect(rendered.body).toContain('class="tv-link"');
    expect(rendered.body).toContain('aria-label="T4 Code docs (opens in a new tab)"');
    expect(rendered.body).toContain('rel="noreferrer"');
  });

  it("keeps active URL schemes and executable inline image payloads inert", () => {
    const search = renderTool({
      tool: "web_search",
      args: { query: "unsafe source" },
      result: {
        content: [],
        details: {
          response: {
            sources: [
              { title: "Script source", url: "javascript:alert(document.domain)" },
              { title: "Data source", url: "data:text/html,<script>alert(1)</script>" },
            ],
          },
        },
      },
    });
    expect(search.body).toContain("Script source");
    expect(search.body).toContain("Data source");
    expect(search.body).not.toContain("href=");
    expect(search.body).not.toContain("javascript:");
    expect(search.body).not.toContain("data:text/html");

    const images = renderToStaticMarkup(
      <ResultImages
        result={{
          content: [
            {
              type: "image",
              mimeType: "image/svg+xml",
              data: btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
            },
            {
              type: "image",
              mimeType: "text/html",
              data: btoa("<script>alert(document.domain)</script>"),
            },
            {
              type: "image",
              mimeType: "image/png",
              data: btoa("<script>alert(document.domain)</script>"),
            },
          ],
        }}
      />,
    );
    expect(images).toBe("");
  });
});
