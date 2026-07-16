/** `propose` — submit a plan title for approval. */
import type { ReactNode } from "react";
import { Badge, InvalidArg, Note, ResultText } from "../parts.tsx";
import type { ToolRenderer, ToolRenderProps } from "../types.ts";
import { normalizeWs, str, truncate } from "../util.ts";

function Summary({ args, result }: ToolRenderProps): ReactNode {
  const title = str(args.title);
  return (
    <>
      <Badge tone={result?.isError ? "err" : "accent"}>plan</Badge>{" "}
      {title === null ? <InvalidArg what="title" /> : truncate(normalizeWs(title), 100)}
    </>
  );
}

function Body({ args, result }: ToolRenderProps): ReactNode {
  const title = str(args.title);
  return (
    <>
      {title !== null && <Note>{title}</Note>}
      <ResultText result={result} maxLines={6} />
    </>
  );
}

export const proposeRenderer: ToolRenderer = { Summary, Body };
