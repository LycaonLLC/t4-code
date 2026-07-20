import {
	type Capabilities,
	decodeCapabilities,
	decodeFeatureList,
	decodeNegotiatedFeatureList,
} from "./capabilities.js";
import { type Cursor, decodeCursor } from "./cursor.js";
import { fail } from "./errors.js";
import {
	boundedArray,
	boundedMap,
	controlFree,
	type DeviceAuthentication,
	decodeAuthentication,
	inputObject,
} from "./guards.js";
import { type HostId, hostId, type SessionId, sessionId } from "./ids.js";
import { MAX_SAVED_CURSORS, PROTOCOL_VERSION } from "./limits.js";
export interface ProtocolRange {
	min: string;
	max: string;
}
export interface ClientIdentity {
	name: string;
	version: string;
	build: string;
	platform: string;
}
export interface SavedCursor {
	hostId: HostId;
	sessionId: SessionId;
	cursor: Cursor;
}
export interface HelloFrame {
	v: typeof PROTOCOL_VERSION;
	type: "hello";
	protocol: ProtocolRange;
	client: ClientIdentity;
	requestedFeatures: string[];
	savedCursors: SavedCursor[];
	capabilities?: Capabilities;
	authentication?: DeviceAuthentication;
}
export interface WelcomeFrame {
	v: typeof PROTOCOL_VERSION;
	type: "welcome";
	selectedProtocol: string;
	hostId: HostId;
	ompVersion: string;
	ompBuild: string;
	appserverVersion: string;
	appserverBuild: string;
	epoch: string;
	grantedCapabilities: string[];
	grantedFeatures: string[];
	negotiatedLimits: Record<string, unknown>;
	authentication: "local" | "pairing-required" | "paired";
	resumed: boolean;
}
function version(frame: Record<string, unknown>): void {
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
}
function protocolMajor(value: unknown, path: string): { text: string; major: number } {
	const text = controlFree(value, path, 64);
	const match = /^omp-app\/([1-9]\d*)$/u.exec(text);
	if (!match) fail("UNSUPPORTED_PROTOCOL", "protocol must be omp-app/<positive integer>", path);
	const major = Number(match[1]);
	if (!Number.isSafeInteger(major)) fail("UNSUPPORTED_PROTOCOL", "protocol major is unsafe", path);
	return { text, major };
}
function range(value: unknown, path: string): ProtocolRange {
	const x = boundedMap(value, path);
	const min = protocolMajor(x.min, `${path}.min`);
	const max = protocolMajor(x.max, `${path}.max`);
	if (min.major > max.major) fail("UNSUPPORTED_PROTOCOL", "protocol range is inverted", path);
	return { min: min.text, max: max.text };
}
function identity(value: unknown, path: string): ClientIdentity {
	const x = boundedMap(value, path);
	return {
		name: controlFree(x.name, `${path}.name`, 128),
		version: controlFree(x.version, `${path}.version`, 64),
		build: controlFree(x.build, `${path}.build`, 128),
		platform: controlFree(x.platform, `${path}.platform`, 128),
	};
}
export function decodeHello(input: unknown): HelloFrame {
	const frame = inputObject(input);
	version(frame);
	if (frame.type !== "hello") fail("INVALID_FRAME", "expected hello frame", "type");
	const protocol = range(frame.protocol, "protocol");
	const minMajor = protocolMajor(protocol.min, "protocol.min").major;
	const maxMajor = protocolMajor(protocol.max, "protocol.max").major;
	if (minMajor > 1 || maxMajor < 1) fail("UNSUPPORTED_PROTOCOL", "no supported protocol in range", "protocol");
	const client = identity(frame.client, "client");
	// Client requests are additive: a newer client may name a feature this host
	// does not know yet. Preserve bounded unknown names so negotiation can grant
	// the supported intersection; welcome frames remain strict below.
	const requestedFeatures = decodeFeatureList(frame.requestedFeatures, "requestedFeatures");
	const raw = boundedArray(frame.savedCursors, "savedCursors", MAX_SAVED_CURSORS);
	const savedCursors: SavedCursor[] = [];
	for (let i = 0; i < raw.length; i++) {
		const x = boundedMap(raw[i], `savedCursors[${i}]`);
		savedCursors.push({
			hostId: hostId(x.hostId, `savedCursors[${i}].hostId`),
			sessionId: sessionId(x.sessionId, `savedCursors[${i}].sessionId`),
			cursor: decodeCursor(x.cursor, `savedCursors[${i}].cursor`),
		});
	}
	if (frame.capabilities !== undefined) decodeCapabilities(frame.capabilities);
	const authentication = frame.authentication === undefined ? undefined : decodeAuthentication(frame.authentication);
	return {
		...frame,
		protocol,
		client,
		requestedFeatures,
		savedCursors,
		...(authentication === undefined ? {} : { authentication }),
	} as unknown as HelloFrame;
}
export function decodeWelcome(input: unknown): WelcomeFrame {
	const frame = inputObject(input);
	version(frame);
	if (frame.type !== "welcome") fail("INVALID_FRAME", "expected welcome frame", "type");
	const selectedProtocol = controlFree(frame.selectedProtocol, "selectedProtocol", 64);
	if (selectedProtocol !== PROTOCOL_VERSION)
		fail("UNSUPPORTED_PROTOCOL", "unsupported selected protocol", "selectedProtocol");
	hostId(frame.hostId);
	controlFree(frame.ompVersion, "ompVersion", 64);
	controlFree(frame.ompBuild, "ompBuild", 128);
	controlFree(frame.appserverVersion, "appserverVersion", 64);
	controlFree(frame.appserverBuild, "appserverBuild", 128);
	const authentication = frame.authentication;
	if (authentication !== "local" && authentication !== "pairing-required" && authentication !== "paired")
		fail("INVALID_FRAME", "invalid welcome authentication state", "authentication");
	const grantedCapabilities = decodeCapabilities({ client: frame.grantedCapabilities }, "grantedCapabilities").client;
	if (authentication === "pairing-required" && grantedCapabilities.length !== 0)
		fail("INVALID_FRAME", "pairing-required welcome must grant no capabilities", "grantedCapabilities");
	controlFree(frame.epoch, "epoch", 128);
	const grantedFeatures = decodeNegotiatedFeatureList(frame.grantedFeatures, "grantedFeatures");
	const negotiatedLimits = boundedMap(frame.negotiatedLimits, "negotiatedLimits");
	if (typeof frame.resumed !== "boolean") fail("INVALID_FRAME", "resumed must be boolean", "resumed");
	return {
		...frame,
		selectedProtocol,
		authentication,
		grantedCapabilities,
		grantedFeatures,
		negotiatedLimits,
	} as unknown as WelcomeFrame;
}
