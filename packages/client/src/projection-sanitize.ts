import type { SessionRef } from "@t4-code/protocol";

export function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === undefined || value === null) return depth > 4 ? undefined : value;
  if (typeof value === "string") return value.slice(0, 8192);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return Object.freeze(
      value
        .slice(0, 128)
        .map((item) => safeValue(item, depth + 1))
        .filter((item) => item !== undefined),
    );
  }
  if (typeof value !== "object") return undefined;
  const output: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>).slice(0, 128)) {
    if (/token|secret|password|credential|authorization|endpoint|stack/i.test(name)) continue;
    const safe = safeValue(item, depth + 1);
    if (safe !== undefined) output[name] = safe;
  }
  return Object.freeze(output);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function boundedIdentity(value: unknown): string | undefined {
  // eslint-disable-next-line no-control-regex -- preserve intentional control-character redaction.
  const hasControlCharacter = typeof value === "string" && /[\u0000-\u001f\u007f]/u.test(value);
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    hasControlCharacter
  ) {
    return undefined;
  }
  return value;
}

export function sanitizeSessionRef(value: unknown): SessionRef | undefined {
  const safe = safeValue(value);
  if (!isRecord(safe)) return undefined;
  const hostId = boundedIdentity(safe.hostId);
  const sessionId = boundedIdentity(safe.sessionId);
  const project = isRecord(safe.project) ? safe.project : undefined;
  const projectId = boundedIdentity(project?.projectId);
  const revision = boundedIdentity(safe.revision);
  const title = typeof safe.title === "string" ? safe.title : undefined;
  const status = typeof safe.status === "string" ? safe.status : undefined;
  const updatedAt = typeof safe.updatedAt === "string" ? safe.updatedAt : undefined;
  if (
    hostId === undefined ||
    sessionId === undefined ||
    projectId === undefined ||
    revision === undefined ||
    title === undefined ||
    status === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    ...safe,
    hostId: hostId as SessionRef["hostId"],
    sessionId: sessionId as SessionRef["sessionId"],
    project: Object.freeze({
      ...project,
      projectId: projectId as SessionRef["project"]["projectId"],
    }),
    revision: revision as SessionRef["revision"],
    title,
    status,
    updatedAt,
  }) as SessionRef;
}

export function sameSafeValue(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (
    depth > 5 ||
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => sameSafeValue(item, right[index], depth + 1));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (name) =>
        Object.prototype.hasOwnProperty.call(right, name) &&
        sameSafeValue(left[name], right[name], depth + 1),
    )
  );
}
