import { z } from "zod";

export const entityTypeSchema = z.enum(["character", "location", "organization", "ability", "item", "concept", "other"]);
export type EntityType = z.infer<typeof entityTypeSchema>;
export const factOriginSchema = z.enum(["automatic", "manual"]);
export const provenanceSchema = z.object({ chapter: z.number().int().positive(), kind: z.enum(["extraction", "event", "relationship", "manual"]), confidence: z.number().min(0).max(1).optional(), origin: factOriginSchema.default("automatic") });
export const aliasNarrationRuleSchema = z.object({
  alias: z.string().trim().min(1).max(300),
  behavior: z.enum(["no_override", "use_preferred", "custom"]),
  replacement: z.string().trim().min(1).max(300).optional(),
}).superRefine((value, context) => { if (value.behavior === "custom" && !value.replacement) context.addIssue({ code: "custom", message: "A custom narration replacement is required", path: ["replacement"] }); });

export const localizedNamingSchema = z.object({
  locale: z.string().trim().min(2).max(35).regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "Use a language or locale such as en-US"),
  fullName: z.string().trim().min(1).max(300).optional(),
  shortName: z.string().trim().min(1).max(300).optional(),
  usageMode: z.enum(["ai_contextual", "always_full", "always_short", "manual"]),
  notes: z.string().trim().max(5_000).optional(),
}).superRefine((value, context) => {
  if (!value.fullName && !value.shortName) context.addIssue({ code: "custom", message: "Provide a localized full or short name", path: ["fullName"] });
  if (value.usageMode === "always_full" && !value.fullName) context.addIssue({ code: "custom", message: "Always full requires a full name", path: ["fullName"] });
  if (value.usageMode === "always_short" && !value.shortName) context.addIssue({ code: "custom", message: "Always short requires a short name", path: ["shortName"] });
});
export type LocalizedNaming = z.infer<typeof localizedNamingSchema>;

export const pronunciationSchema = z.object({
  sourceLanguage: z.string().trim().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).optional(),
  originalText: z.string().trim().min(1).max(300).optional(),
  romanization: z.string().trim().min(1).max(300).optional(),
  ipa: z.string().trim().min(1).max(500).optional(),
  phoneticHint: z.string().trim().min(1).max(500).regex(/^[^<>\[\]]+$/, "Use spoken sounds, not provider control tags").optional(),
  mode: z.enum(["automatic", "original_language", "custom"]),
  customPronunciation: z.string().trim().min(1).max(500).regex(/^[^<>\[\]]+$/, "Use spoken sounds, not provider control tags").optional(),
  locked: z.boolean().optional(), confidence: z.number().min(0).max(1).optional(),
  needsReview: z.boolean().optional(),
  evidence: z.array(z.object({ chapter: z.number().int().positive(), sourceText: z.string().trim().min(1).max(1_000), reason: z.string().trim().min(1).max(500) })).max(8).optional(),
  source: z.enum(["ai", "manual", "imported"]).optional(), updatedAt: z.string().datetime().optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "custom" && !value.customPronunciation) context.addIssue({ code: "custom", path: ["customPronunciation"], message: "Custom pronunciation requires a spoken form" });
});
export type EntityPronunciation = z.infer<typeof pronunciationSchema>;

/**
 * Pronunciation is opt-in: only an explicit user configuration steers TTS and
 * creates QA obligations. `undefined` means default provider pronunciation.
 * Unresolved automatic AI records (never user-accepted) are suggestions, not
 * configuration; confident AI records already in effect stay active.
 */
export function hasActivePronunciation(pronunciation: EntityPronunciation | undefined): boolean {
  if (!pronunciation) return false;
  if (pronunciation.source === "manual" || pronunciation.locked) return true;
  return !(pronunciation.source === "ai" && pronunciation.mode === "automatic" && pronunciation.needsReview === true);
}

const namedEntity = z.object({
  canonicalEnglishName: z.string().min(1).max(300), originalName: z.string().max(300).default(""), description: z.string().max(10_000).default(""),
  firstSeenChapter: z.number().int().positive(), lastSeenChapter: z.number().int().positive(),
  status: z.string().max(500).optional(), notes: z.string().max(10_000).optional(), confidence: z.number().min(0).max(1).optional(),
  identityEvidence: z.object({ seenInSource: z.boolean(), seenInTranslation: z.boolean(), seenInNarration: z.boolean() }).nullish(),
});
const character = namedEntity.extend({ aliases: z.array(z.string().min(1).max(300)).max(100).default([]), gender: z.string().max(100).optional(), pronouns: z.array(z.string().max(100)).max(20).default([]) });
const relationship = z.object({
  subject: z.string().min(1).max(300), object: z.string().min(1).max(300), relationship: z.string().min(1).max(300), firstSeenChapter: z.number().int().positive(), lastSeenChapter: z.number().int().positive(),
  endChapter: z.number().int().positive().optional(), state: z.enum(["current", "historical"]).optional(), confidence: z.number().min(0).max(1).optional(), locked: z.boolean().optional(),
});
const translationTerm = z.object({ original: z.string().min(1).max(500), canonicalEnglish: z.string().min(1).max(500), notes: z.string().max(10_000).default(""), firstSeenChapter: z.number().int().positive(), lastSeenChapter: z.number().int().positive(), locked: z.boolean().optional() });

