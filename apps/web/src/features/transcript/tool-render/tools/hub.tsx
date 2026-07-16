/** `hub` — v17's unified peer messaging, async-job, and process surface. */
import type { ComponentType, ReactNode } from "react";
import { genericRenderer } from "../generic.tsx";
import { Badge, Badges, Note, Output, ResultText } from "../parts.tsx";
import type { ToolRenderer, ToolRenderProps } from "../types.ts";
import { detailsRecord, display, str } from "../util.ts";
import { ircRenderer } from "./irc.tsx";
import { jobRenderer } from "./job.tsx";

type HubMode = "messaging" | "jobs" | "process" | "fallback";

const PROCESS_OPS = new Set(["start", "ps", "logs", "stop", "restart", "describe"]);

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function resultMode(result: ToolRenderProps["result"]): HubMode | null {
  const details = detailsRecord(result);
  if (!details) return null;
  if (
    ["daemon", "daemons", "terminalRows", "spec", "state", "cursor"].some((key) =>
      hasOwn(details, key),
    )
  ) {
    return "process";
  }
  if (["jobs", "agents", "cancelled"].some((key) => hasOwn(details, key))) return "jobs";
  if (["receipts", "waited", "inbox", "peers"].some((key) => hasOwn(details, key))) {
    return "messaging";
  }
  return null;
}

function modeOf(args: Record<string, unknown>, result: ToolRenderProps["result"]): HubMode {
  const settledMode = resultMode(result);
  if (settledMode) return settledMode;
  const op = str(args.op);
  if (!op) return "fallback";
  const name = str(args.name);
  if (PROCESS_OPS.has(op) || ((op === "send" || op === "wait") && name && !args.to && !args.from)) {
    return "process";
  }
  if (op === "jobs" || op === "cancel") return "jobs";
  if (op === "wait") {
    const ids = Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === "string") : [];
    return ids.length > 0 || (!args.from && !args.name) ? "jobs" : "messaging";
  }
  return op === "send" || op === "inbox" || op === "list" ? "messaging" : "fallback";
}

function jobArgs(args: Record<string, unknown>): Record<string, unknown> {
  const ids = Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === "string") : [];
  switch (args.op) {
    case "jobs":
      return { list: true };
    case "cancel":
      return { cancel: ids };
    case "wait":
      return ids.length > 0 ? { poll: ids } : {};
    default:
      return args;
  }
}

function delegatedProps(props: ToolRenderProps, args: Record<string, unknown>): ToolRenderProps {
  return { ...props, args };
}

function renderComponent(
  Component: ComponentType<ToolRenderProps> | undefined,
  props: ToolRenderProps,
): ReactNode {
  return Component ? <Component {...props} /> : null;
}

function ProcessSummary({ args, result }: ToolRenderProps): ReactNode {
  const op = str(args.op) ?? "process";
  const name = str(args.name);
  return (
    <>
      <Badge
        tone={result?.isError ? "err" : op === "start" || op === "restart" ? "accent" : undefined}
      >
        {op}
      </Badge>{" "}
      {name && <span className="tv-pattern">{name}</span>}
      {!name && str(args.application) && <span className="tv-muted">{str(args.application)}</span>}
    </>
  );
}

function ProcessBody({ args, result }: ToolRenderProps): ReactNode {
  const op = str(args.op) ?? "process";
  const name = str(args.name);
  const application = str(args.application);
  const argv = Array.isArray(args.args) ? args.args.filter((item) => typeof item === "string") : [];
  const details = detailsRecord(result);
  let detailText = "";
  if (details) {
    try {
      detailText = JSON.stringify(details, null, 2) ?? "";
    } catch {
      detailText = display(details);
    }
  }
  return (
    <>
      <Badges
        items={[op, name && `process ${name}`, str(args.cwd), args.follow === true && "follow"]}
      />
      {application && <Note>{[application, ...argv].join(" ")}</Note>}
      {detailText && <Output text={detailText} lang="json" maxLines={12} title="process" />}
      <ResultText result={result} maxLines={12} />
    </>
  );
}

function Summary(props: ToolRenderProps): ReactNode {
  switch (modeOf(props.args, props.result)) {
    case "messaging":
      return renderComponent(ircRenderer.Summary, props);
    case "jobs":
      return renderComponent(jobRenderer.Summary, delegatedProps(props, jobArgs(props.args)));
    case "process":
      return <ProcessSummary {...props} />;
    default:
      return renderComponent(genericRenderer.Summary, props);
  }
}

function Body(props: ToolRenderProps): ReactNode {
  switch (modeOf(props.args, props.result)) {
    case "messaging":
      return renderComponent(ircRenderer.Body, props);
    case "jobs":
      return renderComponent(jobRenderer.Body, delegatedProps(props, jobArgs(props.args)));
    case "process":
      return <ProcessBody {...props} />;
    default:
      return renderComponent(genericRenderer.Body, props);
  }
}

export const hubRenderer: ToolRenderer = { Summary, Body };
