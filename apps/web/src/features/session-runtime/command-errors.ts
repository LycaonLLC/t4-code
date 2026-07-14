import type { CommandResultError } from "@t4-code/protocol/desktop-ipc";

export type CommandFailureKind =
  | "busy"
  | "stale"
  | "closed"
  | "runtime"
  | "outcome-unknown"
  | "rejected";

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replaceAll("-", "_");
}

/** Classify bounded host errors without exposing arbitrary host copy in the UI. */
export function commandFailureKind(error: CommandResultError | undefined): CommandFailureKind {
  const code = normalized(error?.code);
  const message = normalized(error?.message);
  // Outcome uncertainty is authoritative even when the diagnostic also names
  // a runtime failure. The user must inspect the transcript before resending.
  if (code === "outcome_unknown") return "outcome-unknown";
  if (["session_busy", "agent_busy", "busy"].includes(code)) return "busy";
  if (["stale_revision", "revision_conflict", "stale"].includes(code)) return "stale";
  if (
    ["unknown_session", "session_closed", "closed_session"].includes(code) ||
    /session (?:is )?closed|session is not indexed|unknown session/u.test(message)
  ) {
    return "closed";
  }
  if (
    ["child_error", "child_failure", "rpc_child_error", "rpc_child_failure"].includes(code) ||
    /rpc child|child (?:failed|exited|ended)|oversized.*agent_end|agent_end.*oversized/u.test(
      message,
    )
  ) {
    return "runtime";
  }
  return "rejected";
}

export function promptRejectionReason(error: CommandResultError | undefined): string {
  switch (commandFailureKind(error)) {
    case "busy":
      return "This session is still handling the previous turn. Your draft is safe; wait for the session to become idle, then send it again.";
    case "stale":
      return "The session changed before the host could accept this message. Your draft is safe; wait for the session to refresh, then send it again.";
    case "closed":
      return "This session is closed on the host, so it cannot accept another message. Your draft is safe; start a new session before sending it.";
    case "runtime":
      return "The session runtime failed before it could accept this message. Your draft is safe; check the transcript, then terminate the runtime if it still appears active.";
    case "outcome-unknown":
      return "The host could not confirm whether this message was accepted. Your draft is safe; check the transcript before sending again to avoid a duplicate.";
    case "rejected":
      return "The host did not accept this message. Your draft is safe; check the session state and try again.";
  }
}

export function sessionActionRejectionReason(
  error: CommandResultError | undefined,
  action: "manage" | "terminate" = "manage",
): string {
  switch (commandFailureKind(error)) {
    case "busy":
      return action === "terminate"
        ? "The host could not terminate the runtime while its state was changing. Refresh the session list and try again."
        : "The host still reports active work. Terminate the session runtime before archiving or deleting it.";
    case "stale":
      return "The session changed before the host could complete this action. Refresh the session list and try again.";
    case "closed":
      return "This session is already closed or no longer indexed on the host. Refresh the session list before trying another action.";
    case "runtime":
      return action === "terminate"
        ? "The session runtime failed while termination was in progress. Refresh the session list before trying again."
        : "The session runtime failed while handling this action. Refresh the session list before trying again.";
    case "outcome-unknown":
      return action === "terminate"
        ? "The host could not confirm whether runtime termination completed. Refresh the session list before trying again."
        : "The host could not confirm whether this action completed. Refresh the session list before trying again.";
    case "rejected":
      return action === "terminate"
        ? "The host did not accept runtime termination."
        : "The host did not accept this session action.";
  }
}
