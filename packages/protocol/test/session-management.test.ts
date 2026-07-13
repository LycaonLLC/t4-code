import { describe, expect, it } from "vite-plus/test";

import {
  COMMAND_DESCRIPTORS,
  decodeClientFrame,
  decodeServerFrame,
} from "../src/index.ts";

const baseCommand = {
  v: "omp-app/1",
  type: "command",
  requestId: "request-1",
  commandId: "command-1",
  hostId: "host-1",
  sessionId: "session-1",
  expectedRevision: "revision-1",
  args: {},
} as const;

describe("canonical app-wire session management", () => {
  it.each([
    ["session.archive", "archived"],
    ["session.restore", "restored"],
    ["session.delete", "deleted"],
  ] as const)("strictly decodes %s commands and results", (command, resultKey) => {
    expect(decodeClientFrame({ ...baseCommand, command })).toMatchObject({
      type: "command",
      command,
      expectedRevision: "revision-1",
      args: {},
    });
    expect(
      decodeServerFrame({
        v: "omp-app/1",
        type: "response",
        requestId: "request-1",
        commandId: "command-1",
        command,
        hostId: "host-1",
        sessionId: "session-1",
        ok: true,
        result: { [resultKey]: true },
      }),
    ).toMatchObject({ type: "response", command, ok: true, result: { [resultKey]: true } });
  });

  it("requires revision, exact empty args, and exact boolean result shapes", () => {
    for (const invalid of [
      { ...baseCommand, command: "session.archive", expectedRevision: undefined },
      { ...baseCommand, command: "session.restore", args: { force: true } },
    ]) {
      expect(() => decodeClientFrame(invalid)).toThrow();
    }
    expect(
      decodeServerFrame({
        v: "omp-app/1",
        type: "response",
        requestId: "request-1",
        commandId: "command-1",
        command: "session.archive",
        hostId: "host-1",
        sessionId: "session-1",
        ok: true,
        result: { archived: false },
      }),
    ).toMatchObject({ ok: true, result: { archived: false } });
    for (const result of [{ archived: true, extra: true }, {}]) {
      expect(() =>
        decodeServerFrame({
          v: "omp-app/1",
          type: "response",
          requestId: "request-1",
          commandId: "command-1",
          command: "session.archive",
          hostId: "host-1",
          sessionId: "session-1",
          ok: true,
          result,
        }),
      ).toThrow();
    }
  });

  it("describes delete as challenged while archive and restore are unchallenged", () => {
    expect(COMMAND_DESCRIPTORS["session.archive"]).toMatchObject({
      capability: "sessions.manage",
      revision: "required",
      confirmation: "none",
    });
    expect(COMMAND_DESCRIPTORS["session.restore"]?.confirmation).toBe("none");
    expect(COMMAND_DESCRIPTORS["session.delete"]?.confirmation).toBe("challenge");
  });
});
