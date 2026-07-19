// Command palette: search sessions and shell actions from one field.
// Cmd/Ctrl+K opens it; arrows move, Enter runs, Escape closes and restores
// focus (dialog primitive owns the focus contract).
import { cn, Dialog, DialogPopup, StatusPill } from "@t4-code/ui";
import { useNavigate } from "@tanstack/react-router";
import { CornerDownLeft, Search, SquareTerminal } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import type { ProjectGroup } from "../lib/session-tree.ts";
import { handoffTranscriptSearchQuery } from "../features/transcript-search/index.ts";
import { TRANSCRIPT_SEARCH_ROUTE } from "../features/transcript-search/route.ts";
import { useWorkspace, workspaceStore } from "../state/store-instance.ts";
import { selectSessionView } from "../state/workspace-store.ts";
import { resolveTheme } from "../theme/theme.ts";
import { PANE_FAMILY_META } from "./pane-families.tsx";
interface PaletteItem {
  readonly id: string;
  readonly group: "recent" | "workspace" | "navigate" | "app";
  readonly label: string;
  readonly hint: string;
  readonly status: ReactNode;
  readonly run: () => void;
}

const GROUP_LABEL = {
  recent: "Recent work",
  workspace: "Workspace",
  navigate: "Navigate",
  app: "App",
} as const;

const DEFAULT_RECENT_LIMIT = 5;

function buildItems(
  groups: readonly ProjectGroup[],
  navigate: (sessionId: string) => void,
  openInbox: () => void,
  openTranscriptSearch: (query: string) => void,
  openAgentView: () => void,
  openSettings: () => void,
): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const group of groups) {
    for (const row of group.sessions) {
      items.push({
        id: `session:${row.session.id}`,
        group: "recent",
        label: row.session.title,
        hint: `${group.project.name} · ${row.session.model}`,
        status:
          row.session.status !== null ? (
            <StatusPill labelHidden status={row.session.status} />
          ) : null,
        run: () => navigate(row.session.id),
      });
    }
  }
  const state = workspaceStore.getState();
  const activeSessionId = state.activeSessionId;
  const activeSessionVisible =
    activeSessionId !== null &&
    groups.some((group) => group.sessions.some((row) => row.session.id === activeSessionId));
  if (activeSessionId !== null && activeSessionVisible) {
    const view = selectSessionView(state, activeSessionId);
    for (const meta of PANE_FAMILY_META) {
      const active = view.paneOpen && view.paneFamily === meta.id;
      const Icon = meta.icon;
      const label = meta.id === "terminals" ? "Agent terminals" : meta.label;
      items.push({
        id: `action:pane:${meta.id}`,
        group: "workspace",
        label: active ? `Close ${label}` : `Open ${label}`,
        hint: "Workspace · Right",
        status: <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />,
        run: () => workspaceStore.getState().togglePaneFamily(activeSessionId, meta.id),
      });
    }
    items.push({
      id: "action:terminal",
      group: "workspace",
      label: view.terminalDrawerOpen ? "Close terminal" : "Open terminal",
      hint: "Workspace · Below · ⌘J",
      status: <SquareTerminal aria-hidden="true" className="size-3.5 text-muted-foreground" />,
      run: () => {
        const current = workspaceStore.getState();
        const currentView = selectSessionView(current, activeSessionId);
        current.setTerminalDrawerOpen(activeSessionId, !currentView.terminalDrawerOpen);
      },
    });
  }
  items.push(
    {
      id: "action:rail",
      group: "workspace",
      label: state.railCollapsed ? "Show session list" : "Hide session list",
      hint: "Sidebar",
      status: null,
      run: () => workspaceStore.getState().setRailCollapsed(!state.railCollapsed),
    },
    {
      id: "action:inbox",
      group: "navigate",
      label: "Open Inbox",
      hint: "Attention across sessions",
      status: null,
      run: openInbox,
    },
    {
      id: "action:transcript-search",
      group: "navigate",
      label: "Open transcript search",
      hint: "Prior decisions and code discussions",
      status: <Search aria-hidden="true" className="size-3.5 text-muted-foreground" />,
      run: () => openTranscriptSearch(""),
    },
    {
      id: "action:agents",
      group: "navigate",
      label: "Open Agent View",
      hint: "Agents",
      status: null,
      run: openAgentView,
    },
    {
      id: "action:settings",
      group: "app",
      label: "Open settings",
      hint: "Preferences",
      status: null,
      run: openSettings,
    },
    {
      id: "action:theme",
      group: "app",
      label:
        resolveTheme(state.theme) === "dark" ? "Switch to light colors" : "Switch to dark colors",
      hint: "Appearance",
      status: null,
      run: () => {
        const current = resolveTheme(workspaceStore.getState().theme);
        workspaceStore.getState().setTheme(current === "dark" ? "light" : "dark");
      },
    },
  );
  return items;
}

