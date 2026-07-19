import type { ProjectionSnapshot } from "@t4-code/client";
import { createProjectionSnapshot } from "@t4-code/client";
import type { SessionRef } from "@t4-code/protocol";
import { hostId, projectId, revision, sessionId } from "@t4-code/protocol";
import { describe, expect, it } from "vite-plus/test";

import { attentionFrom, canWriteSession, relativeTime, transcriptDisplayState } from "./session-view";

function ref(overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    hostId: hostId("host-a"),
    sessionId: sessionId("session-a"),
    project: { projectId: projectId("project-a"), name: "T4 Code" },
    revision: revision("revision-a"),
    title: "Build the companion",
    status: "active",
    updatedAt: "2026-07-19T12:00:00.000Z",
    ...overrides,
  };
}

describe("companion session view", () => {
  it("sorts oldest attention first", () => {
    const first = ref({
      attention: {
        pending: [{ kind: "approval", id: "a", title: "Approve", summary: "Run tests", requestedAt: "2026-07-19T12:00:00.000Z" }],
        pendingCount: 1,
        truncated: false,
      },
    });
    const second = ref({
      sessionId: sessionId("session-b"),
      attention: {
        pending: [{ kind: "question", id: "b", question: "Which branch?", options: [], allowText: true, requestedAt: "2026-07-19T12:05:00.000Z" }],
        pendingCount: 1,
        truncated: false,
      },
    });
    const base = createProjectionSnapshot();
    const snapshot = {
      ...base,
      sessionIndex: new Map([
        ["host-a\u0000session-b", second],
        ["host-a\u0000session-a", first],
      ]),
    } as ProjectionSnapshot;
    expect(attentionFrom(snapshot).map((item) => item.item.id)).toEqual(["a", "b"]);
  });

	it("refuses writes while another app controls the session", () => {
		expect(canWriteSession(ref())).toBe(false);
		expect(canWriteSession(ref(), true)).toBe(true);
		expect(canWriteSession(ref({ status: "idle" }))).toBe(true);
		expect(canWriteSession(ref({
			liveState: { sessionControl: { mode: "observer", lockStatus: "live", transcript: "live" } },
		}), true)).toBe(false);
	});

  it("formats compact relative times", () => {
    const now = Date.parse("2026-07-19T13:00:00.000Z");
    expect(relativeTime("2026-07-19T12:59:45.000Z", now)).toBe("now");
    expect(relativeTime("2026-07-19T12:42:00.000Z", now)).toBe("18m");
    expect(relativeTime("2026-07-17T13:00:00.000Z", now)).toBe("2d");
  });

  it("stops calling an empty completed transcript a loading transcript", () => {
    expect(transcriptDisplayState(false, 0)).toBe("loading");
    expect(transcriptDisplayState(true, 0)).toBe("empty");
    expect(transcriptDisplayState(false, 1)).toBe("ready");
    expect(transcriptDisplayState(true, 1)).toBe("ready");
  });
});
