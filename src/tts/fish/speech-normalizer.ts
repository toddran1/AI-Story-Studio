import { stripSpeechMarkdownEmphasis as stripFishMarkdownEmphasis } from "../markdown-emphasis.js";
export { stripSpeechMarkdownEmphasis as stripFishMarkdownEmphasis } from "../markdown-emphasis.js";
import { disambiguateFishS2Brackets, isFishS2Model } from "./control-cues.js";
import { normalizeStructuredSpeechBlock, normalizeSystemMetadataText, speakInteger, stripStandaloneEllipsisLines } from "../speech-normalization.js";
import { scanVocalizations } from "../vocalizations.js";

const TITLE_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bMr\.(?=\s+\p{L})/gu, "Mister"],
  [/\bMrs\.(?=\s+\p{L})/gu, "Missus"],
  [/\bMs\.(?=\s+\p{L})/gu, "Miss"],
  [/\bDr\.(?=\s+\p{L})/gu, "Doctor"],
  [/\bProf\.(?=\s+\p{L})/gu, "Professor"],
  [/\bCapt\.(?=\s+\p{L})/gu, "Captain"],
  [/\bCmdr\.(?=\s+\p{L})/gu, "Commander"],
  [/\bGen\.(?=\s+\p{L})/gu, "General"],
  [/\bLt\.(?=\s+\p{L})/gu, "Lieutenant"],
  [/\bSgt\.(?=\s+\p{L})/gu, "Sergeant"],
  [/\bJr\.(?=\s*(?:[,;:!?]|$))/gmu, "Junior"],
  [/\bSr\.(?=\s*(?:[,;:!?]|$))/gmu, "Senior"],
];

const INITIALISM_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bUSA\b/g, "U.S.A."],
  [/\bAI\b/g, "A.I."],
  [/\bAPI\b/g, "A.P.I."],
  [/\bURL\b/g, "U.R.L."],
  [/\bHTML\b/g, "H.T.M.L."],
  [/\bJSON\b/g, "J.S.O.N."],
  [/\bPDF\b/g, "P.D.F."],
  [/\bCEO\b/g, "C.E.O."],
  [/\bVIP\b/g, "V.I.P."],
  [/\bEXP\b/g, "E X P"],
  [/\bXP\b/g, "X P"],
  [/\bHP\b/g, "H P"],
  [/\bMP\b/g, "M P"],
  [/\bNPC\b/g, "N P C"],
  [/\bRPG\b/g, "R.P.G."],
  [/\bMMORPG\b/g, "M.M.O.R.P.G."],
  [/\bVR\b/g, "V.R."],
];

const UNIT_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(\d+(?:\.\d+)?)\s*°\s*F\b/gi, "$1 degrees Fahrenheit"],
  [/\b(\d+(?:\.\d+)?)\s*°\s*C\b/gi, "$1 degrees Celsius"],
  [/\b(\d+(?:\.\d+)?)\s*(?:degrees?|deg\.?)\s*F\b/gi, "$1 degrees Fahrenheit"],
  [/\b(\d+(?:\.\d+)?)\s*(?:degrees?|deg\.?)\s*C\b/gi, "$1 degrees Celsius"],
  [/\b(\d+(?:\.\d+)?)\s?km\/h\b/gi, "$1 kilometers per hour"],
  [/\b(\d+(?:\.\d+)?)\s?mph\b/gi, "$1 miles per hour"],
  [/\b(\d+(?:\.\d+)?)\s?kg\b/gi, "$1 kilograms"],
  [/\b(\d+(?:\.\d+)?)\s?km\b/gi, "$1 kilometers"],
  [/\b(\d+(?:\.\d+)?)\s?cm\b/gi, "$1 centimeters"],
  [/\b(\d+(?:\.\d+)?)\s?mm\b/gi, "$1 millimeters"],
  [/\b(\d+(?:\.\d+)?)\s?lbs?\b/gi, "$1 pounds"],
  [/\b(\d+(?:\.\d+)?)\s?GB\b/g, "$1 gigabytes"],
  [/\b(\d+(?:\.\d+)?)\s?MB\b/g, "$1 megabytes"],
];

