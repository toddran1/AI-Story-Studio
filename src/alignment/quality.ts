import { AlignmentConfig, AlignmentMetrics, AlignmentObservation, AlignedWord } from "./types.js";

export type AlignmentQuality = { usable: boolean; words: AlignedWord[]; metrics: AlignmentMetrics; warnings: string[] };

export function reconcileAndValidateAlignment(narration: string, observations: AlignmentObservation[], audioDurationSeconds: number, config: AlignmentConfig): AlignmentQuality {
  const narrationWords = tokenizeNarration(narration); const validObservations = observations.filter(validObservation); const invalidOrder = validObservations.some((word, index) => index > 0 && (word.start < validObservations[index - 1]!.start || word.start < validObservations[index - 1]!.end)); const usableObservations = [...validObservations].sort((a, b) => a.start - b.start);
  const matched = new Map<number, number>(); let cursor = 0;
  for (let index = 0; index < narrationWords.length; index++) {
    const target = normalize(narrationWords[index]!); if (!target) continue; let best = -1;
    for (let candidate = cursor; candidate < Math.min(usableObservations.length, cursor + 16); candidate++) {
      if (equivalent(target, normalize(usableObservations[candidate]!.text))) { best = candidate; break; }
    }
    if (best >= 0) { matched.set(index, best); cursor = best + 1; }
  }
  const words = interpolateWords(narrationWords, usableObservations, matched, audioDurationSeconds);
  const matchedWords = [...matched.values()].map((index) => usableObservations[index]!); const confidences = matchedWords.map((word) => word.confidence).filter((value): value is number => value !== undefined);
  const maximumGapSeconds = matchedWords.slice(1).reduce((maximum, word, index) => Math.max(maximum, word.start - matchedWords[index]!.end), 0);
  const metrics: AlignmentMetrics = {
    matchedWordPercentage: narrationWords.length ? matched.size / narrationWords.length * 100 : 0,
    averageConfidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : undefined,
    matchedWordCount: matched.size, unmatchedWordCount: Math.max(0, narrationWords.length - matched.size),
    alignmentDurationSeconds: matchedWords.length ? Math.max(0, matchedWords.at(-1)!.end - matchedWords[0]!.start) : 0,
    audioDurationSeconds, maximumGapSeconds,
  };
  const warnings: string[] = [];
  if (!narrationWords.length) warnings.push("Narration contains no alignable words");
  if (!usableObservations.length) warnings.push("Alignment engine produced no usable timestamps");
  if (metrics.matchedWordPercentage < config.minimumMatchPercentage) warnings.push(`Matched ${metrics.matchedWordPercentage.toFixed(1)}% of narration; minimum is ${config.minimumMatchPercentage}%`);
  if (metrics.averageConfidence !== undefined && metrics.averageConfidence < config.minimumConfidence) warnings.push(`Average confidence ${metrics.averageConfidence.toFixed(2)} is below ${config.minimumConfidence.toFixed(2)}`);
  if (metrics.maximumGapSeconds > config.maximumGapSeconds) warnings.push(`Alignment contains a ${metrics.maximumGapSeconds.toFixed(1)}s gap; maximum is ${config.maximumGapSeconds}s`);
  if (invalidOrder || usableObservations.some((word) => word.start < 0 || word.end > audioDurationSeconds + .25)) warnings.push("Alignment timestamps are non-monotonic, overlapping, or outside the mastered audio");
  if (matchedWords.length && matchedWords[0]!.start > Math.min(5, audioDurationSeconds * .15)) warnings.push("Alignment appears to miss the beginning of the narration");
  if (matchedWords.length && audioDurationSeconds - matchedWords.at(-1)!.end > Math.min(8, audioDurationSeconds * .2)) warnings.push("Alignment appears to miss the end of the narration");
  return { usable: warnings.length === 0, words, metrics, warnings };
}

export function tokenizeNarration(text: string): string[] {
  const raw = text.match(/\p{Script=Han}|[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|[^\s]/gu) ?? []; const words: string[] = [];
  for (const token of raw) { if (/^[.!?…,:;。！？；：，]+$/u.test(token) && words.length) words[words.length - 1] += token; else if (normalize(token)) words.push(token); }
  return words;
}

function interpolateWords(text: string[], observations: AlignmentObservation[], matches: Map<number, number>, audioDuration: number): AlignedWord[] {
  if (!text.length) return []; const anchors = [...matches.entries()].sort(([a], [b]) => a - b); const output: AlignedWord[] = [];
  for (let index = 0; index < text.length; index++) {
    const observedIndex = matches.get(index); if (observedIndex !== undefined) { const word = observations[observedIndex]!; output.push({ text: text[index]!, start: clamp(word.start, 0, audioDuration), end: clamp(Math.max(word.end, word.start + .01), 0.01, audioDuration), confidence: word.confidence, matched: true }); continue; }
    const previous = [...anchors].reverse().find(([at]) => at < index); const next = anchors.find(([at]) => at > index); const lowerIndex = previous?.[0] ?? -1; const upperIndex = next?.[0] ?? text.length; const lowerTime = previous ? observations[previous[1]]!.end : 0; const upperTime = next ? observations[next[1]]!.start : audioDuration; const slots = upperIndex - lowerIndex; const position = index - lowerIndex; const start = lowerTime + (upperTime - lowerTime) * (position - 1) / Math.max(1, slots - 1); const end = lowerTime + (upperTime - lowerTime) * position / Math.max(1, slots - 1);
    output.push({ text: text[index]!, start: clamp(start, 0, audioDuration), end: clamp(Math.max(end, start + .01), .01, audioDuration), confidence: 0, matched: false });
  }
  for (let index = 0; index < output.length; index++) { const word = output[index]!; if (index && word.start < output[index - 1]!.end) word.start = output[index - 1]!.end; if (word.end <= word.start) word.end = Math.min(audioDuration, word.start + .01); }
  return output.filter((word) => word.end > word.start);
}
function validObservation(word: AlignmentObservation) { return Boolean(word.text.trim()) && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end > word.start; }
function normalize(value: string) { return value.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); }
function equivalent(left: string, right: string) { return Boolean(left && right && (left === right || left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left)))); }
function clamp(value: number, minimum: number, maximum: number) { return Math.max(minimum, Math.min(maximum, value)); }
