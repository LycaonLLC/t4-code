import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import * as React from "react";

import { PaneContent } from "../src/features/panes/PaneContent.tsx";
import { AgentsPane } from "../src/features/panes/AgentsPane.tsx";
import { ActivityPane } from "../src/features/panes/ActivityPane.tsx";
import { ReviewPane } from "../src/features/panes/ReviewPane.tsx";
import { createInspectorStore, type InspectorStoreApi } from "../src/features/panes/inspector-store.ts";

function createEmptyMockStore(): InspectorStoreApi {
  return createInspectorStore({
    sampleMode: true,
    controller: () => ({
      kind: "fixture",
      performControl() {},
      performReview() {},
      loadDir() {},
      loadPreview() {},
    }),
    seed: {
      activity: [],
      agentMap: { order: [], agents: {} },
      review: {
        files: [],
        selectedPath: null,
        view: "unified",
        comments: [],
        wrap: false,
        viewedByPath: {},
        draftAnchor: null,
      },
      terminals: [],
    },
  });
}

describe("Pane empty state headers and close controls", () => {
  const mockTrailing = <button aria-label="Close pane">X</button>;

  it("renders PaneContent no-store fallback with header and close trailing element", () => {
    const html = renderToStaticMarkup(
      <PaneContent family="agents" trailing={mockTrailing} />
    );
    expect(html).toContain("Agents");
    expect(html).toContain("aria-label=\"Close pane\"");
    expect(html).toContain("No agents running");
  });

  it("renders empty AgentsPane with header and close trailing element", () => {
    const store = createEmptyMockStore();
    const html = renderToStaticMarkup(
      <AgentsPane api={store} sessionId="test" trailing={mockTrailing} />
    );
    expect(html).toContain("Agents");
    expect(html).toContain("aria-label=\"Close pane\"");
    expect(html).toContain("No agents running");
  });

  it("renders empty ActivityPane with header and close trailing element", () => {
    const store = createEmptyMockStore();
    const html = renderToStaticMarkup(
      <ActivityPane api={store} trailing={mockTrailing} />
    );
    expect(html).toContain("Activity");
    expect(html).toContain("aria-label=\"Close pane\"");
    expect(html).toContain("Nothing recorded yet");
  });

  it("renders empty ReviewPane with header and close trailing element", () => {
    const store = createEmptyMockStore();
    const html = renderToStaticMarkup(
      <ReviewPane api={store} trailing={mockTrailing} />
    );
    expect(html).toContain("Review");
    expect(html).toContain("aria-label=\"Close pane\"");
    expect(html).toContain("Nothing to review");
  });
});
