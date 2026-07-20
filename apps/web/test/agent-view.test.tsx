import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_VIEW_PAGE_SIZE,
  AgentViewScreen,
  reconcileAgentViewPageIndex,
} from "../src/features/agent-view/AgentViewScreen.tsx";
import { AGENT_VIEW_FIXTURE_GROUPS } from "../src/features/agent-view/fixtures.ts";
import {
  filterAgentViewGroups,
  pageAgentViewGroups,
  summarizeAgentView,
  type AgentViewGroup,
} from "../src/features/agent-view/model.ts";

function largeAgentGroup(size: number): AgentViewGroup {
  const fixtureGroup = AGENT_VIEW_FIXTURE_GROUPS[0];
  const fixtureRow = fixtureGroup?.agents[0];
  if (fixtureGroup === undefined || fixtureRow === undefined) {
    throw new Error("Agent View fixture is empty.");
  }
  return {
    ...fixtureGroup,
    viewId: "large-session",
    session: { ...fixtureGroup.session, id: "large-session", title: "Large agent session" },
    agents: Array.from({ length: size }, (_, index) => ({
      ...fixtureRow,
      node: {
        ...fixtureRow.node,
        id: `large-agent-${index}`,
        parentId: index === 0 ? null : `large-agent-${index - 1}`,
        title: `Task agent ${String(index).padStart(5, "0")}`,
      },
      task: `Inspect shard ${String(index).padStart(5, "0")}`,
    })),
  };
}

describe("Agent View control center", () => {
  it("summarizes loaded sessions, running work, failures, and stalls", () => {
    expect(summarizeAgentView(AGENT_VIEW_FIXTURE_GROUPS)).toEqual({
      sessions: 2,
      agents: 11,
      running: 6,
      attention: 2,
      finished: 2,
    });
  });

  it("filters by task metadata and retains the matching agent hierarchy", () => {
    const groups = filterAgentViewGroups(
      AGENT_VIEW_FIXTURE_GROUPS.slice(0, 1),
      "all",
      "packages/client/src/replay.ts",
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.agents.map((row) => row.node.id)).toEqual([
      "agent-main",
      "agent-replay",
    ]);
    expect(groups[0]?.agents.map((row) => [row.depth, row.parent?.title ?? null])).toEqual([
      [0, null],
      [2, "Reconnect suspects"],
    ]);
  });

  it("surfaces failed and stalled agents with ancestors for context", () => {
    const groups = filterAgentViewGroups(AGENT_VIEW_FIXTURE_GROUPS, "attention", "");

    expect(groups).toHaveLength(1);
    expect(
      groups[0]?.agents.map((row) => [row.node.id, row.depth, row.parent?.title ?? null]),
    ).toEqual([
      ["agent-dedupe", 2, "Reconnect suspects"],
      ["agent-soak", 1, "Session agent"],
    ]);
  });

  it("keeps a deep match and its immediate parent context within one bounded page", () => {
    const group = largeAgentGroup(150);
    const agents = group.agents.map((row, index) =>
      index === 149
        ? {
            ...row,
            node: { ...row.node, state: "waiting" as const, evidence: "Waiting for approval." },
          }
        : row,
    );
    const filtered = filterAgentViewGroups([{ ...group, agents }], "attention", "");
    const page = pageAgentViewGroups(filtered, AGENT_VIEW_PAGE_SIZE);

    expect(page).toMatchObject({ totalAgents: 1, visibleAgents: 1 });
    expect(page.groups[0]?.agents[0]).toMatchObject({
      depth: 149,
      parent: { id: "large-agent-148", title: "Task agent 00148" },
      node: { id: "large-agent-149" },
    });
  });

  it("paginates ten thousand hierarchical agents to a bounded mounted row count", () => {
    const filtered = filterAgentViewGroups([largeAgentGroup(10_000)], "all", "");
    const first = pageAgentViewGroups(filtered, AGENT_VIEW_PAGE_SIZE);
    const last = pageAgentViewGroups(filtered, AGENT_VIEW_PAGE_SIZE, 9_900);

    expect(first).toMatchObject({ totalAgents: 10_000, visibleAgents: 100 });
    expect(first.groups[0]?.agents[0]?.node.id).toBe("large-agent-0");
    expect(first.groups[0]?.agents.at(-1)?.node.id).toBe("large-agent-99");
    expect(last).toMatchObject({ totalAgents: 10_000, visibleAgents: 100 });
    expect(last.groups[0]?.agents[0]?.node.id).toBe("large-agent-9900");
    expect(last.groups[0]?.agents.at(-1)?.node.id).toBe("large-agent-9999");
    expect(last.groups[0]?.agents[0]).toMatchObject({
      depth: 9_900,
      parent: { id: "large-agent-9899", title: "Task agent 09899" },
    });
  });

  it("commits a clamped page after shrink and does not jump after growth", () => {
    const afterShrink = reconcileAgentViewPageIndex(1, 1);
    expect(afterShrink).toBe(0);
    expect(reconcileAgentViewPageIndex(afterShrink, 2)).toBe(0);
  });

  it("server-renders only the first bounded page with mobile-sized controls", () => {
    const markup = renderToStaticMarkup(
      <AgentViewScreen
        controller={null}
        fixtureGroups={[largeAgentGroup(10_000)]}
        fixtureNowMs={Date.UTC(2026, 6, 19)}
        onBack={() => undefined}
        onOpenSession={() => undefined}
        snapshot={null}
      />,
    );

    expect(markup).toContain("Showing 1-100 of 10000 matching agents");
    expect(markup).toContain("Task agent 00099");
    expect(markup).not.toContain("Task agent 00100");
    expect(markup).toContain('aria-label="Search loaded agents"');
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("Need attention");
  });
});
