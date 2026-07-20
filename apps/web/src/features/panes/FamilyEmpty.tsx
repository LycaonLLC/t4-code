// Honest per-family empty state, reusing the shell's fixed copy so the
// closed-pane promise and the open-pane reality never drift apart.
import { cn, Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@t4-code/ui";

import { SESSION_SURFACES } from "../../components/pane-families.tsx";
import type { PaneFamily } from "../../state/workspace-store.ts";

export function FamilyEmpty({
  family,
  className,
}: {
  readonly family: PaneFamily;
  readonly className?: string | undefined;
}) {
  const meta = SESSION_SURFACES.find((entry) => entry.id === family);
  if (meta === undefined) return null;
  return (
    <Empty className={cn("border-0", className ?? "h-full")}>
      <EmptyHeader>
        <EmptyTitle className="text-base">{meta.emptyTitle}</EmptyTitle>
        <EmptyDescription>{meta.emptyDescription}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
