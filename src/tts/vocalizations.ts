export type VocalizationType = "laugh" | "chuckle" | "scoff" | "sigh" | "gasp" | "grunt" | "groan" | "sob" | "cry" | "growl" | "thinking" | "hesitation" | "exclamation" | "other";
export type VocalizationIntensity = "light" | "medium" | "strong";
export interface VocalizationInstruction {
  type: "vocalization";
  vocalization: VocalizationType;
  sourceText: string;
  intensity?: VocalizationIntensity;
  tone?: string;
  position: "before" | "inline" | "after";
  confidence: number;
  start: number;
  end: number;
}
export type SpeechSegment = { type: "speech"; text: string } | VocalizationInstruction;

export type VocalizationRenderStrategy =
  | { kind: "native_tags"; tags: Partial<Record<VocalizationType, string>> }
  | { kind: "safe_normalize" }
  | { kind: "omit" };

export type VocalizationCapabilities = {
  expressiveTags: boolean;
  supportedTypes?: VocalizationType[];
  /** Reserved for future separate-segment synthesis; false everywhere today. */
  separateSegments?: boolean;
  instructionPrompting?: boolean;
};

export type ScannedVocalization = VocalizationInstruction & { spokenForm: string };

type LexemeEntry = { pattern: string; vocalization: VocalizationType; confidence: number; spoken: (token: string) => string };

const collapseRuns = (token: string, max = 3) => token.replace(/(.)\1{2,}/giu, (_match, char: string) => char.repeat(max));
const fixed = (form: string) => (token: string) => (/^\p{Lu}/u.test(token) ? form[0]!.toLocaleUpperCase() + form.slice(1) : form);
const collapsed = (max = 3) => (token: string) => {
  const value = collapseRuns(token.toLocaleLowerCase(), max);
  return /^\p{Lu}/u.test(token) ? value[0]!.toLocaleUpperCase() + value.slice(1) : value;
};

// Boundary-aware interjection lexicon. Every pattern is matched with letter/number
// lookarounds, so tokens never match inside words ("harmony", "ahead", "grrreat" is
// still a token, "aggregate" is not). Elongated lexical words (Nooooo, Pleeease) are
// deliberately absent from the lexicon and must remain untouched.
const lexicon: LexemeEntry[] = [
  { pattern: "ha(?:ha)+", vocalization: "laugh", confidence: .9, spoken: fixed("hahaha") },
  { pattern: "ha(?:[ \\t]+ha)+", vocalization: "laugh", confidence: .85, spoken: fixed("hahaha") },
  { pattern: "he(?:he)+", vocalization: "laugh", confidence: .85, spoken: fixed("hehehe") },
  { pattern: "heh", vocalization: "chuckle", confidence: .7, spoken: fixed("heh") },
  { pattern: "hmp[hf]", vocalization: "scoff", confidence: .85, spoken: fixed("hmph") },
  { pattern: "hm{2,}", vocalization: "thinking", confidence: .75, spoken: collapsed() },
  { pattern: "mm{2,}", vocalization: "thinking", confidence: .75, spoken: collapsed() },
  { pattern: "urgh", vocalization: "groan", confidence: .8, spoken: fixed("urgh") },
  { pattern: "ugh", vocalization: "groan", confidence: .8, spoken: fixed("ugh") },
  { pattern: "gr+", vocalization: "growl", confidence: .85, spoken: collapsed() },
  { pattern: "tsk(?:[ \\t-]?tsk)?", vocalization: "scoff", confidence: .75, spoken: fixed("tsk") },
  { pattern: "pf+t+", vocalization: "scoff", confidence: .8, spoken: collapsed() },
  { pattern: "sigh", vocalization: "sigh", confidence: .8, spoken: fixed("sigh") },
  { pattern: "sob(?:[ \\t-]?sob)?", vocalization: "sob", confidence: .8, spoken: fixed("sob") },
  { pattern: "sniff", vocalization: "sob", confidence: .7, spoken: fixed("sniff") },
  { pattern: "gasp", vocalization: "gasp", confidence: .85, spoken: fixed("gasp") },
  { pattern: "oo+h", vocalization: "gasp", confidence: .6, spoken: collapsed() },
  { pattern: "ah+", vocalization: "gasp", confidence: .65, spoken: collapsed() },
  { pattern: "oh", vocalization: "exclamation", confidence: .5, spoken: fixed("oh") },
];

const expression = new RegExp(
  `(?<![\\p{L}\\p{N}])(${lexicon.map((entry) => entry.pattern).join("|")})(?![\\p{L}\\p{N}])([!?…—,.]*)`,
  "giu",
);
const anchored = lexicon.map((entry) => new RegExp(`^(?:${entry.pattern})$`, "iu"));

function intensityFor(punctuation: string, token: string): VocalizationIntensity {
  if (punctuation.includes("!") || /(.)\1{3,}/iu.test(token)) return "strong";
  if (punctuation.includes("…") || punctuation.includes("...")) return "light";
  return "medium";
}

/** Deterministic lexicon scan. `spokenForm` is the canonical short spoken form used by
 * the safe_normalize fallback; the written text itself is never modified here. */
export function scanVocalizations(text: string): ScannedVocalization[] {
  const results: ScannedVocalization[] = [];
  for (const match of text.matchAll(expression)) {
    const token = match[1]!;
    const entry = lexicon[anchored.findIndex((pattern) => pattern.test(token))];
    if (!entry) continue;
    const start = match.index!;
    const sourceText = match[0];
    const punctuation = match[2] ?? "";
    results.push({
      type: "vocalization", vocalization: entry.vocalization, sourceText,
      intensity: intensityFor(punctuation, token),
      position: text.slice(0, start).trim() ? (text.slice(start + sourceText.length).trim() ? "inline" : "after") : "before",
      confidence: entry.confidence, start, end: start + sourceText.length,
      spokenForm: entry.spoken(token) + punctuation,
    });
  }
  return results;
}

export function detectVocalizations(text: string): VocalizationInstruction[] {
  return scanVocalizations(text).map(({ spokenForm: _spokenForm, ...instruction }) => instruction);
}

/** Split into speech/vocalization spans for diagnostics and future per-segment synthesis. */
export function segmentSpeech(text: string): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  let cursor = 0;
  for (const vocalization of detectVocalizations(text)) {
    if (vocalization.start > cursor) segments.push({ type: "speech", text: text.slice(cursor, vocalization.start) });
    segments.push(vocalization);
    cursor = vocalization.end;
  }
  if (cursor < text.length) segments.push({ type: "speech", text: text.slice(cursor) });
  return segments.filter((segment) => segment.type !== "speech" || segment.text.length > 0);
}
