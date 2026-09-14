import { z } from "zod";
import { CanonicalEntity } from "../domain/story-bible.js";
import { StageModelConfig } from "../domain/provider.js";
import { LLMProvider } from "../llm/provider.js";

export const localizedNameSuggestionSchema = z.object({
  fullName: z.string().trim().min(1).max(300),
  shortName: z.string().trim().min(1).max(300).optional(),
  rationale: z.string().trim().min(1).max(500),
});
export const localizedNameSuggestionsSchema = z.object({ suggestions: z.array(localizedNameSuggestionSchema).min(1).max(8) });
export const localizationSuggestionRequestSchema = z.object({
  locale: z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).optional(),
  count: z.number().int().min(3).max(8).default(5),
}).strict();
export type LocalizedNameSuggestion = z.infer<typeof localizedNameSuggestionSchema>;

export async function generateLocalizedNameSuggestions(
  provider: LLMProvider,
  config: StageModelConfig,
  input: {
    entity: CanonicalEntity;
    sourceLanguage: string;
    targetLanguage: string;
    locale: string;
    count: number;
    relationships?: Array<{ relation: string; otherEntity: string }>;
  },
) {
  const result = await provider.generateStructured({
    model: config.model,
    schemaName: "entity_name_localization",
    schema: localizedNameSuggestionsSchema,
    instructions: `Suggest ${input.count} natural localized names for one story entity. The source language is ${input.sourceLanguage}; the target language is ${input.targetLanguage}; the target locale is ${input.locale}. Respect the locale rather than assuming American naming conventions. Preserve the entity's identity, role, tone, setting, gender signals, relationships, and genre fit. Do not translate mechanically or merely repeat the canonical name unless that is genuinely the strongest localized choice. For characters, return a natural fullName and, when appropriate, the shortName people would use in established narration or familiar dialogue. For locations, organizations, abilities, items, and concepts, fullName is the preferred localized label and shortName is an optional natural shorthand. Make every suggestion distinct and give a brief practical rationale. Return only the requested structured data.`,
    input: JSON.stringify({
      originalName: input.entity.originalName,
      canonicalName: input.entity.canonicalName,
      entityType: input.entity.type,
      description: input.entity.description,
      statusOrRole: input.entity.status,
      notes: input.entity.notes,
      aliases: input.entity.aliases,
      appearances: { first: input.entity.firstAppearance, lastKnown: input.entity.lastKnownAppearance },
      relationships: input.relationships ?? [],
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      targetLocale: input.locale,
    }, null, 2),
  });
  return { suggestions: result.value.suggestions.slice(0, input.count), usage: result.usage };
}
