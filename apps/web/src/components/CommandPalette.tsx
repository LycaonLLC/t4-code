// Command palette: search sessions and shell actions from one field.
// Cmd/Ctrl+K opens it; arrows move, Enter runs, Escape closes and restores
// focus (dialog primitive owns the focus contract).
import { cn, Dialog, DialogPopup, StatusPill } from "@t4-code/ui";
import { useNavigate } from "@tanstack/react-router";
import { CornerDownLeft } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import type { ProjectGroup } from "../lib/session-tree.ts";
import { useWorkspace, workspaceStore } from "../state/store-instance.ts";
import { resolveTheme } from "../theme/theme.ts";
interface PaletteItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly status: ReactNode;
  readonly run: () => void;
}

function buildItems(
  groups: readonly ProjectGroup[],
  navigate: (sessionId: string) => void,
  openAgentView: () => void,
  openSettings: () => void,
): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const group of groups) {
    for (const row of group.sessions) {
      items.push({
        id: `session:${row.session.id}`,
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
  items.push(
    {
      id: "action:theme",
      label:
        resolveTheme(state.theme) === "dark" ? "Switch to light colors" : "Switch to dark colors",
      hint: "Appearance",
      status: null,
      run: () => {
        const current = resolveTheme(workspaceStore.getState().theme);
        workspaceStore.getState().setTheme(current === "dark" ? "light" : "dark");
      },
    },
    {
      id: "action:rail",
      label: state.railCollapsed ? "Show session list" : "Hide session list",
      hint: "Layout",
      status: null,
      run: () => workspaceStore.getState().setRailCollapsed(!state.railCollapsed),
    },
    {
      id: "action:agents",
      label: "Open Agent View",
      hint: "Agents",
      status: null,
      run: openAgentView,
    },
    {
      id: "action:settings",
      label: "Open settings",
      hint: "App",
      status: null,
      run: openSettings,
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
          void navigate({ to: "/agents" });
        },
        () => {
          void navigate({ to: "/settings" });
        },
      ),
    [groups, navigate, open],
  );

  const needle = query.trim().toLowerCase();
  const filtered =
    needle === ""
      ? items
      : items.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(needle));

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
        aria-label="Search sessions and commands"
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
          placeholder="Search sessions and commands"
          role="combobox"
          type="text"
          value={query}
        />
        <ul
          aria-label="Results"
          className="max-h-80 overflow-y-auto p-1.5"
          id="palette-results"
          ref={listRef}
          role="listbox"
        >
          {filtered.length === 0 && (
            <li className="px-2.5 py-6 text-center text-muted-foreground text-sm">
              Nothing matches "{query}". Try a session title or project name.
            </li>
          )}
          {filtered.map((item, index) => (
            <li
              aria-selected={index === highlighted}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2",
                index === highlighted && "bg-secondary",
              )}
              data-index={index}
              id={`palette-item-${index}`}
              key={item.id}
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
          ))}
        </ul>
      </DialogPopup>
    </Dialog>
  );
}
