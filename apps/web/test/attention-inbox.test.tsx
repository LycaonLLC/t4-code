import type { DesktopRuntimeSnapshot } from "@t4-code/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ATTENTION_FIXTURE_NOW_MS,
  ATTENTION_INBOX_FIXTURES,
  AttentionInboxScreen,
  buildAttentionInboxViewModel,
  formatAttentionAge,
  formatAttentionExpiry,
  nextAttentionRefreshDelay,
  type AttentionInboxItem,
} from "../src/features/attention/index.ts";
import { SHELL_FIXTURE } from "../src/fixture/data.ts";
import { sessionAttentionOutcomeMarker, sessionViewId } from "../src/platform/live-workspace.ts";

const callbacks = {
  onAction: () => {},
  onOpenSession: () => {},
  onMarkSeen: () => {},
  onMarkAllUpdatesSeen: () => {},
};

describe("attention inbox view model", () => {
  it("de-duplicates stable keys and orders expiring work before the oldest request", () => {
    const fixture = ATTENTION_INBOX_FIXTURES.mixed;
    const confirmation: AttentionInboxItem = {
      kind: "confirmation",
      key: "confirm-soon",
      requestId: "confirm-soon",
      session: fixture.items[0]!.session,
      title: "Confirm soon",
      summary: "This connection-bound confirmation expires first.",
      occurredAtMs: ATTENTION_FIXTURE_NOW_MS - 60_000,
      expiresAtMs: ATTENTION_FIXTURE_NOW_MS + 30_000,
      actionState: { status: "ready" },
    };
    const model = buildAttentionInboxViewModel([
      ...fixture.items,
      confirmation,
      { ...confirmation },
    ]);

    expect(model.sections[0].items[0]?.key).toBe("confirm-soon");
    expect(model.totalCount).toBe(fixture.items.length + 1);
    expect(model.urgentCount).toBe(6);
    expect(model.unseenDoneCount).toBe(1);
  });

  it("keeps seen outcomes out of urgent and unread counts", () => {
    const model = buildAttentionInboxViewModel(ATTENTION_INBOX_FIXTURES.mixed.items);

    expect(model.sections.map((section) => [section.label, section.items.length])).toEqual([
      ["Needs you", 4],
      ["Problems", 1],
      ["Done", 2],
    ]);
    expect(model.urgentCount).toBe(5);
    expect(model.unseenOutcomeCount).toBe(2);
  });

  it("keeps every sample inbox item linked to a session visible in the sample rail", () => {
    const sampleSessionIds = new Set(SHELL_FIXTURE.sessions.map((session) => session.id));
    expect(
      ATTENTION_INBOX_FIXTURES.sample.items.every((item) =>
        sampleSessionIds.has(item.session.sessionId),
      ),
    ).toBe(true);
  });

  it("formats short ages and connection-bound expiry without calendar ambiguity", () => {
    expect(formatAttentionAge(ATTENTION_FIXTURE_NOW_MS - 59_000, ATTENTION_FIXTURE_NOW_MS)).toBe(
      "now",
    );
    expect(
      formatAttentionAge(ATTENTION_FIXTURE_NOW_MS - 90 * 60_000, ATTENTION_FIXTURE_NOW_MS),
    ).toBe("1h");
    expect(formatAttentionExpiry(ATTENTION_FIXTURE_NOW_MS + 31_000, ATTENTION_FIXTURE_NOW_MS)).toBe(
      "Expires in 31s",
    );
    expect(formatAttentionExpiry(ATTENTION_FIXTURE_NOW_MS - 1, ATTENTION_FIXTURE_NOW_MS)).toBe(
      "Expired",
    );
  });

  it("refreshes live confirmation copy at most once per second and at its deadline", () => {
    const session = ATTENTION_INBOX_FIXTURES.mixed.items[0]!.session;
    const item: AttentionInboxItem = {
      kind: "confirmation",
      key: "confirmation-timer",
      requestId: "confirmation-timer",
      session,
      title: "Confirm",
      summary: "Confirm the action",
      occurredAtMs: ATTENTION_FIXTURE_NOW_MS,
      expiresAtMs: ATTENTION_FIXTURE_NOW_MS + 2_500,
      actionState: { status: "ready" },
    };
    expect(nextAttentionRefreshDelay([item], ATTENTION_FIXTURE_NOW_MS)).toBe(1_000);
    expect(nextAttentionRefreshDelay([item], ATTENTION_FIXTURE_NOW_MS + 2_400)).toBe(101);
    expect(nextAttentionRefreshDelay([item], ATTENTION_FIXTURE_NOW_MS + 2_500)).toBeNull();
  });

  it("finds the current route outcome marker without attaching the session", () => {
    const snapshot = {
      projection: {
        sessionIndex: new Map([
          [
            "host/one\u0000session one",
            {
              hostId: "host/one",
              sessionId: "session one",
              attention: {
                pending: [],
                pendingCount: 0,
                truncated: false,
                latestOutcome: {
                  id: "outcome-1",
                  kind: "completed",
                  at: "2026-07-18T18:00:00.000Z",
                  summary: "Completed.",
                },
              },
            },
          ],
        ]),
      },
    } as unknown as DesktopRuntimeSnapshot;
    const viewId = sessionViewId("host/one", "session one");
    expect(sessionAttentionOutcomeMarker(snapshot, viewId)).toEqual({
      sessionKey: "host/one\u0000session one",
      outcomeId: "outcome-1",
    });
  });
});

