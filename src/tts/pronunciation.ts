import { z } from "zod";
import { pronunciationSchema, type CanonicalEntity, type EntityPronunciation } from "../domain/story-bible.js";
import type { LLMProvider } from "../llm/provider.js";
import type { StageModelConfig } from "../domain/provider.js";
import { fingerprint } from "../utils/hash.js";
import type { TTSProvider } from "./provider.js";

export const PRONUNCIATION_VERSION = "pronunciation-v1";
export type PronunciationOccurrence = {
  entityId: string; surfaceText: string; start: number; end: number;
  canonicalName?: string;
  pronunciation: EntityPronunciation;
};
export type PronunciationCapabilities = { ipa?: boolean; dictionary?: boolean; ssml?: boolean; languageTags?: boolean; phoneticText?: boolean };

/** Resolve again for each actual request, so censor splitting cannot corrupt offsets. */
export function pronunciationProvider(provider: TTSProvider, entities: readonly CanonicalEntity[]): TTSProvider {
  if (!entities.some(entity => entity.pronunciation)) return provider;
  return {
    name: provider.name, inputNormalizationVersion: provider.inputNormalizationVersion,
    pronunciationCapabilities: provider.pronunciationCapabilities,
    resolveReferenceId: provider.resolveReferenceId?.bind(provider),
    validateConfiguration: () => provider.validateConfiguration(),
    synthesize: request => provider.synthesize({ ...request, pronunciation: resolvePronunciations(request.text, entities) }),
  };
}

/** Resolve exact, bounded identity references; ambiguous aliases are deliberately left alone. */
export function resolvePronunciations(text: string, entities: readonly CanonicalEntity[]): PronunciationOccurrence[] {
  const candidates: PronunciationOccurrence[] = [];
  for (const entity of entities) {
    const placeRoot = entity.type === "location" ? entity.canonicalName.replace(/\s+(City|Town|Village|Province)$/i, "") : undefined;
    const names = new Set([entity.canonicalName, placeRoot, entity.originalName, ...entity.aliases,
      entity.preferredNarrationName, entity.localizedNaming?.fullName, entity.localizedNaming?.shortName,
      ...entity.aliasNarrationRules.filter(rule => rule.behavior === "custom").map(rule => rule.replacement)].filter((name): name is string => Boolean(name)));
    for (const name of names) {
      const pattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
      for (const match of text.matchAll(pattern)) {
        const start = match.index!, end = start + match[0].length;
        if (/[\p{L}\p{N}]/u.test(text.slice(Math.max(0, start - 1), start)) || /[\p{L}\p{N}]/u.test(text.slice(end, end + 1))) continue;
        const localized = [entity.localizedNaming?.fullName, entity.localizedNaming?.shortName].some(value => value?.toLocaleLowerCase() === name.toLocaleLowerCase());
        // Automatic source-language hints must not turn a localized English name back into its source name.
        const preferred = entity.preferredNarrationName?.toLocaleLowerCase() === name.toLocaleLowerCase() && name.toLocaleLowerCase() !== entity.canonicalName.toLocaleLowerCase();
        const pronunciation = entity.pronunciation ?? { mode: "automatic" as const };
        if ((localized || preferred) && pronunciation.mode === "automatic") continue;
        candidates.push({ entityId: entity.id, surfaceText: match[0], start, end, pronunciation, canonicalName: entity.canonicalName });
      }
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const result: PronunciationOccurrence[] = [];
  for (const candidate of candidates) {
    if (candidates.some(other => other.entityId !== candidate.entityId && other.start < candidate.end && other.end > candidate.start)) continue;
    if (result.some(other => other.start < candidate.end && other.end > candidate.start)) continue;
    if (entities.find(entity => entity.id === candidate.entityId)?.pronunciation) result.push(candidate);
  }
  return result;
}

/** Only sound-relevant fields and referenced identities affect reuse. */
export function pronunciationFingerprint(occurrences: readonly PronunciationOccurrence[]): string | undefined {
  if (!occurrences.length) return undefined;
  return fingerprint({ version: PRONUNCIATION_VERSION, occurrences: occurrences.map(({ entityId, canonicalName, surfaceText, start, end, pronunciation: p }) => ({
    entityId, canonicalName, surfaceText, start, end, language: p.sourceLanguage, original: p.originalText,
    romanization: p.romanization, ipa: p.ipa, hint: p.phoneticHint, mode: p.mode, custom: p.customPronunciation, hintEnabled: p.confidence === undefined || p.confidence >= .7,
  })) });
}

/** Provider fallback works on a separate synthesis string, never the stored manuscript. */
export function adaptPronunciationText(text: string, occurrences: readonly PronunciationOccurrence[], capabilities: PronunciationCapabilities): string {
  if (!capabilities.phoneticText) return text;
  let result = text;
  for (const occurrence of [...occurrences].sort((a, b) => b.start - a.start)) {
    if (text.slice(occurrence.start, occurrence.end) !== occurrence.surfaceText) continue;
    const p = occurrence.pronunciation;
    const spoken = p.mode === "custom" ? p.customPronunciation : (p.confidence !== undefined && p.confidence < .7 ? undefined : p.phoneticHint);
    // Romanization is metadata, not automatically an English phonetic spelling.
    if (spoken) {
      // A translated place suffix remains audible; hints describe the foreign root.
      const suffix = /\s+(City|Town|Village|Province)$/i.exec(occurrence.surfaceText)?.[0];
      let rendered = suffix && !spoken.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase()) ? spoken + suffix : spoken;
      const title = /^(Mr\.?|Mrs\.?|Ms\.?|Brother|Sister|Master|Senior|Junior)\s+(.+)$/i.exec(occurrence.surfaceText);
      if (title && occurrence.canonicalName && occurrence.surfaceText !== occurrence.canonicalName) {
        const roots = occurrence.canonicalName.split(/\s+/), hints = spoken.split(/\s+/);
        const position = roots.findIndex(root => root.toLocaleLowerCase() === title[2]!.toLocaleLowerCase());
        // Only reuse a partial root where the hint has an unambiguous token mapping.
        if (position < 0 || roots.length !== hints.length) continue;
        rendered = `${title[1]} ${hints[position]}`;
      }
      result = result.slice(0, occurrence.start) + rendered + result.slice(occurrence.end);
    }
  }
  return result;
}

export async function enrichPronunciation(provider: LLMProvider, config: StageModelConfig, entity: CanonicalEntity, sourceLanguage: string) {
  if (entity.pronunciation?.locked || entity.pronunciation?.source === "manual" || (entity.pronunciation && entity.pronunciation.mode !== "automatic")) return { pronunciation: entity.pronunciation };
  const result = await provider.generateStructured({ model: config.model, schemaName: "entity_pronunciation", schema: z.object({ pronunciation: pronunciationSchema.nullable() }),
    instructions: "Enrich one foreign story entity for pronunciation inside English narration. Return null for ordinary translated English terms. Infer the actual source language from script, original name and context; do not assume all names are Mandarin. Provide romanization and a practical English-readable phoneticHint when confident; otherwise omit guessed hints and report low confidence. Keep identity and localized display names unchanged. Use automatic mode and ai source. Never put provider-specific control tags in metadata.",
    input: JSON.stringify({ entity, storySourceLanguage: sourceLanguage }) });
  return { pronunciation: result.value.pronunciation ?? undefined, usage: result.usage };
}
