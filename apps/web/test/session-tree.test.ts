import { describe, expect, it } from "vite-plus/test";

import { SHELL_FIXTURE } from "../src/fixture/data.ts";
import {
  buildProjectGroups,
  formatRelativeTime,
  listVisibleSessionIds,
} from "../src/lib/session-tree.ts";

describe("fixture invariants", () => {
  it("has unique session ids and resolvable projects/hosts", () => {
    const ids = SHELL_FIXTURE.sessions.map((session) => session.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const session of SHELL_FIXTURE.sessions) {
      const project = SHELL_FIXTURE.projects.find((entry) => entry.id === session.projectId);
      expect(project, session.id).toBeDefined();
      expect(SHELL_FIXTURE.hosts.some((host) => host.id === project?.hostId)).toBe(true);
    }
  });

  it("covers the full visible state contract: working, approval, input, plan, done, error, offline, cached", () => {
    const statuses = new Set(
      SHELL_FIXTURE.sessions.map((session) => session.status).filter((s) => s !== null),
    );
    for (const required of [
      "working",
      "pendingApproval",
      "awaitingInput",
      "planReady",
      "completed",
      "error",
    ]) {
      expect([...statuses], required).toContain(required);
    }
    const freshness = new Set(SHELL_FIXTURE.sessions.map((session) => session.freshness));
    expect([...freshness]).toContain("cached");
    expect([...freshness]).toContain("offline");
  });

  it("seeds exactly one unread session for first boot", () => {
    const groups = buildProjectGroups(SHELL_FIXTURE, {}, SHELL_FIXTURE.seedLastVisitedAt);
    const unread = groups.flatMap((group) => group.sessions.filter((row) => row.unread));
    expect(unread.map((row) => row.session.id)).toEqual(["sess-motion"]);
  });
});

describe("buildProjectGroups", () => {
  it("keeps known project headers in Current when they have no current sessions", () => {
    const project = SHELL_FIXTURE.projects[0];
    expect(project).toBeDefined();
    if (project === undefined) return;
    const data = {
      ...SHELL_FIXTURE,
      projects: [project],
      sessions: [],
    };

    const current = buildProjectGroups(data, {}, {}, "current");
    expect(current).toHaveLength(1);
    expect(current[0]?.project.id).toBe(project.id);
    expect(current[0]?.sessions).toEqual([]);
    expect(current[0]?.groupStatus).toBeNull();
    expect(buildProjectGroups(data, {}, {}, "archived")).toEqual([]);
  });

  it("aggregates the highest-priority child status per project", () => {
    const groups = buildProjectGroups(SHELL_FIXTURE, {}, {});
    const omp = groups.find((group) => group.project.id === "proj-omp");
    // pendingApproval outranks working and planReady.
    expect(omp?.groupStatus).toBe("pendingApproval");
    const notesApp = groups.find((group) => group.project.id === "proj-notes");
    expect(notesApp?.groupStatus).toBeNull();
  });

  it("sums pending approvals for the group badge", () => {
    const groups = buildProjectGroups(SHELL_FIXTURE, {}, {});
    const omp = groups.find((group) => group.project.id === "proj-omp");
    expect(omp?.pendingApprovals).toBe(2);
  });

  it("projects default to expanded; explicit collapse hides sessions from jumps", () => {
    const collapsed = buildProjectGroups(SHELL_FIXTURE, { "proj-omp": false }, {});
    const visible = listVisibleSessionIds(collapsed);
    expect(visible).not.toContain("sess-stream");
    expect(visible).toContain("sess-fixtures");

    const all = listVisibleSessionIds(buildProjectGroups(SHELL_FIXTURE, {}, {}));
    expect(all[0]).toBe("sess-stream");
    expect(all).toHaveLength(SHELL_FIXTURE.sessions.length);
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-07-11T12:00:00Z");
  it("buckets minutes, hours, and days", () => {
    expect(formatRelativeTime("2026-07-11T11:59:40Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-07-11T11:14:00Z", now)).toBe("46m ago");
    expect(formatRelativeTime("2026-07-11T09:00:00Z", now)).toBe("3h ago");
    expect(formatRelativeTime("2026-07-10T08:00:00Z", now)).toBe("yesterday");
    expect(formatRelativeTime("2026-07-05T08:00:00Z", now)).toBe("6d ago");
    expect(formatRelativeTime("garbage", now)).toBe("");
  });
});
