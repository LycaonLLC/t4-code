// Immutable registry for the five optional session surfaces shown in the
// right workspace column. Preview and Browser remain focused routes, while
// the user's terminal drawer remains a separate surface below the columns.
import { Activity, Bot, FolderOpen, GitCompareArrows, SquareTerminal } from "lucide-react";
import type { ComponentType } from "react";

import type { SessionSurfaceId } from "../state/workspace-store.ts";

export interface SessionSurfaceMeta {
  readonly id: SessionSurfaceId;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  /** Honest empty-state copy for a session with nothing in this family. */
  readonly emptyTitle: string;
  readonly emptyDescription: string;
}

export const SESSION_SURFACES: readonly SessionSurfaceMeta[] = Object.freeze([
  Object.freeze({
    id: "agents",
    label: "Agents",
    icon: Bot,
    emptyTitle: "No agents running",
    emptyDescription:
      "When this session hands work to other agents, each one is listed here with its own status.",
  }),
  Object.freeze({
    id: "activity",
    label: "Activity",
    icon: Activity,
    emptyTitle: "Nothing recorded yet",
    emptyDescription:
      "Commands and tool runs from this session are listed here in order, newest last. This view is read-only.",
  }),
  Object.freeze({
    id: "review",
    label: "Review",
    icon: GitCompareArrows,
    emptyTitle: "Nothing to review",
    emptyDescription:
      "Edits this session makes show up here as diffs you can read before deciding what to keep.",
  }),
  Object.freeze({
    id: "files",
    label: "Files",
    icon: FolderOpen,
    emptyTitle: "No files touched",
    emptyDescription:
      "Files this session reads or edits collect here so you can open them without hunting.",
  }),
  Object.freeze({
    id: "terminals",
    label: "Terminals",
    icon: SquareTerminal,
    emptyTitle: "No terminals running",
    emptyDescription:
      "Shells this session opens are listed here, read-only. Your own terminal lives in the drawer at the bottom.",
  }),
]);

/** @deprecated Prefer the session-surface name for new code. */
export const PANE_FAMILY_META = SESSION_SURFACES;
