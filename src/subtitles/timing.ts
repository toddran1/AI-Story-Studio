import { SubtitleError } from "../pipeline/errors.js";
import { SubtitleCue, SubtitleDocument, SubtitleSettings } from "./types.js";

export const SUBTITLE_GENERATOR_VERSION = "deterministic-subtitles-v1";

export function generateSubtitleTiming(text: string, durationSeconds: number, settings: SubtitleSettings): SubtitleDocument {
  if (!text.trim()) throw new SubtitleError("Narration is empty; subtitles cannot be generated");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new SubtitleError("A positive mastered-audio duration is required for subtitle timing");
  const chunks = segmentNarration(text, settings.maxCharactersPerLine * settings.maxLines); const weights = chunks.map(speechWeight); const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = 0; const cues: SubtitleCue[] = chunks.map((chunk, index) => {
    const remaining = durationSeconds - cursor; const remainingCues = chunks.length - index; const ideal = durationSeconds * weights[index]! / totalWeight;
    const minimum = Math.min(settings.minimumDurationSeconds, remaining / remainingCues); const maximum = Math.max(minimum, settings.maximumDurationSeconds);
    const cueDuration = index === chunks.length - 1 ? remaining : Math.min(maximum, Math.max(minimum, ideal)); const startSeconds = cursor; cursor = Math.min(durationSeconds, cursor + cueDuration);
    return { index: index + 1, startSeconds, endSeconds: cursor, text: wrapCaption(chunk, settings.maxCharactersPerLine, settings.maxLines) };
  });
  // Redistribute any tail left by maximum-duration caps and guarantee exact, non-overlapping final timing.
  const tail = durationSeconds - (cues.at(-1)?.endSeconds ?? 0); if (tail > 0) for (let index = 0; index < cues.length; index++) { const shift = tail * (index + 1) / cues.length; cues[index]!.endSeconds += shift; if (index + 1 < cues.length) cues[index + 1]!.startSeconds += shift; }
  cues.at(-1)!.endSeconds = durationSeconds; return { version: SUBTITLE_GENERATOR_VERSION, durationSeconds, timingMode: "estimated", manual: false, cues };
}

export function segmentNarration(text: string, maxCharacters: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim(); const sentences = normalized.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/gu) ?? [normalized]; const chunks: string[] = [];
  for (const sentence of sentences.map((value) => value.trim()).filter(Boolean)) splitLong(sentence, maxCharacters, chunks);
  return chunks;
}

function splitLong(value: string, max: number, output: string[]) {
  if (value.length <= max) { output.push(value); return; }
  const clauses = value.split(/(?<=[,;:，；：])\s*/u).filter(Boolean); let current = "";
  for (const clause of clauses) {
    if (clause.length > max) { if (current) { output.push(current); current = ""; } splitWords(clause, max, output); }
    else if (!current || `${current} ${clause}`.length <= max) current = current ? `${current} ${clause}` : clause;
    else { output.push(current); current = clause; }
  }
  if (current) output.push(current);
}
function splitWords(value: string, max: number, output: string[]) { const words = value.split(/\s+/); let current = ""; for (const word of words) { if (word.length > max) { if (current) output.push(current); for (let index = 0; index < word.length; index += max) output.push(word.slice(index, index + max)); current = ""; } else if (!current || `${current} ${word}`.length <= max) current = current ? `${current} ${word}` : word; else { output.push(current); current = word; } } if (current) output.push(current); }
function speechWeight(value: string) { const words = value.match(/[\p{L}\p{N}]+/gu)?.length ?? 0; const ideographs = value.match(/\p{Script=Han}/gu)?.length ?? 0; return Math.max(1, words + ideographs * 0.65 + value.length * 0.03); }
export function wrapCaption(value: string, width: number, maxLines: number) { let remaining = value.trim(); const lines: string[] = []; while (remaining && lines.length < maxLines) { if (remaining.length <= width || lines.length === maxLines - 1) { lines.push(remaining); break; } const linesLeft = maxLines - lines.length - 1; const minimumSplit = Math.max(1, remaining.length - width * linesLeft); let split = remaining.lastIndexOf(" ", width); if (split < minimumSplit) split = remaining.indexOf(" ", minimumSplit); if (split < minimumSplit || split > width) split = width; lines.push(remaining.slice(0, split).trim()); remaining = remaining.slice(split).trim(); } return lines.join("\n"); }
