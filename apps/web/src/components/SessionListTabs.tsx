import { cn } from "@t4-code/ui";
import { useNavigate } from "@tanstack/react-router";

import type { SessionListView } from "../lib/workspace-data.ts";
import { getShellData } from "../state/shell-data.ts";
import { workspaceStore } from "../state/store-instance.ts";

export function SessionListTabs({
  archivedCount,
  currentCount,
  view,
}: {
  readonly archivedCount: number;
  readonly currentCount: number;
  readonly view: SessionListView;
}) {
  const navigate = useNavigate();
  return (
    <div
      aria-label="Session list"
      className="mt-2 grid grid-cols-2 gap-0.5 rounded-lg border border-border p-0.5"
      role="group"
    >
      {(["current", "archived"] as const).map((option) => {
        const count = option === "current" ? currentCount : archivedCount;
        return (
          <button
            aria-pressed={view === option}
            className={cn(
              "min-h-11 rounded-md px-2 font-medium text-xs outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7",
              view === option
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            key={option}
            onClick={() => {
              const data = getShellData();
              const state = workspaceStore.getState();
              state.setSessionListView(option);
              const activeVisible = data.sessions.some(
                (session) =>
                  session.id === state.activeSessionId &&
                  (option === "archived"
                    ? session.archivedAt !== undefined
                    : session.archivedAt === undefined),
              );
              if (activeVisible && state.activeSessionId !== null) {
                state.setRailOverlayOpen(false);
                void navigate({
                  params: { sessionId: state.activeSessionId },
                  to: "/sessions/$sessionId",
                });
                return;
              }
              const next = data.sessions.find((session) =>
                option === "archived"
                  ? session.archivedAt !== undefined
                  : session.archivedAt === undefined,
              );
              state.setRailOverlayOpen(false);
              if (next === undefined) void navigate({ to: "/" });
              else void navigate({ params: { sessionId: next.id }, to: "/sessions/$sessionId" });
            }}
            type="button"
          >
            {option === "current" ? "Current" : "Archived"} · {count}
          </button>
        );
      })}
    </div>
  );
}