export const extractedTimelineEventSchema = z.object({
  entity: z.string().min(1).max(300), type: z.enum(["appearance", "location", "relationship_change", "ability_gained", "ability_lost", "injury", "death", "resurrection", "rank_change", "title_change", "organization_membership", "possession", "revelation", "status_change"]),
  summary: z.string().min(1).max(1000), relatedEntity: z.string().max(300).optional(), status: z.string().max(500).optional(), chapter: z.number().int().positive(), confidence: z.number().min(0).max(1).optional(),
});

export const visualEvidenceFieldSchema = z.enum([
  "character.apparentAge", "character.gender", "character.height", "character.build", "character.skinTone", "character.faceShape", "character.eyeColor", "character.hairColor", "character.hairstyle", "character.facialHair", "character.distinguishingFeatures", "character.scars", "character.tattoos", "character.defaultOutfit", "character.shoes", "character.accessories", "character.weapons", "character.equipment", "character.additionalAppearanceNotes",
  "location.environmentDescription", "location.architecture", "location.terrain", "location.vegetation", "location.weatherTendencies", "location.lighting", "location.atmosphere", "location.colorPalette", "location.recurringLandmarks", "location.canonicalEnvironmentPrompt",
  "creature.species", "creature.scale", "creature.anatomy", "creature.coloration", "creature.eyes", "creature.armorFur", "creature.distinguishingFeatures", "creature.sizeRelativeToHuman", "creature.canonicalCreaturePrompt",
  "item.shape", "item.materials", "item.dimensions", "item.color", "item.ornamentation", "item.wearDamage", "item.magicalEffects", "item.canonicalObjectPrompt",
]);
export const extractedVisualObservationSchema = z.object({
  entity: z.string().trim().min(1).max(300), field: visualEvidenceFieldSchema,
  value: z.string().trim().min(1).max(1000), chapter: z.number().int().positive(),
  confidence: z.number().min(0).max(1), persistence: z.enum(["persistent", "changed", "temporary"]),
  excerpt: z.string().trim().min(1).max(500),
});
export type ExtractedVisualObservation = z.infer<typeof extractedVisualObservationSchema>;
export const visualEvidenceSchema = z.object({
  id: z.string().regex(/^ve_[a-f0-9]{24}$/), field: visualEvidenceFieldSchema,
  value: z.string().trim().min(1).max(1000), normalizedValue: z.string().min(1).max(1000),
  chapter: z.number().int().positive(), lastObservedChapter: z.number().int().positive(),
  confidence: z.number().min(0).max(1), persistence: extractedVisualObservationSchema.shape.persistence,
  status: z.enum(["current", "historical", "conflict", "temporary"]),
  source: z.enum(["source_text", "story_bible", "manual"]),
  provenance: z.array(z.object({ chapter: z.number().int().positive(), excerpt: z.string().trim().min(1).max(500), confidence: z.number().min(0).max(1) })).min(1),
});
export type VisualEvidence = z.infer<typeof visualEvidenceSchema>;
export const visualEvidenceDecisionSchema = z.object({ field: visualEvidenceFieldSchema, evidenceId: visualEvidenceSchema.shape.id, action: z.enum(["select", "change", "dismiss"]), decidedAt: z.string().datetime() });
export type VisualEvidenceDecision = z.infer<typeof visualEvidenceDecisionSchema>;

export const storyBibleUpdateSchema = z.object({
  characters: z.array(character).max(2000).default([]), locations: z.array(namedEntity).max(2000).default([]), factions: z.array(namedEntity).max(2000).default([]), abilities: z.array(namedEntity).max(2000).default([]),
  classes: z.array(namedEntity).max(2000).default([]), ranks: z.array(namedEntity).max(2000).default([]), items: z.array(namedEntity).max(2000).default([]), creatures: z.array(namedEntity).max(2000).default([]), systemTerms: z.array(namedEntity).max(2000).default([]),
  relationships: z.array(relationship).max(2000).default([]), translationTerms: z.array(translationTerm).max(2000).default([]), timelineEvents: z.array(extractedTimelineEventSchema).max(2000).default([]), visualObservations: z.array(extractedVisualObservationSchema).max(2000).default([]), chapterSummary: z.string().min(1).max(20_000),
});

