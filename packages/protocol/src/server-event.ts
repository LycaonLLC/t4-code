import type { ServerFrame } from "@oh-my-pi/app-wire";

type KnownFields<Value> = {
  [Key in keyof Value as string extends Key
    ? never
    : number extends Key
      ? never
      : symbol extends Key
        ? never
        : Key]: Value[Key];
};

type PreservedIndex<Value> = string extends keyof Value
  ? Readonly<Record<string, unknown>>
  : object;

export type OmpServerEventPayload<Frame extends ServerFrame> = Readonly<
  Omit<KnownFields<Frame>, "v" | "type"> & PreservedIndex<Frame>
>;

export type OmpServerEventFromFrame<Frame extends ServerFrame> =
  Frame extends ServerFrame
    ? Readonly<{
        kind: Frame["type"];
        payload: OmpServerEventPayload<Frame>;
      }>
    : never;

export type OmpDecodedServerEventFromFrame<Frame extends ServerFrame> =
  Frame extends ServerFrame
    ? Readonly<{
        kind: Frame["type"];
        payload: OmpServerEventPayload<Frame>;
        event: OmpServerEventFromFrame<Frame>;
        wireFrame: Frame;
      }>
    : never;

/** Stable, version-free event union shared by protocol providers and applications. */
export type OmpServerEvent = OmpServerEventFromFrame<ServerFrame>;

/** A decoded event paired with the validated wire frame used by legacy consumers. */
export type OmpDecodedServerEvent = OmpDecodedServerEventFromFrame<ServerFrame>;

/** Pairing credentials never cross application-facing event boundaries. */
export type PublicOmpServerEvent = Exclude<OmpServerEvent, { kind: "pair.ok" }>;

export function ompServerEventFromFrame<Frame extends ServerFrame>(
  frame: Frame,
): OmpServerEventFromFrame<Frame> {
  const { v: _version, type, ...payload } = frame;
  return Object.freeze({
    kind: type,
    payload: Object.freeze(payload),
  }) as OmpServerEventFromFrame<Frame>;
}

export function decodedOmpServerEventFromFrame<Frame extends ServerFrame>(
  wireFrame: Frame,
): OmpDecodedServerEventFromFrame<Frame> {
  const event = ompServerEventFromFrame(wireFrame);
  return Object.freeze({
    ...event,
    event,
    wireFrame,
  }) as OmpDecodedServerEventFromFrame<Frame>;
}
