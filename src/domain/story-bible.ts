import { z } from "zod";

export const entityTypeSchema = z.enum(["character", "location", "organization", "ability", "item", "concept"]);
export type EntityType = z.infer<typeof entityTypeSchema>;
export const factOriginSchema = z.enum(["automatic", "manual"]);
export const provenanceSchema = z.object({ chapter: z.number().int().positive(), kind: z.enum(["extraction", "event", "relationship", "manual"]), confidence: z.number().min(0).max(1).optional(), origin: factOriginSchema.default("automatic") });

const namedEntity = z.object({
  canonicalEnglishName: z.string().min(1), originalName: z.string().default(""), description: z.string().default(""),
  firstSeenChapter: z.number().int().positive(), lastSeenChapter: z.number().int().positive(),
  status: z.string().optional(), notes: z.string().optional(), confidence: z.number().min(0).max(1).optional(),
});
const character = namedEntity.extend({ aliases: z.array(z.string()).default([]), gender: z.string().optional(), pronouns: z.array(z.string()).default([]) });
const relationship = z.object({
  subject: z.string().min(1), object: z.string().min(1), relationship: z.string().min(1), firstSeenChapter: z.number().int().positive(), lastSeenChapter: z.number().int().positive(),
  endChapter: z.number().int().positive().optional(), state: z.enum(["current", "historical"]).optional(), confidence: z.number().min(0).max(1).optional(), locked: z.boolean().optional(),
});
const translationTerm = z.object({ original: z.string().min(1), canonicalEnglish: z.string().min(1), notes: z.string().default(""), firstSeenChapter: z.number().int().positive(), lastSeenChapter: z.number().int().positive(), locked: z.boolean().optional() });

export const extractedTimelineEventSchema = z.object({
  entity: z.string().min(1), type: z.enum(["appearance", "location", "relationship_change", "ability_gained", "ability_lost", "injury", "death", "resurrection", "rank_change", "title_change", "organization_membership", "possession", "revelation", "status_change"]),
  summary: z.string().min(1).max(1000), relatedEntity: z.string().optional(), status: z.string().optional(), chapter: z.number().int().positive(), confidence: z.number().min(0).max(1).optional(),
});

export const storyBibleUpdateSchema = z.object({
  characters: z.array(character).default([]), locations: z.array(namedEntity).default([]), factions: z.array(namedEntity).default([]), abilities: z.array(namedEntity).default([]),
  classes: z.array(namedEntity).default([]), ranks: z.array(namedEntity).default([]), items: z.array(namedEntity).default([]), creatures: z.array(namedEntity).default([]), systemTerms: z.array(namedEntity).default([]),
  relationships: z.array(relationship).default([]), translationTerms: z.array(translationTerm).default([]), timelineEvents: z.array(extractedTimelineEventSchema).default([]), chapterSummary: z.string().min(1),
});

export const canonicalEntitySchema = z.object({
  id: z.string().regex(/^ent_[a-f0-9]{24}$/), type: entityTypeSchema, canonicalName: z.string().min(1), aliases: z.array(z.string()).default([]), originalName: z.string().default(""), description: z.string().default(""),
  firstAppearance: z.number().int().positive(), lastKnownAppearance: z.number().int().positive(), status: z.string().default("unknown"), notes: z.string().default(""), canonicalNameLocked: z.boolean().default(false),
  origin: factOriginSchema.default("automatic"), provenance: z.array(provenanceSchema).default([]), mergedFromIds: z.array(z.string()).default([]),
});
export type CanonicalEntity = z.infer<typeof canonicalEntitySchema>;
export const timelineEventSchema = z.object({
  id: z.string().regex(/^evt_[a-f0-9]{24}$/), entityId: z.string(), chapter: z.number().int().positive(), type: extractedTimelineEventSchema.shape.type, summary: z.string().min(1).max(1000), relatedEntityId: z.string().optional(), status: z.string().optional(), confidence: z.number().min(0).max(1).optional(), origin: factOriginSchema.default("automatic"), provenance: provenanceSchema,
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export const canonicalRelationshipSchema = z.object({
  id: z.string().regex(/^rel_[a-f0-9]{24}$/), sourceEntityId: z.string(), targetEntityId: z.string(), type: z.string().min(1), startChapter: z.number().int().positive(), endChapter: z.number().int().positive().optional(), state: z.enum(["current", "historical"]).default("current"), confidence: z.number().min(0).max(1).optional(), provenance: z.array(provenanceSchema).default([]), locked: z.boolean().default(false), origin: factOriginSchema.default("automatic"),
});
export type CanonicalRelationship = z.infer<typeof canonicalRelationshipSchema>;
export const mergeRecordSchema = z.object({ id: z.string().uuid(), targetEntityId: z.string(), sourceEntityIds: z.array(z.string()).min(1), reason: z.string(), createdAt: z.string(), undoneAt: z.string().optional() });

export const storyBibleSchema = storyBibleUpdateSchema.extend({
  version: z.number().int().nonnegative().default(0), chapterSummaries: z.record(z.string(), z.string()).default({}), canonicalEntities: z.array(canonicalEntitySchema).default([]),
  canonicalRelationships: z.array(canonicalRelationshipSchema).default([]), entityTimeline: z.array(timelineEventSchema).default([]), merges: z.array(mergeRecordSchema).default([]),
}).omit({ chapterSummary: true, timelineEvents: true });

export type StoryBibleUpdate = z.infer<typeof storyBibleUpdateSchema>;
export type StoryBible = z.infer<typeof storyBibleSchema>;
export const emptyStoryBible = (): StoryBible => storyBibleSchema.parse({});
