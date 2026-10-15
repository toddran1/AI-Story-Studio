import { pronunciationDictionarySchema, type PronunciationRule } from "../../domain/pronunciation-dictionary.js";
import { pronunciationMatches } from "../pronunciation-dictionary.js";
import { isFishS2Model } from "./control-cues.js";

/** Fish dictionary keys are substring matches. Render our word-bounded matches
 * as phoneme controls instead so a surname such as Li cannot alter Little. */
export function renderFishPronunciationDictionary(text: string, rules: readonly PronunciationRule[] = [], model?: string, protectedTerms: readonly string[] = []): string {
  if (!rules.length || !isFishS2Model(model)) return text;
  const valid = pronunciationDictionarySchema.parse(rules);
  const protectedSpans = protectedTerms.flatMap(term => pronunciationMatches(text, term));
  const matches = valid.flatMap(rule => pronunciationMatches(text, rule.text).map(span => ({ ...span, rule })));
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  let end = 0, output = "";
  for (const match of matches) {
    if (match.start < end || protectedSpans.some(span => span.start < match.end && span.end > match.start)) continue;
    const before = text.slice(0, match.start);
    // Never rewrite an existing phoneme instruction or a delivery/speaker tag.
    if (before.lastIndexOf("<|phoneme_start|>") > before.lastIndexOf("<|phoneme_end|>") || before.lastIndexOf("[") > before.lastIndexOf("]")) continue;
    const parts = match.rule.alphabet === "pinyin" ? match.rule.phonemes.split(/\s+/) : [match.rule.phonemes];
    const spoken = parts.map(part => `<|phoneme_start|>${part}<|phoneme_end|>`).join("");
    output += text.slice(end, match.start) + spoken; end = match.end;
  }
  return output + text.slice(end);
}
