import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { describeSessionState } from "../src/components/Rail.tsx";
import {
  SessionActivityBanner,
  SessionLifecycleBadge,
} from "../src/features/transcript/SessionMain.tsx";
import type { WorkspaceSession } from "../src/lib/workspace-data.ts";

const BASE_SESSION: WorkspaceSession = {
  id: "session-a",
  projectId: "project-a",
  title: "Session",
  model: "model",
  status: null,
  freshness: "live",
  pendingApprovals: 0,
  latestTurnCompletedAt: null,
  createdAt: "2026-07-20T10:00:00Z",
  updatedAt: "2026-07-20T10:00:00Z",
  lastActivity: "",
};

describe("truthful session state presentation", () => {
  it("keeps idle, stopped, and missing lifecycle signals distinct", () => {
    expect(describeSessionState({ ...BASE_SESSION, lifecycle: "idle" })).toBe("Idle");
    expect(describeSessionState({ ...BASE_SESSION, lifecycle: "closed" })).toBe("Stopped");
    expect(describeSessionState(BASE_SESSION)).toBe("Status unknown");
  });

  it("lets freshness and confirmed ownership override lifecycle copy", () => {
    expect(describeSessionState({ ...BASE_SESSION, freshness: "cached", lifecycle: "idle" })).toBe(
      "Cached",
    );
    expect(describeSessionState({ ...BASE_SESSION, control: "observer", lifecycle: "idle" })).toBe(
      "Active elsewhere",
    );
  });

  it("shows the same explicit lifecycle in the task header", () => {
    const idle = renderToStaticMarkup(
      <SessionLifecycleBadge session={{ ...BASE_SESSION, lifecycle: "idle" }} />,
    );
    const stopped = renderToStaticMarkup(
      <SessionLifecycleBadge session={{ ...BASE_SESSION, lifecycle: "closed" }} />,
    );
    const unknown = renderToStaticMarkup(<SessionLifecycleBadge session={BASE_SESSION} />);

    expect(idle).toContain("Idle");
    expect(stopped).toContain("Stopped");
    expect(unknown).toContain("Status unknown");
  });

  it("renders a moving visual heartbeat only while work is confirmed", () => {
    const working = renderToStaticMarkup(
      <SessionActivityBanner activity="working" nowMs={0} startedAt={null} />,
    );
    expect(working).toContain('data-session-activity-banner="working"');
    expect(working).toContain('data-status="working"');
    expect(working).toContain("animate-ping");
    expect(working).toContain("Working");
    expect(
      renderToStaticMarkup(<SessionActivityBanner activity={null} nowMs={0} startedAt={null} />),
    ).toBe("");
  });

  it("starts the elapsed label from the runtime clock instead of the wall clock", () => {
    const working = renderToStaticMarkup(
      <SessionActivityBanner
        activity="working"
        nowMs={Date.parse("2026-07-20T10:00:05Z")}
        startedAt="2026-07-20T10:00:00Z"
      />,
    );

    expect(working).toContain("5s");
  });
});
