import {
  COMMAND_DESCRIPTORS,
  PROTOCOL_VERSION,
  decodeClientFrame,
  decodeServerFrame,
  requiredCapability,
  type ClientFrame,
  type CommandDescriptor,
  type DeviceCapability,
  type ServerFrame,
} from "@t4-code/protocol";

/**
 * The narrow protocol seam consumed by OmpClient. Transport, reconnect, replay,
 * and projection logic stay independent from the concrete app-wire decoder.
 */
export interface OmpProtocolProvider {
  readonly id: string;
  readonly protocolVersion: string;
  decodeClientFrame(input: unknown): ClientFrame;
  decodeServerFrame(input: unknown): ServerFrame;
  commandDescriptor(command: string): CommandDescriptor | undefined;
  requiredCapability(command: string): DeviceCapability | undefined;
}

/** Current canonical provider backed by the pinned @oh-my-pi/app-wire v1 artifact. */
export const ompAppV1ProtocolProvider: OmpProtocolProvider = Object.freeze({
  id: "omp-app-v1",
  protocolVersion: PROTOCOL_VERSION,
  decodeClientFrame,
  decodeServerFrame,
  commandDescriptor: (command: string) => COMMAND_DESCRIPTORS[command],
  requiredCapability,
});
