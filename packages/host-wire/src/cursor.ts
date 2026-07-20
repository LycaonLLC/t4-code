import { controlFree, inputObject, safeSeq } from "./guards.js";
import { MAX_EPOCH_BYTES } from "./limits.js";
export interface Cursor {
	epoch: string;
	seq: number;
}
export function isCursor(value: unknown): value is Cursor {
	try {
		decodeCursor(value);
		return true;
	} catch {
		return false;
	}
}
export function decodeCursor(value: unknown, path = "cursor"): Cursor {
	const cursor = inputObject(value);
	return {
		epoch: controlFree(cursor.epoch, `${path}.epoch`, MAX_EPOCH_BYTES),
		seq: safeSeq(cursor.seq, `${path}.seq`),
	};
}
