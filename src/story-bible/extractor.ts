import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { StoryBible, storyBibleUpdateSchema } from "../domain/story-bible.js";
import { extractedVisualObservationSchema } from "../domain/story-bible.js";
import { z } from "zod";
import { storyBibleInstructions } from "./prompts.js";
import { STORY_BIBLE_PROMPT_VERSION } from "./prompts.js";
import { fingerprint } from "../utils/hash.js";
import { resolveEntityVisualEvidence } from "./visual-evidence.js";
import { allIdentityRenderings, containsIdentityRendering } from "./entity-identity.js";

export const SOURCE_ONLY_STORY_BIBLE_PROMPT_VERSION = `${STORY_BIBLE_PROMPT_VERSION}-source-only-v1`;

export function storyBibleExtractionFingerprint(input: { source: string; translation: string; narration: string; config: StageModelConfig; bible: StoryBible; promptVersion?: string; sourceOnly?: boolean }) {
  return fingerprint({ source: fingerprint(input.source), translation: fingerprint(input.translation), narration: fingerprint(input.narration), config: input.config, prompt: input.promptVersion ?? (input.sourceOnly ? SOURCE_ONLY_STORY_BIBLE_PROMPT_VERSION : STORY_BIBLE_PROMPT_VERSION), context: input.bible });
}

export async function extractStoryBible(provider: LLMProvider, config: StageModelConfig, input: { chapter: number; source: string; translation: string; narration: string; bible: StoryBible; sourceOnly?: boolean }) {
  const { chapter, source, translation, narration, bible } = input;
  const contextBible = { ...bible, canonicalEntities: bible.canonicalEntities.map((entity) => {
    const resolved = resolveEntityVisualEvidence(entity, chapter - 1);
    const current = [...Object.values(resolved.values), ...Object.values(resolved.conflicts).flat()];
    return { ...entity, visualEvidence: current.map((item) => ({ ...item, provenance: item.provenance.slice(-2) })) };
  }) };
  const result = await provider.generateStructured({
    model: config.model,
    instructions: input.sourceOnly ? storyBibleInstructions + "\n\nSOURCE-ONLY MODE: No translation or narration exists for this extraction. Use the source chapter alone for facts, identity evidence and exact visual excerpts. Record each original spelling exactly. Reuse established canonical names; for new non-English names provide a faithful English rendering or transliteration, not an invented localized name. If the source is already English, preserve the names as written." : storyBibleInstructions,
    input: `CHAPTER NUMBER: ${chapter}\n\nSOURCE CHAPTER:\n${source}${input.sourceOnly ? "" : `\n\nTRANSLATION:\n${translation}\n\nNARRATION:\n${narration}`}\n\nESTABLISHED STORY BIBLE:\n${JSON.stringify(contextBible, null, 2)}`,
    schemaName: "story_bible_update",
    schema: storyBibleUpdateSchema,
  });
  const normalizedSource = (input.sourceOnly ? source : narration).replace(/\s+/g, " ").toLocaleLowerCase();
  result.value.visualObservations = (result.value.visualObservations ?? []).filter((observation) => normalizedSource.includes(observation.excerpt.replace(/\s+/g, " ").toLocaleLowerCase()));
  const hasIdentityEvidence = (text: string, names: Array<string | undefined | null>) =>
    names.some((name) => Boolean(name && containsIdentityRendering(text, name)));

  for (const category of ["characters", "locations", "factions", "abilities", "classes", "ranks", "items", "creatures", "systemTerms"] as const) {
    for (const entity of result.value[category]) {
      const names = [
        entity.canonicalEnglishName,
        entity.originalName,
        ...(category === "characters" ? (entity as typeof result.value.characters[number]).aliases : []),
      ];
      entity.identityEvidence = {
        seenInSource: hasIdentityEvidence(source, names),
        seenInTranslation: hasIdentityEvidence(translation, names),
        seenInNarration: hasIdentityEvidence(narration, names),
      };
    }
  }
  return result;
}

const visualOnlySchema = z.object({ visualObservations: z.array(extractedVisualObservationSchema).max(500) });

/** Explicit paid backfill path. Normal chronological rebuilds never call it. */
export async function extractChapterVisualObservations(provider: LLMProvider, config: StageModelConfig, chapter: number, narration: string, bible: StoryBible) {
  const relevant = bible.canonicalEntities
    .filter((entity) => allIdentityRenderings(entity).some((name) => containsIdentityRendering(narration, name)))
    .map((entity) => ({
      id: entity.id,
      name: entity.canonicalName,
      originalName: entity.originalName,
      aliases: entity.aliases,
      preferredNarrationName: entity.preferredNarrationName,
      type: entity.type,
    }));
  const result = await provider.generateStructured({
    model: config.model,
    schemaName: "story_bible_visual_backfill",
    schema: visualOnlySchema,
    instructions: `${storyBibleInstructions} Return only visualObservations. An excerpt must be an exact contiguous quote from the chapter. Use the canonical entity name from the supplied entity list (narration may use authorized narration renderings such as preferred narration names, but visual observations must cite the canonical entity name). Do not infer unstated colors, body traits, outfits, or permanence.`,
    input: JSON.stringify({ chapter, canonicalEntities: relevant, polishedChapter: narration }),
  });
  const normalizedSource = narration.replace(/\s+/g, " ").toLocaleLowerCase();
  return result.value.visualObservations.filter((item) => normalizedSource.includes(item.excerpt.replace(/\s+/g, " ").toLocaleLowerCase()));
}
