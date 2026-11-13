import { pinyin } from "pinyin-pro";
import { hasActivePronunciation, type CanonicalEntity } from "../domain/story-bible.js";
import type { Story } from "../domain/story.js";
import type { PronunciationRule } from "../domain/pronunciation-dictionary.js";

export const PRONUNCIATION_DICTIONARY_VERSION = "story-pronunciation-dictionary-v2-entity-names";
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

export function splitPronunciationTitle(text: string) {
  const match = /^((?:(?:Senior|Junior|Elder|Younger|Big|Little)\s+(?:Brother|Sister)|Young\s+Master|Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Miss|Brother|Sister|Master|Senior|Junior|Elder|Doctor|Professor|Captain|General|Lord|Lady|Sir|Madam)\s+)(.+)$/iu.exec(text);
  return match ? { prefix: match[1]!, name: match[2]! } : undefined;
}

function entityNames(entity: CanonicalEntity) {
  return [entity.canonicalName, entity.originalName, ...entity.aliases, entity.preferredNarrationName, entity.localizedNaming?.fullName, entity.localizedNaming?.shortName,
    ...entity.aliasNarrationRules.map(rule => rule.replacement)].filter((name): name is string => Boolean(name));
}
/** Derived guidance is deliberately limited to source-backed Mandarin transliterations.
 * It never writes inferred pronunciations into protected canonical records. */
export function buildPronunciationDictionary(entities: readonly CanonicalEntity[], policy: PronunciationPolicy, conflicts?: Record<string, string[]>): PronunciationRule[] {
  const explicit = policy.pronunciationDictionary ?? [];
  const candidates = new Map<string, PronunciationRule[]>();
  const owners = new Map<string, Set<string>>();
  for (const entity of entities) for (const name of entityNames(entity)) {
    const key = name.toLowerCase();
    const ids = owners.get(key) ?? new Set<string>();
    ids.add(entity.id);
    owners.set(key, ids);
  }
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
      const key = text.toLowerCase();
      if (owners.get(key)?.size !== 1) continue;
      const title = splitPronunciationTitle(text);
      const name = romanized(title?.name ?? text);
      const fullName = romanized(sounds.join(""));
      // A partial title alias needs an independently verified full name. A
      // translated source title such as 業哥 does not establish that mapping.
      const matched = fullName === name ? [sounds] : title && romanized(entity.canonicalName) === fullName ? sounds.flatMap((_, start) => sounds.slice(start).flatMap((_, offset) => {
        const part = sounds.slice(start, start + offset + 1);
        return romanized(part.join("")) === name ? [part] : [];
      })) : [];
      if (matched.length !== 1) continue;
      const rule: PronunciationRule = { text, alphabet: "pinyin", phonemes: matched[0]!.join(" ") };
      candidates.set(key, [...(candidates.get(key) ?? []), rule]);
    }
  }
  const localizedNames = entities.flatMap(entity => [entity.localizedNaming?.fullName, entity.localizedNaming?.shortName].filter((name): name is string => Boolean(name)));
  const rules = [...candidates.values()].flatMap(items => new Set(items.map(item => item.phonemes)).size === 1 ? [items[0]!] : []);
  // Explicit story rules override derived defaults. A longer entity pronunciation
  // is handled by the existing entity wrapper before provider phoneme rendering.
  const derived = rules.filter(rule => !explicit.some(item => pronunciationMatches(rule.text, item.text).length > 0) && !localizedNames.some(name => pronunciationMatches(name, rule.text).length > 0));
  if (conflicts) for (const rule of derived) {
    const key = rule.text.toLowerCase();
    const owner = [...owners.get(key)!][0]!;
    const blocked = [...owners].filter(([name, ids]) => name.length > key.length && name.includes(key) && [...ids].some(id => id !== owner) && pronunciationMatches(name, key).length > 0).map(([name]) => name);
    if (blocked.length) conflicts[key] = blocked;
  }
  return [...derived, ...explicit].sort((a, b) => a.text.localeCompare(b.text));
}
export function dictionaryForText(text: string, rules: readonly PronunciationRule[]): PronunciationRule[] {
  return rules.filter(rule => pronunciationMatches(text, rule.text).length > 0);
}