describe("attention inbox screen", () => {
  it("renders the three compact work-list sections and accessible view controls", () => {
    const fixture = ATTENTION_INBOX_FIXTURES.mixed;
    const markup = renderToStaticMarkup(
      <AttentionInboxScreen
        {...callbacks}
        inventory={fixture.inventory}
        items={fixture.items}
        nowMs={fixture.nowMs}
      />,
    );

    expect(markup).toContain("Attention inbox");
    expect(markup).toContain("Needs you");
    expect(markup).toContain("Problems");
    expect(markup).toContain("Done");
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('id="attention-inbox-tab-open"');
    expect(markup).toContain('id="attention-inbox-tab-seen"');
    expect(markup).toContain('aria-controls="attention-inbox-panel"');
    expect(markup).toContain('aria-labelledby="attention-inbox-tab-open"');
    expect(markup).toContain('id="attention-inbox-panel"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Mark all updates seen");
  });

  it("keeps action controls touch-sized and explains unavailable states with text", () => {
    const fixture = ATTENTION_INBOX_FIXTURES.offline;
    const markup = renderToStaticMarkup(
      <AttentionInboxScreen
        {...callbacks}
        inventory={fixture.inventory}
        items={fixture.items}
        nowMs={fixture.nowMs}
      />,
    );

    expect(markup).toContain("One or more hosts are offline");
    expect(markup).toContain("Reconnect to answer");
    expect(markup).toContain("Open session to refresh");
    expect(markup).toContain("Open session to respond");
    expect(markup).toContain("Expired");
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("disabled");
  });

  it("distinguishes a complete empty inbox from an incomplete inventory", () => {
    const completeMarkup = renderToStaticMarkup(
      <AttentionInboxScreen
        {...callbacks}
        inventory={{ status: "complete" }}
        items={[]}
        nowMs={ATTENTION_FIXTURE_NOW_MS}
      />,
    );
    const partialMarkup = renderToStaticMarkup(
      <AttentionInboxScreen
        {...callbacks}
        inventory={{ status: "partial" }}
        items={[]}
        nowMs={ATTENTION_FIXTURE_NOW_MS}
      />,
    );

    expect(completeMarkup).toContain("All caught up");
    expect(completeMarkup).not.toContain("may change when every host");
    expect(partialMarkup).toContain("Nothing is visible right now");
    expect(partialMarkup).toContain("may change when every host");
  });
});
