import { pinyin } from "pinyin-pro";
import { hasActivePronunciation, type CanonicalEntity } from "../domain/story-bible.js";
import type { Story } from "../domain/story.js";
import type { PronunciationRule } from "../domain/pronunciation-dictionary.js";

export const PRONUNCIATION_DICTIONARY_VERSION = "story-pronunciation-dictionary-v1";
export type PronunciationPolicy = { sourceLanguage?: string; sourceLanguagePronunciation?: boolean; pronunciationDictionary?: PronunciationRule[] };
export function storyPronunciationPolicy(story: Story): PronunciationPolicy {
  return { sourceLanguage: story.sourceLanguage, sourceLanguagePronunciation: story.pipeline.tts.sourceLanguagePronunciation, pronunciationDictionary: story.pipeline.tts.pronunciationDictionary };
}
export function hasExplicitPronunciationGuidance(entity: CanonicalEntity): boolean {
  const value = entity.pronunciation;
  return Boolean(value && (value.source === "manual" || value.locked || value.customPronunciation || (hasActivePronunciation(value) && value.phoneticHint && (value.confidence === undefined || value.confidence >= .7))));
}
const romanized = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[\s'’\-1-5]/g, "");
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function pronunciationMatches(text: string, word: string): Array<{ start: number; end: number }> {
  return [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped(word)}(?![\\p{L}\\p{N}_])`, "giu"))].map(match => ({ start: match.index!, end: match.index! + match[0].length }));
}
/** Derived guidance is deliberately limited to source-backed Mandarin transliterations.
 * It never writes inferred pronunciations into protected canonical records. */
export function buildPronunciationDictionary(entities: readonly CanonicalEntity[], policy: PronunciationPolicy): PronunciationRule[] {
  const explicit = policy.pronunciationDictionary ?? [];
  const candidates = new Map<string, PronunciationRule[]>();
  if (policy.sourceLanguage && policy.sourceLanguagePronunciation !== false) for (const entity of entities) {
    const pronunciation = entity.pronunciation;
    if (hasExplicitPronunciationGuidance(entity)) continue;
    const language = pronunciation?.sourceLanguage ?? policy.sourceLanguage ?? "";
    // A Chinese source language is not evidence for Cantonese or another regional dialect.
    if (!/^(?:zh(?:-(?:CN|TW|HK|SG|Hant|Hans))?|cmn(?:-[A-Za-z0-9]+)*)$/i.test(language)) continue;
    const original = entity.originalName;
    if (!/^\p{Script=Han}{2,12}$/u.test(original)) continue;
    const sounds = pinyin(original, { toneType: "num", type: "array", surname: entity.type === "character" ? "head" : "off", toneSandhi: false, traditional: true }).map(syllable => /[1-5]$/.test(syllable) ? syllable : `${syllable}5`);
    if (!sounds.every(syllable => /^[a-züv:]+[1-5]$/u.test(syllable))) continue;
    for (const text of new Set([entity.canonicalName, ...entity.aliases, entity.preferredNarrationName].filter((name): name is string => Boolean(name)))) {
      if ([entity.localizedNaming?.fullName, entity.localizedNaming?.shortName].some(name => name?.toLowerCase() === text.toLowerCase())) continue;
      if (romanized(text) !== romanized(sounds.join(""))) continue;
      const rule: PronunciationRule = { text, alphabet: "pinyin", phonemes: sounds.join(" ") };
      const key = text.toLowerCase(); candidates.set(key, [...(candidates.get(key) ?? []), rule]);
      // Reuse an unambiguous surname across names and title forms. Avoid words
      // such as He, Long and Sun that also occur in ordinary English prose.
      const surname = text.split(/\s+/)[0]!;
      const ordinary = new Set("he an long you fan may song sun fang young king man le to on in do no".split(" "));
      if (entity.type === "character" && text.includes(" ") && romanized(surname) === romanized(sounds[0]!) && !ordinary.has(surname.toLowerCase())) {
        const root: PronunciationRule = { text: surname, alphabet: "pinyin", phonemes: sounds[0]! };
        const rootKey = surname.toLowerCase(); candidates.set(rootKey, [...(candidates.get(rootKey) ?? []), root]);
      }
    }
  }
  const localizedNames = entities.flatMap(entity => [entity.localizedNaming?.fullName, entity.localizedNaming?.shortName].filter((name): name is string => Boolean(name)));
  const rules = [...candidates.values()].flatMap(items => new Set(items.map(item => item.phonemes)).size === 1 ? [items[0]!] : []);
  // Explicit story rules override derived defaults. A longer entity pronunciation
  // is handled by the existing entity wrapper before provider phoneme rendering.
  return [...rules.filter(rule => !explicit.some(item => pronunciationMatches(rule.text, item.text).length > 0) && !localizedNames.some(name => pronunciationMatches(name, rule.text).length > 0)), ...explicit].sort((a, b) => a.text.localeCompare(b.text));
}
export function dictionaryForText(text: string, rules: readonly PronunciationRule[]): PronunciationRule[] {
  return rules.filter(rule => pronunciationMatches(text, rule.text).length > 0);
}
