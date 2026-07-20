import {
	APP_WIRE_VERSION,
	type AppFrame,
	COMMAND_DESCRIPTORS,
	type CommandFrame,
	commandId,
	decodeClientFrame,
	decodeServerFrame,
	hostId,
	type PreviewCaptureId,
	type PreviewSnapshot,
	type ResultFrame,
	requestId,
	type TranscriptContextResult,
	type TranscriptPageResult,
	type TranscriptSearchResult,
} from "../src/index.js";

const command: CommandFrame = {
	v: "omp-app/1",
	type: "command",
	requestId: requestId("request"),
	commandId: commandId("command"),
	hostId: hostId("host"),
	command: "session.create",
	args: { projectId: "project" },
};
const decoded: AppFrame = decodeClientFrame(command);
const result: ResultFrame = {
	v: "omp-app/1",
	type: "response",
	requestId: requestId("request"),
	commandId: commandId("command"),
	hostId: hostId("host"),
	ok: true,
};
void decodeServerFrame(result);
void decoded;
void APP_WIRE_VERSION;
void COMMAND_DESCRIPTORS["session.create"];
void COMMAND_DESCRIPTORS["usage.read"];
void COMMAND_DESCRIPTORS["transcript.search"];
void COMMAND_DESCRIPTORS["transcript.context"];
void COMMAND_DESCRIPTORS["transcript.page"];
void COMMAND_DESCRIPTORS["preview.capture.read"];
void COMMAND_DESCRIPTORS["preview.handoff"];
declare const searchResult: TranscriptSearchResult;
declare const contextResult: TranscriptContextResult;
declare const pageResult: TranscriptPageResult;
declare const preview: PreviewSnapshot;
declare const captureId: PreviewCaptureId;
void searchResult.index.generation;
void contextResult.rows[contextResult.anchorIndex];
void pageResult.entries[0]?.id;
void preview.availableActions?.includes("handoff");
void captureId;
