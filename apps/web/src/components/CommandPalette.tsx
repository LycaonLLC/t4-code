// Command palette: search sessions and shell actions from one field.
// Cmd/Ctrl+K opens it; arrows move, Enter runs, Escape closes and restores
// focus (dialog primitive owns the focus contract).
import { cn, Dialog, DialogPopup, StatusPill } from "@t4-code/ui";
import { CornerDownLeft, Search, SquareTerminal } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { buildQuickOpenItems, type ActionRegistry, type QuickOpenItem } from "../actions/index.ts";
import { flattenFileIndex, type FileRefEntry } from "../features/composer/file-refs.ts";
import { getInspectorStore, type FileChildren } from "../features/panes/inspector-store.ts";
import type { ProjectGroup } from "../lib/session-tree.ts";
import { useWorkspace, workspaceStore } from "../state/store-instance.ts";
import { SESSION_SURFACES } from "./pane-families.tsx";

const GROUP_LABEL = {
  recent: "Recent work",
  files: "Files in this session",
  workspace: "Workspace",
  navigate: "Navigate",
  app: "App",
} as const;

const EMPTY_FILE_CHILDREN: Readonly<Record<string, FileChildren>> = Object.freeze({});
const EMPTY_FILE_ENTRIES: readonly FileRefEntry[] = Object.freeze([]);

function ItemStatus({ item }: { readonly item: QuickOpenItem }) {
  if (item.status === null) return null;
  if (item.status.kind === "session") {
    return <StatusPill labelHidden status={item.status.status} />;
  }
  if (item.status.icon === "search") {
    return <Search aria-hidden="true" className="size-3.5 text-muted-foreground" />;
  }
  if (item.status.icon === "terminal") {
    return <SquareTerminal aria-hidden="true" className="size-3.5 text-muted-foreground" />;
  }
  const icon = item.status.icon;
  const meta = SESSION_SURFACES.find((surface) => surface.id === icon);
  if (meta === undefined) return null;
  const Icon = meta.icon;
  return <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />;
}

export function CommandPalette({
  groups,
  registry,
}: {
  readonly groups: readonly ProjectGroup[];
  readonly registry: ActionRegistry;
}) {
  const open = useWorkspace((state) => state.paletteOpen);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const inspector = activeSessionId === null ? null : getInspectorStore(activeSessionId);
  const fileChildren = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => inspector?.subscribe(onStoreChange) ?? (() => {}),
      [inspector],
    ),
    useCallback(
      () => inspector?.getState().files.childrenByPath ?? EMPTY_FILE_CHILDREN,
      [inspector],
    ),
  );
  const activeSessionFiles = useMemo(
    () => (activeSessionId === null ? EMPTY_FILE_ENTRIES : flattenFileIndex(fileChildren)),
    [activeSessionId, fileChildren],
  );
  const filtered = useMemo(
    () => buildQuickOpenItems(query, { registry, groups, activeSessionFiles }),
    [activeSessionFiles, groups, query, registry],
  );
  const needle = query.trim().toLowerCase();
  const activeIndex = Math.min(highlighted, Math.max(0, filtered.length - 1));

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
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    setHighlighted((index) => Math.min(index, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const runItem = (item: QuickOpenItem | undefined) => {
    if (item === undefined) return;
    const result = registry.execute(item.invocation);
    if (result.executed) workspaceStore.getState().setPaletteOpen(false);
  };

  return (
    <Dialog onOpenChange={(next) => workspaceStore.getState().setPaletteOpen(next)} open={open}>
      <DialogPopup
        aria-label="Search sessions, transcripts, and commands"
        className="w-full max-w-lg overflow-hidden p-0"
        showCloseButton={false}
      >
        <div className="relative border-border border-b">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            aria-activedescendant={filtered.length > 0 ? `palette-item-${activeIndex}` : undefined}
            aria-controls="palette-results"
            aria-expanded="true"
            autoFocus
            className="h-12 w-full bg-transparent pe-4 ps-10 text-foreground text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlighted((index) => Math.min(index + 1, Math.max(0, filtered.length - 1)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlighted((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                runItem(filtered[activeIndex]);
              }
            }}
            placeholder="Search sessions, transcripts, and commands"
            role="combobox"
            type="text"
            value={query}
          />
        </div>
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
            const disabled = item.availability.status === "disabled";
            return (
              <Fragment key={item.key}>
                {startsGroup && (
                  <li
                    className="px-2.5 pt-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider first:pt-1"
                    role="presentation"
                  >
                    {GROUP_LABEL[item.group]}
                  </li>
                )}
                <li
                  aria-disabled={disabled || undefined}
                  aria-selected={index === activeIndex}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2",
                    index === activeIndex && "bg-secondary ring-1 ring-border/60",
                    disabled && "cursor-default opacity-60",
                  )}
                  data-index={index}
                  id={`palette-item-${index}`}
                  onClick={() => runItem(item)}
                  onMouseMove={() => setHighlighted(index)}
                  role="option"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {disabled ? item.availability.reason : item.subtitle}
                  </span>
                  <ItemStatus item={item} />
                  {index === activeIndex && !disabled && (
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
        <div
          aria-label="Command menu keyboard help"
          className="flex min-h-9 items-center gap-3 border-border border-t px-3 text-[10px] text-muted-foreground"
        >
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-foreground/80">↑↓</kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-foreground/80">↵</kbd>
            Open
          </span>
          <span className="ml-auto flex items-center gap-1">
            <kbd className="font-mono text-foreground/80">Esc</kbd>
            Close
          </span>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
