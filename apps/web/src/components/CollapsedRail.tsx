import {
  cn,
  IconButton,
  STATUS_PILLS,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@t4-code/ui";

import type { ProjectGroup } from "../lib/session-tree.ts";

/** 48px icon strip: one identity square per project, tooltip-labeled. */
export function CollapsedRail({
  groups,
  onExpand,
}: {
  groups: readonly ProjectGroup[];
  onExpand: (projectId: string) => void;
}) {
  return (
    <nav
      aria-label="Working folders (collapsed list)"
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-border border-r bg-background py-2"
    >
      {groups.map((group) => (
        <Tooltip key={group.project.id}>
          <TooltipTrigger
            render={
              <IconButton
                aria-label={`Show sessions in ${group.project.name}`}
                className="relative"
                onClick={() => onExpand(group.project.id)}
                size="icon-sm"
              >
                <span aria-hidden="true" className="font-medium text-xs">
                  {group.project.name.slice(0, 2)}
                </span>
                {(group.groupStatus !== null || group.unreadCount > 0) && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute top-0.5 right-0.5 size-1.5 rounded-full",
                      group.groupStatus !== null
                        ? STATUS_PILLS[group.groupStatus].dotClass
                        : "bg-brand",
                    )}
                  />
                )}
              </IconButton>
            }
          />
          <TooltipPopup side="right">
            {group.project.name}
            {group.unreadCount > 0 ? ` · ${group.unreadCount} unread` : ""}
          </TooltipPopup>
        </Tooltip>
      ))}
    </nav>
  );
}
