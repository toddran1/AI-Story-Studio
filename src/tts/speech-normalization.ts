import { fingerprint } from "../utils/hash.js";

export const SPEECH_NORMALIZATION_VERSION = "speech-normalization-v2";
export type SpeechNormalizationMode = "automatic" | "enabled" | "disabled";
export type TimeSpeechMode = "natural_12h" | "natural_24h" | "preserve";
export type SpeechNormalizationSettings = { mode?: SpeechNormalizationMode; timeSpeechMode?: TimeSpeechMode; speechAbbreviations?: Record<string, string> };
export type SpeechTransformation = { kind: "time" | "percentage" | "currency" | "measurement" | "number" | "chapter" | "quoted-label" | "abbreviation"; written: string; spoken: string; start: number; end: number };
export type SpeechNormalizationResult = { text: string; transformations: SpeechTransformation[]; warnings: string[] };

const small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const defaultAbbreviations: Record<string, string> = { EXP: "E-X-P", XP: "X-P", HP: "H-P", MP: "M-P", NPC: "N-P-C" };
const labelNouns = "feature|skill|ability|class|talent|dungeon|item|system(?:\u0020term)?|title|rank|job|profession|technique|artifact|weapon|spell";

/** A conservative, provider-neutral spoken form. It intentionally leaves ambiguous IDs,
 * years, dates, ratios, and bare numbers untouched. */