export function CommandPalette({ groups }: { groups: readonly ProjectGroup[] }) {
  const open = useWorkspace((state) => state.paletteOpen);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);

  const items = useMemo(
    () =>
      buildItems(
        groups,
        (sessionId) => {
          void navigate({ params: { sessionId }, to: "/sessions/$sessionId" });
        },
        () => {
          void navigate({ to: "/inbox" });
        },
        (searchQuery) => {
          handoffTranscriptSearchQuery(searchQuery);
          void navigate({ to: TRANSCRIPT_SEARCH_ROUTE });
        },
        () => {
          void navigate({ to: "/agents" });
        },
        () => {
          void navigate({ to: "/settings" });
        },
      ),
    [groups, navigate, open],
  );

  const needle = query.trim().toLowerCase();
  const defaultRecentIds = new Set(
    items
      .filter((item) => item.group === "recent")
      .slice(0, DEFAULT_RECENT_LIMIT)
      .map((item) => item.id),
  );
  const baseFiltered =
    needle === ""
      ? items.filter((item) => item.group !== "recent" || defaultRecentIds.has(item.id))
      : items.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(needle));
  const filtered =
    needle.length < 2
      ? baseFiltered
      : [
          ...baseFiltered,
          {
            id: "action:transcript-search-query",
            group: "navigate" as const,
            label: "View all transcript results",
            hint: `Search for “${query.trim()}”`,
            status: <Search aria-hidden="true" className="size-3.5 text-muted-foreground" />,
            run: () => {
              handoffTranscriptSearchQuery(query.trim());
              void navigate({ to: TRANSCRIPT_SEARCH_ROUTE });
            },
          },
        ];

  useEffect(() => {
    setHighlighted(0);
  }, [needle]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setHighlighted(0);
    }
  }, [open]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const runItem = (item: PaletteItem | undefined) => {
    if (item === undefined) return;
    workspaceStore.getState().setPaletteOpen(false);
    item.run();
  };

  return (
    <Dialog onOpenChange={(next) => workspaceStore.getState().setPaletteOpen(next)} open={open}>
      <DialogPopup
        aria-label="Search sessions, transcripts, and commands"
        className="w-full max-w-lg overflow-hidden p-0"
        showCloseButton={false}
      >
        <input
          aria-activedescendant={filtered.length > 0 ? `palette-item-${highlighted}` : undefined}
          aria-controls="palette-results"
          aria-expanded="true"
          autoFocus
          className="h-11 w-full border-border border-b bg-transparent px-4 text-foreground text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlighted((index) => Math.min(index + 1, filtered.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlighted((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              runItem(filtered[highlighted]);
            }
          }}
          placeholder="Search sessions, transcripts, and commands"
          role="combobox"
          type="text"
          value={query}
        />
        <ul
          aria-label="Results"
          className="max-h-[min(34rem,calc(100dvh-8rem))] overflow-y-auto p-1.5"
          id="palette-results"
          ref={listRef}
          role="listbox"
        >
          {filtered.length === 0 && (
            <li className="px-2.5 py-6 text-center text-muted-foreground text-sm">
              Nothing matches "{query}". Try a session title, project, or transcript phrase.
            </li>
          )}
          {filtered.map((item, index) => {
            const startsGroup = index === 0 || filtered[index - 1]?.group !== item.group;
            return (
              <Fragment key={item.id}>
                {startsGroup && (
                  <li
                    className="px-2.5 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider first:pt-1"
                    role="presentation"
                  >
                    {GROUP_LABEL[item.group]}
                  </li>
                )}
                <li
                  aria-selected={index === highlighted}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2",
                    index === highlighted && "bg-secondary",
                  )}
                  data-index={index}
                  id={`palette-item-${index}`}
                  onClick={() => runItem(item)}
                  onMouseMove={() => setHighlighted(index)}
                  role="option"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">{item.hint}</span>
                  {item.status}
                  {index === highlighted && (
                    <CornerDownLeft
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                </li>
              </Fragment>
            );
          })}
        </ul>
      </DialogPopup>
    </Dialog>
  );
}
