/** `resolve` — apply or discard a pending preview/approval action. */
import type { ReactNode } from "react";
import { Badge, Badges, Kv, KvGrid, Note, ResultText } from "../parts.tsx";
import type { ToolRenderer, ToolRenderProps } from "../types.ts";
import { detailsRecord, isRecord, normalizeWs, str, truncate } from "../util.ts";

function actionFor(name: string, args: Record<string, unknown>): string | null {
  return str(args.action) ?? (name === "resolve" ? "apply" : name === "reject" ? "discard" : null);
}

function Summary({ name, args, result }: ToolRenderProps): ReactNode {
  const action = actionFor(name, args);
  const reason = str(args.reason);
  const tone = result?.isError ? "err" : action === "apply" ? "ok" : "warn";
  return (
    <>
      <Badge tone={tone}>{action ?? "?"}</Badge>{" "}
      {reason && <span>{truncate(normalizeWs(reason), 100)}</span>}
    </>
  );
}

function Body({ name, args, result }: ToolRenderProps): ReactNode {
  const action = actionFor(name, args);
  const reason = str(args.reason);
  const tone = result?.isError ? "err" : action === "apply" ? "ok" : "warn";
  const details = detailsRecord(result);
  const sourceToolName = details ? str(details.sourceToolName) : null;
  const label = details ? str(details.label) : null;
  const extra = isRecord(args.extra)
    ? args.extra
    : details && isRecord(details.extra)
      ? details.extra
      : null;
  const extraRows: ReactNode[] = [];
  if (extra) {
    for (const k in extra) {
      const v = extra[k];
      let text: string;
      if (typeof v === "string") text = v;
      else {
        try {
          text = JSON.stringify(v) ?? String(v);
        } catch {
          text = String(v);
        }
      }
      extraRows.push(
        <Kv key={k} k={k}>
          {truncate(normalizeWs(text), 200)}
        </Kv>,
      );
    }
  }
  return (
    <>
      <Badges
        items={[
          <Badge key="action" tone={tone}>
            {action === "apply"
              ? "proposed → resolved"
              : action === "discard"
                ? "proposed → rejected"
                : (action ?? "?")}
          </Badge>,
          sourceToolName && <Badge key="source">{sourceToolName}</Badge>,
          label && <span key="label">{truncate(normalizeWs(label), 120)}</span>,
        ]}
      />
      {reason && <Note>{reason}</Note>}
      {extraRows.length > 0 && <KvGrid>{extraRows}</KvGrid>}
      <ResultText result={result} maxLines={6} />
    </>
  );
}

export const resolveRenderer: ToolRenderer = { Summary, Body };
