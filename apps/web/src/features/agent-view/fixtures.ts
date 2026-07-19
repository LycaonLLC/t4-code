import { SHELL_FIXTURE } from "../../fixture/data.ts";
import { FIXTURE_EPOCH_MS, fixtureAgentsForSession } from "../panes/fixtures.ts";
import type { AgentViewGroup } from "./model.ts";

const VISIBLE_SESSION_IDS: Readonly<Record<string, true>> = {
  "sess-stream": true,
  "sess-bundle": true,
};

export const AGENT_VIEW_FIXTURE_NOW_MS = FIXTURE_EPOCH_MS;

/** Global Agent View sample built from the same agents shown in session panes. */
export const AGENT_VIEW_FIXTURE_GROUPS: readonly AgentViewGroup[] = SHELL_FIXTURE.sessions
  .filter((session) => VISIBLE_SESSION_IDS[session.id] === true)
  .map((session) => ({
    viewId: session.id,
    session,
    projectName:
      SHELL_FIXTURE.projects.find((project) => project.id === session.projectId)?.name ??
      "Sample project",
    agents: fixtureAgentsForSession(session.id).map((node) => ({
      node,
      task:
        node.kind === "main"
          ? "Coordinate the reconnect investigation and consolidate verified findings."
          : node.kind === "batch"
            ? "Inspect the replay boundary, soak behavior, and documentation in parallel."
            : node.path === null
              ? "Report a bounded finding back to the parent session."
              : `Inspect ${node.path} and report evidence.`,
      resumable: node.state === "parked",
    })),
  }));
