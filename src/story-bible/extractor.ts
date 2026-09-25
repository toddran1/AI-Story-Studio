import { LLMProvider } from "../llm/provider.js";
import { StageModelConfig } from "../domain/provider.js";
import { StoryBible, storyBibleUpdateSchema } from "../domain/story-bible.js";
import { extractedVisualObservationSchema } from "../domain/story-bible.js";
import { z } from "zod";
import { storyBibleInstructions } from "./prompts.js";
import { resolveEntityVisualEvidence } from "./visual-evidence.js";

export async function extractStoryBible(provider: LLMProvider, config: StageModelConfig, chapter: number, narration: string, bible: StoryBible) {
  const contextBible = { ...bible, canonicalEntities: bible.canonicalEntities.map((entity) => {
    const resolved = resolveEntityVisualEvidence(entity, chapter - 1);
    const current = [...Object.values(resolved.values), ...Object.values(resolved.conflicts).flat()];
    return { ...entity, visualEvidence: current.map((item) => ({ ...item, provenance: item.provenance.slice(-2) })) };
  }) };
  const result = await provider.generateStructured({
    model: config.model,
    instructions: storyBibleInstructions,
    input: `CHAPTER NUMBER: ${chapter}\n\nESTABLISHED STORY BIBLE:\n${JSON.stringify(contextBible, null, 2)}\n\nPOLISHED CHAPTER:\n${narration}`,
    schemaName: "story_bible_update",
    schema: storyBibleUpdateSchema,
  });
  const normalizedSource = narration.replace(/\s+/g, " ").toLocaleLowerCase();
  result.value.visualObservations = (result.value.visualObservations ?? []).filter((observation) => normalizedSource.includes(observation.excerpt.replace(/\s+/g, " ").toLocaleLowerCase()));
  return result;
}

const visualOnlySchema = z.object({ visualObservations: z.array(extractedVisualObservationSchema).max(500) });

/** Explicit paid backfill path. Normal chronological rebuilds never call it. */
export async function extractChapterVisualObservations(provider: LLMProvider, config: StageModelConfig, chapter: number, narration: string, bible: StoryBible) {
  const lower = narration.toLocaleLowerCase();
  const relevant = bible.canonicalEntities.filter((entity) => [entity.canonicalName, entity.originalName, ...entity.aliases].some((name) => name && lower.includes(name.toLocaleLowerCase()))).map((entity) => ({ id: entity.id, name: entity.canonicalName, originalName: entity.originalName, aliases: entity.aliases, type: entity.type }));
  const result = await provider.generateStructured({
    model: config.model, schemaName: "story_bible_visual_backfill", schema: visualOnlySchema,
    instructions: `${storyBibleInstructions} Return only visualObservations. An excerpt must be an exact contiguous quote from the chapter. Use the canonical entity name from the supplied entity list. Do not infer unstated colors, body traits, outfits, or permanence.`,
    input: JSON.stringify({ chapter, canonicalEntities: relevant, polishedChapter: narration }),
  });
  const normalizedSource = narration.replace(/\s+/g, " ").toLocaleLowerCase();
  return result.value.visualObservations.filter((item) => normalizedSource.includes(item.excerpt.replace(/\s+/g, " ").toLocaleLowerCase()));
}