function stripMarkdownForSpeech(text: string): string {
  return text
    // Markdown scene dividers are silent; the list-marker rule below would
    // otherwise leave a stray asterisk for the voice model to interpret.
    .replace(/^[ \t]*(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/gm, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\((?:https?:\/\/|sandbox:\/)[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1");
}

function stripEmojiForSpeech(text: string): string {
  return text
    .replace(/\p{Regional_Indicator}{2}/gu, " ")
    .replace(/[0-9#*]\uFE0F?\u20E3/gu, " ")
    .replace(/\p{Extended_Pictographic}(?:[\uFE0E\uFE0F])?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F])?(?:\p{Emoji_Modifier})?)*/gu, " ")
    .replace(/[\u200D\uFE0E\uFE0F]/g, " ");
}

/** Music notes marking a lyric are editorial notation, not words or a Fish
 * delivery cue. Keep the displayed narration unchanged and speak the lyric. */
function stripMusicCuesForSpeech(text: string): string {
  return text.split("\n").map((line) => {
    let spoken = line.replace(/(^|[“"‘'])([ \t]*)(?:[♪♫♬♩🎵🎶][ \t]*:?[ \t]*)+(?=\p{L})/gu, "$1$2");
    if (spoken === line) return line;
    spoken = spoken.replace(/[ \t]*[♪♫♬♩🎵🎶]+(?=[ \t]*[”"’']?(?:\[[^\]\n]+\])?[ \t]*$)/u, "");
    spoken = spoken.replace(/~+[ \t]*(?=(?:\.{3,}|…+)?[ \t]*[”"’']?(?:\[[^\]\n]+\])?[ \t]*$)/u, "");
    // A trailing lyric ellipsis invites the model to continue inventing words.
    return spoken.replace(/(?:\.{3,}|…+)(?=[ \t]*[”"’']?(?:\[[^\]\n]+\])?[ \t]*$)/u, ".");
  }).join("\n");
}

function replaceAll(text: string, replacements: ReadonlyArray<readonly [RegExp, string]>): string {
  return replacements.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

/**
 * Builds Fish's hidden delivery text. It deliberately avoids blanket expansion
 * of uppercase words and ambiguous forms (for example St.) so names, ranks, and
 * fictional terminology are not silently changed.
 */
export function normalizeFishSpeechText(text: string, model?: string, options: { tskRendering?: "preserve" | "direction" } = {}): string {
  // Only item panels with a recognized rarity and metadata colon qualify;
  // ordinary prose parentheses and deliberate delivery cues remain untouched.
  const itemPanels = text.replace(/\[[^\[\]\r\n]{1,500}\]/gu, (block) =>
    /\((?:common|uncommon|rare|epic|legendary|mythic|unique|normal)\)\s*:/iu.test(block)
      ? normalizeStructuredSpeechBlock(block).replace(/\s*:\s*/gu, ". ").replace(/,\s*(?=Special Effect\b)/giu, ". ")
      : block);
  const structured = normalizeFishLeadingHesitations(stripMusicCuesForSpeech(stripStandaloneEllipsisLines(itemPanels)), model).replace(/【[^【】\n]{1,500}】/gu, normalizeStructuredSpeechBlock)
    .replace(/(?<![\p{L}\p{N}])([A-Z][\p{L}\p{N} -]{1,80})\s+\((Passive|Active)\)\s+\((Level [^()\n]{1,30}|Rank [^()\n]{1,30})\)/gu, normalizeSystemMetadataText);
  const withoutMarkup = renderFishVocalizations(disambiguateFishS2Brackets(stripFishMarkdownEmphasis(stripEmojiForSpeech(stripMarkdownForSpeech(structured))), model), model, options)
    // A performed reaction can be tagged more than once by earlier preparation.
    // Repeated adjacent laugh tags describe one reaction, not separate sounds.
    .replace(/“[^”\r\n]{1,2000}”|"[^"\r\n]{1,2000}"|‘[^’\r\n]{1,2000}’/gu, (quote: string, offset: number, source: string) => {
      if (/\b(?:word|text|transcript|term|wrote|typed|spelled|literal(?:ly)?)\b[^.!?\n]{0,35}$/iu.test(source.slice(Math.max(0, offset - 45), offset))) return quote;
      return quote.slice(0, -1).replace(/(?<=[\p{L}\p{N}])(?:\.{3,}|…+)[ \t]*$/gu, ".") + quote.slice(-1);
    })
    .replace(/\[laughing\](?:[ \t]*\[laughing\])+/giu, "[laughing]")
    .replace(/(?<![\p{L}\p{N}])(EXP|XP|HP|MP)\s*\/\s*(\d{1,6})?(?![\p{L}\p{N}])/giu, (_match, label: string, number?: string) =>
      number ? `${label.toUpperCase()}: ${speakInteger(Number(number))}` : label.toUpperCase());
  const normalizedValues = withoutMarkup
    .replace(/\$(\d+(?:,\d{3})*(?:\.\d+)?)([KMBT])\b/gi, (_match, amount: string, suffix: string) => {
      const scale = ({ K: "thousand", M: "million", B: "billion", T: "trillion" } as const)[suffix.toUpperCase() as "K" | "M" | "B" | "T"];
      return `${amount} ${scale} dollars`;
    })
    .replace(/\$(\d+(?:,\d{3})*(?:\.\d+)?)/g, "$1 dollars")
    .replace(/(\d+(?:\.\d+)?)%/g, "$1 percent")
    .replace(/\b(\d{1,2}):(\d{2})\s?(AM|PM)\b/gi, (_match, hour: string, minute: string, period: string) =>
      `${hour} ${minute === "00" ? "o'clock" : minute} ${period.toUpperCase().split("").join(".")}.`)
    .replace(/\b(\d{1,2})\s?(AM|PM)\b/gi, (_match, hour: string, period: string) => `${hour} ${period.toUpperCase().split("").join(".")}.`)
    .replace(/\bLv\.\s*(\d+)\b/gi, "Level $1")
    .replace(/\bvs\.(?=\s|$)/gi, "versus")
    .replace(/\betc\.(?=\s|$)/gi, "etcetera")
    .replace(/\be\.g\.(?=\s|$)/gi, "for example")
    .replace(/\bi\.e\.(?=\s|$)/gi, "that is")
    .replace(/&/g, " and ")
    .replace(/→|⇒/g, " leads to ")
    .replace(/←|⇐/g, " comes from ")
    .replace(/≥/g, " at least ")
    .replace(/≤/g, " at most ")
    .replace(/≈/g, " about ")
    .replace(/×/g, " times ")
    .replace(/\+/g, " plus ")
    .replace(/=/g, " equals ");

  // Spell out whole-number quantities so trailing zeroes and thousands commas
  // are not interpreted as separate digits. Leave decimals, times and IDs intact.
  const expandedValues = replaceAll(replaceAll(replaceAll(normalizedValues, TITLE_REPLACEMENTS), INITIALISM_REPLACEMENTS), UNIT_REPLACEMENTS);
  const spokenValues = expandedValues.replace(
    /(?<![\p{L}\p{N}_.,:/-])(?:\d{1,3}(?:,\d{3})+|\d{3,})(?![\p{L}\p{N}_]|[.,:/-]\d)/gu,
    (written) => {
      const value = Number(written.replaceAll(",", ""));
      return Number.isSafeInteger(value) && value <= 999_999_999 ? speakInteger(value) : written;
    },
  );
  return spokenValues
    .replace(/\b((?:[A-Z]\.){2,})\.(?=\s|$)/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Only discourse-word hesitation at a sentence/dialogue start is regularized. */
export function normalizeFishLeadingHesitations(text: string, model?: string): string {
  if (!isFishS2Model(model)) return text;
  return text.replace(/(^|[.!?\n“"‘']\s*)(Actually|Well|So|But|Uh|Um)(?:…|\.{3})(?=\s+\p{L})/gimu,
    (_match, prefix: string, word: string) => `${prefix}${word},`);
}

/** Experimental tsk direction is opt-in; the production fallback speaks the text. */
export function renderFishVocalizations(text: string, model?: string, options: { tskRendering?: "preserve" | "direction" } = {}): string {
  if (!isFishS2Model(model)) return text;
  let result = text;
  for (const item of scanVocalizations(text).reverse()) {
    const before = text.slice(Math.max(0, item.start - 45), item.start);
    if (/\b(?:word|text|transcript|term|wrote|typed|spelled|literal(?:ly)?)\b[^.!?\n]{0,35}$/iu.test(before)) continue;
    const openingReaction = /(?:^|[.!?…\n“"‘']\s*)$/u.test(before) && /[,!?.…]/u.test(item.sourceText);
    const replacement = item.vocalization === "throat_clear" ? "[cough]"
      : item.vocalization === "laugh" && item.confidence >= .8 && openingReaction ? "[laughing]"
      : item.vocalization === "chuckle" && /^(?:heh|ha)(?:\.{3,}|…+|[!,])$/iu.test(item.sourceText) && openingReaction ? "[chuckle]"
      : item.vocalization === "scoff" && /^tsk\b/iu.test(item.sourceText) && options.tskRendering === "direction" ? "[clicks tongue disapprovingly]"
      : undefined;
    if (replacement) result = result.slice(0, item.start) + replacement + result.slice(item.end);
  }
  return result;
}