export const canonicalEntitySchema = z.object({
  id: z.string().regex(/^ent_[a-f0-9]{24}$/), type: entityTypeSchema, canonicalName: z.string().min(1).max(300), aliases: z.array(z.string().min(1).max(300)).max(100).default([]), originalName: z.string().max(300).default(""), description: z.string().max(10_000).default(""),
  sourceBucket: z.enum(["characters", "locations", "factions", "abilities", "items", "creatures", "classes", "ranks", "systemTerms"]).optional(),
  preferredNarrationName: z.string().trim().min(1).max(300).optional(), aliasNarrationRules: z.array(aliasNarrationRuleSchema).max(100).default([]),
  localizedNaming: localizedNamingSchema.optional(),
  pronunciation: pronunciationSchema.optional(),
  // A deliberate production decision, stored with the canonical identity rather
  // than encoded as a fake empty Visual Profile.
  visualProfilePolicy: z.object({ mode: z.enum(["prompt", "skip"]) }).optional(),
  firstAppearance: z.number().int().positive(), lastKnownAppearance: z.number().int().positive(), status: z.string().max(500).default("unknown"), notes: z.string().max(10_000).default(""), canonicalNameLocked: z.boolean().default(false),
  origin: factOriginSchema.default("automatic"), provenance: z.array(provenanceSchema).default([]), mergedFromIds: z.array(z.string()).default([]), visualEvidence: z.array(visualEvidenceSchema).optional(), visualEvidenceDecisions: z.array(visualEvidenceDecisionSchema).optional(),
});
export type CanonicalEntity = z.infer<typeof canonicalEntitySchema>;
export const timelineEventSchema = z.object({
  id: z.string().regex(/^evt_[a-f0-9]{24}$/), entityId: z.string(), chapter: z.number().int().positive(), type: extractedTimelineEventSchema.shape.type, summary: z.string().min(1).max(1000), relatedEntityId: z.string().optional(), status: z.string().optional(), confidence: z.number().min(0).max(1).optional(), origin: factOriginSchema.default("automatic"), provenance: provenanceSchema,
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export const canonicalRelationshipSchema = z.object({
  id: z.string().regex(/^rel_[a-f0-9]{24}$/), sourceEntityId: z.string(), targetEntityId: z.string(), type: z.string().min(1).max(300), startChapter: z.number().int().positive(), endChapter: z.number().int().positive().optional(), state: z.enum(["current", "historical"]).default("current"), confidence: z.number().min(0).max(1).optional(), provenance: z.array(provenanceSchema).default([]), locked: z.boolean().default(false), origin: factOriginSchema.default("automatic"),
});
export type CanonicalRelationship = z.infer<typeof canonicalRelationshipSchema>;
export const mergeRecordSchema = z.object({ id: z.string().uuid(), targetEntityId: z.string(), sourceEntityIds: z.array(z.string()).min(1), reason: z.string(), kind: z.enum(["standard", "narration_rendering_duplicate"]).default("standard"), createdAt: z.string(), undoneAt: z.string().optional() });

export const persistenceDispositionSchema = z.enum(["canonical", "minor_reference", "merge_existing", "needs_review"]);
export type PersistenceDisposition = z.infer<typeof persistenceDispositionSchema>;

export const minorEntityReferenceSchema = z.object({
  id: z.string().min(1).max(300),
  name: z.string().trim().min(1).max(300),
  originalName: z.string().max(300).optional(),
  type: z.enum(["location", "item", "character", "organization", "ability", "concept", "other"]).optional(),
  parentEntityId: z.string().optional(),
  aliases: z.array(z.string().min(1).max(300)).max(100).default([]),
  firstSeenChapter: z.number().int().positive().optional(),
  lastSeenChapter: z.number().int().positive().optional(),
  occurrenceCount: z.number().int().positive().default(1),
  sourceEvidence: z.array(z.object({
    chapter: z.number().int().positive(),
    excerpt: z.string().max(1000).optional(),
  })).max(20).default([]),
  confidence: z.number().min(0).max(1).optional(),
  significanceScore: z.number().min(0).max(100).optional(),
  disposition: persistenceDispositionSchema.optional().default("minor_reference"),
  source: z.enum(["automatic", "manual_demotion"]).optional().default("automatic"),
  contextNotes: z.string().max(1000).optional(),
  status: z.enum(["minor", "promotion_candidate"]).optional().default("minor"),
  demotedFromEntityId: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type MinorEntityReference = z.infer<typeof minorEntityReferenceSchema>;

export const granularityAuditSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["promoted", "demoted", "merged", "kept"]),
  fromEntityId: z.string().optional(),
  toEntityId: z.string().optional(),
  parentEntityId: z.string().optional(),
  referenceId: z.string().optional(),
  name: z.string(),
  reason: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source: z.enum(["automatic", "ai", "manual", "analyzer"]),
  timestamp: z.string(),
});
export type GranularityAudit = z.infer<typeof granularityAuditSchema>;

export const storyBibleSchema = storyBibleUpdateSchema.extend({
  version: z.number().int().nonnegative().default(0), chapterSummaries: z.record(z.string(), z.string()).default({}), canonicalEntities: z.array(canonicalEntitySchema).default([]),
  canonicalRelationships: z.array(canonicalRelationshipSchema).default([]), entityTimeline: z.array(timelineEventSchema).default([]), merges: z.array(mergeRecordSchema).default([]),
  minorReferences: z.array(minorEntityReferenceSchema).default([]), granularityAudits: z.array(granularityAuditSchema).default([]),
}).omit({ chapterSummary: true, timelineEvents: true, visualObservations: true });

export type StoryBibleUpdate = z.infer<typeof storyBibleUpdateSchema>;
export type StoryBible = z.infer<typeof storyBibleSchema>;
export const emptyStoryBible = (): StoryBible => storyBibleSchema.parse({});