export function normalizeSpeechText(text: string, language: string, settings: SpeechNormalizationSettings = {}): SpeechNormalizationResult {
  const mode = settings.mode ?? "automatic";
  if (mode === "disabled" || (mode === "automatic" && !isEnglish(language))) return { text, transformations: [], warnings: [] };
  const timeMode = settings.timeSpeechMode ?? "natural_12h";
  const transformations: SpeechTransformation[] = [];
  let output = text;
  const replace = (kind: SpeechTransformation["kind"], expression: RegExp, render: (written: string, offset: number, source: string) => string | undefined) => {
    output = output.replace(expression, (written: string, offset: number, source: string) => {
      const spoken = render(written, offset, source);
      if (!spoken || spoken === written) return written;
      transformations.push({ kind, written, spoken, start: offset, end: offset + written.length });
      return spoken;
    });
  };
  // Quotation marks around a named game/story term can make some TTS engines
  // insert a dialogue-sized pause. Only remove them when the surrounding grammar
  // clearly identifies the quote as a label within an ongoing noun phrase.
  replace("quoted-label", new RegExp(`\\b((?:the|an?|his|her|its|their)\\s+)"([^"\\n]{1,120})"\\s+(${labelNouns})\\b`, "giu"), written => {
    const match = /^(.*)"([^"\n]+)"\s+(.+)$/u.exec(written);
    return match ? `${match[1]}${match[2]} ${match[3]}` : undefined;
  });
  const configuredAbbreviations = canonicalAbbreviations(settings.speechAbbreviations);
  const abbreviations = { ...defaultAbbreviations, ...configuredAbbreviations };
  for (const [written, spoken] of Object.entries(abbreviations).sort(([left], [right]) => right.length - left.length || left.localeCompare(right))) {
    if (!written || !spoken.trim()) continue;
    replace("abbreviation", new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(written)}(?![\\p{L}\\p{N}])`, "giu"), () => spoken.trim());
  }
  if (timeMode !== "preserve") replace("time", /(?<![\p{L}\p{N}])(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[AaPp]\.?\s*[Mm]\.)?(?![\p{L}\p{N}])/gu, (written, offset, source) => {
    if (looksLikeReference(source, offset)) return undefined;
    const spoken = speakTime(written, timeMode);
    return spoken && source[offset + written.length] === "." && spoken.endsWith(".") ? spoken.slice(0, -1) : spoken;
  });
  replace("currency", /\$(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?(?![\d.])/g, written => speakCurrency(written));
  replace("percentage", /(?<![\p{L}\p{N}])(\d{1,3}(?:,\d{3})*)%(?![\p{L}\p{N}])/gu, written => `${speakInteger(Number(written.slice(0, -1).replaceAll(",", "")))} percent`);
  replace("measurement", /(?<![\p{L}\p{N}])(\d{1,3}(?:,\d{3})*)\s*(km|kg)(?![\p{L}])/giu, written => {
    const match = /^(.*?)\s*(km|kg)$/iu.exec(written); if (!match) return undefined;
    const amount = Number(match[1]!.replaceAll(",", "")); const unit = match[2]!.toLocaleLowerCase() === "km" ? "kilometer" : "kilogram";
    return `${speakInteger(amount)} ${unit}${amount === 1 ? "" : "s"}`;
  });
  replace("chapter", /\bChapter\s+(\d{1,4})(?![\d:])/giu, written => {
    const value = Number(/\d+/.exec(written)?.[0]); return Number.isSafeInteger(value) ? `chapter ${speakInteger(value)}` : undefined;
  });
  replace("number", /(?<![\p{L}\p{N}])\d{1,3}(?:,\d{3})+(?![\p{L}\p{N}])/gu, written => speakInteger(Number(written.replaceAll(",", ""))));
  return { text: output, transformations, warnings: [] };
}

export function speechNormalizationFingerprint(text: string, language: string, settings: SpeechNormalizationSettings = {}) {
  const normalized = normalizeSpeechText(text, language, settings);
  return { normalized, fingerprint: fingerprint({ version: SPEECH_NORMALIZATION_VERSION, language, settings: { mode: settings.mode ?? "automatic", timeSpeechMode: settings.timeSpeechMode ?? "natural_12h", speechAbbreviations: canonicalAbbreviations(settings.speechAbbreviations) }, text: normalized.text }) };
}

function isEnglish(language: string) { return /^en(?:[-_]|$)/i.test(language.trim()); }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function canonicalAbbreviations(value: Record<string, string> | undefined) {
  return Object.fromEntries(Object.entries(value ?? {}).map(([key, spoken]) => [key.toLocaleUpperCase(), spoken.trim()] as const).sort(([left], [right]) => left.localeCompare(right)));
}
function looksLikeReference(source: string, offset: number) {
  const before = source.slice(Math.max(0, offset - 28), offset);
  return /\b(?:chapter|verse|psalm|genesis|exodus|matthew|mark|luke|john|romans|corinthians)(?:\s+\d+)?\s*$/iu.test(before);
}
function speakTime(value: string, mode: Exclude<TimeSpeechMode, "preserve">) {
  const match = /^(\d{1,2}):(\d{2})(?:\s*([AaPp])\.?\s*[Mm]\.)?$/u.exec(value.trim()); if (!match) return undefined;
  let hour = Number(match[1]), minute = Number(match[2]); const explicit = match[3]?.toLocaleLowerCase();
  if (mode === "natural_24h") return `${hour < 10 ? "zero " : ""}${speakInteger(hour)} ${minute === 0 ? "hundred" : minute < 10 ? `oh ${speakInteger(minute)}` : speakInteger(minute)}`;
  if (minute === 0 && !explicit && hour === 0) return "midnight";
  if (minute === 0 && !explicit && hour === 12) return "noon";
  const period = explicit ?? (hour >= 12 ? "p" : "a");
  if (hour === 0) hour = 12; else if (hour > 12) hour -= 12;
  const minuteWords = minute === 0 ? "" : minute < 10 ? ` oh ${speakInteger(minute)}` : ` ${speakInteger(minute)}`;
  return `${speakInteger(hour)}${minuteWords} ${period}.m.`;
}
function speakCurrency(value: string) {
  const match = /^\$(\d[\d,]*)(?:\.(\d{2}))?$/u.exec(value); if (!match) return undefined;
  const dollars = Number(match[1]!.replaceAll(",", "")); const cents = match[2] ? Number(match[2]) : 0;
  const base = `${speakInteger(dollars)} dollar${dollars === 1 ? "" : "s"}`;
  return cents ? `${base} and ${speakInteger(cents)} cent${cents === 1 ? "" : "s"}` : base;
}
export function speakInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 999_999_999) return String(value);
  if (value < 20) return small[value]!;
  if (value < 100) return `${tens[Math.floor(value / 10)]}${value % 10 ? `-${small[value % 10]}` : ""}`;
  if (value < 1_000) return `${small[Math.floor(value / 100)]} hundred${value % 100 ? ` ${speakInteger(value % 100)}` : ""}`;
  if (value < 1_000_000) return `${speakInteger(Math.floor(value / 1_000))} thousand${value % 1_000 ? ` ${speakInteger(value % 1_000)}` : ""}`;
  return `${speakInteger(Math.floor(value / 1_000_000))} million${value % 1_000_000 ? ` ${speakInteger(value % 1_000_000)}` : ""}`;
}
