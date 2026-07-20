export interface VoiceTranscriptRange {
  readonly start: number;
  readonly text: string;
}

export interface VoiceTranscriptUpdate {
  readonly range: VoiceTranscriptRange;
  readonly value: string;
}

export function reconcileVoiceTranscript(
  value: string,
  transcript: string,
  previous?: VoiceTranscriptRange,
): VoiceTranscriptUpdate | undefined {
  const text = transcript.trim();
  if (text === "") return undefined;

  if (previous === undefined) {
    const separator = value === "" || /\s$/u.test(value) ? "" : " ";
    const start = value.length + separator.length;
    return { value: `${value}${separator}${text}`, range: { start, text } };
  }

  if (value.slice(previous.start, previous.start + previous.text.length) !== previous.text) {
    return undefined;
  }

  return {
    value: `${value.slice(0, previous.start)}${text}${value.slice(previous.start + previous.text.length)}`,
    range: { start: previous.start, text },
  };
}
