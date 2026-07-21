import { IconButton } from "@t4-code/ui";
import { FileCode2, Layers3, X } from "lucide-react";

import type { ContextPacketItem } from "./context-packet.ts";

export function ContextPacketChips({
  items,
  deferredReason,
  onRemove,
}: {
  readonly items: readonly ContextPacketItem[];
  readonly deferredReason: string | null;
  readonly onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="border-input border-b px-3 pt-2.5 pb-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground text-xs">
        <Layers3 aria-hidden="true" className="size-3.5" />
        <span>Context for the next new message</span>
        <span aria-hidden="true">·</span>
        <span>{items.length}</span>
      </div>
      <ul aria-label="Context for the next new message" className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li
            className="group flex h-7 max-w-full items-center gap-1.5 rounded-md border border-input bg-background px-1.5 text-xs"
            key={item.id}
          >
            <FileCode2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            <details className="relative min-w-0">
              <summary
                className="max-w-48 cursor-pointer truncate font-mono"
                title={item.source.path}
              >
                {item.label}
              </summary>
              <div className="absolute bottom-full start-0 z-30 mb-2 max-h-64 w-[min(34rem,calc(100vw-3rem))] overflow-auto rounded-lg border border-border bg-popover p-3 shadow-(--overlay-shadow)">
                <p className="mb-2 font-mono text-muted-foreground text-xs">{item.source.path}</p>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs">{item.body}</pre>
              </div>
            </details>
            {(item.redacted || item.truncated) && (
              <span
                className="text-muted-foreground"
                title="Sensitive values may be redacted and long excerpts are shortened"
              >
                {item.redacted ? "redacted" : "shortened"}
              </span>
            )}
            <IconButton
              aria-label={`Remove context ${item.source.path}`}
              className="size-5"
              onClick={() => onRemove(item.id)}
              size="icon-xs"
            >
              <X className="size-3" />
            </IconButton>
          </li>
        ))}
      </ul>
      {deferredReason !== null && (
        <p className="mt-1.5 text-muted-foreground text-xs">{deferredReason}</p>
      )}
    </div>
  );
}
