import type { NarrationProfanityMode } from "../domain/story.js";

type Replacement = readonly [RegExp, string];

const STRONG_PROFANITY_REPLACEMENTS: readonly Replacement[] = [
  [/\bson of (?:a )?bitch\b/gi, "son of a gun"],
  [/\bsons of (?:a )?bitches\b/gi, "sons of guns"],
  [/\bmotherfuckers?\b/gi, "bastards"],
  [/\bfuck you\b/gi, "screw you"],
  [/\bfuck off\b/gi, "get lost"],
  [/\b(what|who|where|when|why|how) the fuck\b/gi, "$1 the hell"],
  [/\bfucked up\b/gi, "messed up"],
  [/\bfuckers?\b/gi, "jerks"],
  [/\bfucking\b/gi, "damn"],
  [/\bfucked\b/gi, "screwed"],
  [/\bno fucks? (?:left )?to give\b/gi, "no patience left to give"],
  [/\bfuck\b/gi, "damn"],
  [/\bbitching\b/gi, "complaining"],
  [/\bbitchy\b/gi, "nasty"],
  [/\bbitches\b/gi, "jerks"],
  [/\bbitch\b/gi, "jerk"],
  [/\bpieces of shit\b/gi, "pieces of trash"],
  [/\bpiece of shit\b/gi, "piece of trash"],
  [/\bbullshit\b/gi, "nonsense"],
  [/\bshitheads\b/gi, "idiots"],
  [/\bshithead\b/gi, "idiot"],
  [/\bshit\b/gi, "crap"],
  [/\bcunts\b/gi, "creeps"],
  [/\bcunt\b/gi, "creep"],
];

// This intentionally matches the same strong-word family as the narration
// softener. Mild terms such as "ass", "hell", and "damn" are not included.
const STRONG_PROFANITY_WORD = /\b(?:motherfuckers?|fuck(?:ing|ed|ers?|s)?|bitch(?:ing|y|es)?|bullshit|shitheads?|shit|cunts?)\b/gi;

/**
 * A final narration-only safety net. The narration model receives richer context
 * and should do the natural rewrite; this catches isolated strong terms it misses.
 */
export function softenStrongProfanity(text: string, mode: NarrationProfanityMode): string {
  if (mode !== "soften-strong") return text;
  return STRONG_PROFANITY_REPLACEMENTS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, (...args: unknown[]) => preserveCase(String(args[0]), replacement.replace(/\$(\d+)/g, (_, index: string) => String(args[Number(index)] ?? "")))),
    text,
  );
}

export function containsStrongProfanity(text: string): boolean {
  return STRONG_PROFANITY_REPLACEMENTS.some(([pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/**
 * Produces a hidden, TTS-only script. The stored narration remains untouched;
 * Fish speaks the replacement word where a strong term would have appeared.
 */
export function bleepStrongProfanityForTts(text: string, enabled: boolean): string {
  if (!enabled) return text;
  return text.replace(STRONG_PROFANITY_WORD, (match) => preserveCase(match, "bleep"));
}

function preserveCase(source: string, replacement: string): string {
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  if (/^[A-Z]/.test(source)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}
