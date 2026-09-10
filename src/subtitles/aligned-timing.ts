import { AlignedWord } from "../alignment/types.js";
import { SubtitleCue, SubtitleDocument, SubtitleSettings } from "./types.js";
import { wrapCaption } from "./timing.js";

export const ALIGNED_SUBTITLE_GENERATOR_VERSION = "aligned-subtitles-v1";

export function generateAlignedSubtitleTiming(words: AlignedWord[], audioDurationSeconds: number, settings: SubtitleSettings): SubtitleDocument {
  if (!words.length) throw new Error("Aligned subtitle generation requires timestamped words"); const maxCharacters = settings.maxCharactersPerLine * settings.maxLines; const groups: AlignedWord[][] = []; let current: AlignedWord[] = [];
  for (const word of words) {
    const candidate = joinWords([...current, word]); const duration = current.length ? word.end - current[0]!.start : word.end - word.start;
    const boundary = current.length && (candidate.length > maxCharacters || duration > settings.maximumDurationSeconds || word.start - current.at(-1)!.end > 1.25);
    if (boundary) { groups.push(current); current = []; }
    current.push(word);
    if (/[.!?…。！？][”’"']?$/u.test(word.text) && word.end - current[0]!.start >= settings.minimumDurationSeconds) { groups.push(current); current = []; }
  }
  if (current.length) groups.push(current);
  const cues: SubtitleCue[] = groups.map((group, index) => ({ index: index + 1, startSeconds: group[0]!.start, endSeconds: group.at(-1)!.end, text: wrapCaption(joinWords(group), settings.maxCharactersPerLine, settings.maxLines) }));
  for (let index = 0; index < cues.length; index++) { const cue = cues[index]!; const next = cues[index + 1]; const desiredEnd = Math.min(audioDurationSeconds, cue.startSeconds + settings.minimumDurationSeconds); cue.endSeconds = Math.max(cue.endSeconds, Math.min(desiredEnd, next?.startSeconds ?? audioDurationSeconds)); cue.endSeconds = Math.min(cue.endSeconds, cue.startSeconds + settings.maximumDurationSeconds, audioDurationSeconds); if (next && cue.endSeconds > next.startSeconds) cue.endSeconds = next.startSeconds; }
  return { version: ALIGNED_SUBTITLE_GENERATOR_VERSION, durationSeconds: audioDurationSeconds, timingMode: "aligned", manual: false, cues };
}

function joinWords(words: AlignedWord[]) { return words.map((word, index) => index && /^[,.;:!?…)}\]”’。！？；：，]/u.test(word.text) ? word.text : `${index ? " " : ""}${word.text}`).join(""); }
