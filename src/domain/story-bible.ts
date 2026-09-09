import { z } from "zod";

const namedEntity = z.object({
  canonicalEnglishName: z.string().min(1),
  originalName: z.string().default(""),
  description: z.string().default(""),
  firstSeenChapter: z.number().int().positive(),
  lastSeenChapter: z.number().int().positive(),
});

const character = namedEntity.extend({
  aliases: z.array(z.string()).default([]),
  gender: z.string().optional(),
  pronouns: z.array(z.string()).default([]),
});

const relationship = z.object({
  subject: z.string().min(1), object: z.string().min(1), relationship: z.string().min(1),
  firstSeenChapter: z.number().int().positive(), lastSeenChapter: z.number().int().positive(),
});

const translationTerm = z.object({
  original: z.string().min(1), canonicalEnglish: z.string().min(1), notes: z.string().default(""),
  firstSeenChapter: z.number().int().positive(), lastSeenChapter: z.number().int().positive(),
});

export const storyBibleUpdateSchema = z.object({
  characters: z.array(character).default([]),
  locations: z.array(namedEntity).default([]),
  factions: z.array(namedEntity).default([]),
  abilities: z.array(namedEntity).default([]),
  classes: z.array(namedEntity).default([]),
  ranks: z.array(namedEntity).default([]),
  items: z.array(namedEntity).default([]),
  creatures: z.array(namedEntity).default([]),
  systemTerms: z.array(namedEntity).default([]),
  relationships: z.array(relationship).default([]),
  translationTerms: z.array(translationTerm).default([]),
  chapterSummary: z.string().min(1),
});

export const storyBibleSchema = storyBibleUpdateSchema.extend({
  version: z.number().int().nonnegative().default(0),
  chapterSummaries: z.record(z.string(), z.string()).default({}),
}).omit({ chapterSummary: true });

export type StoryBibleUpdate = z.infer<typeof storyBibleUpdateSchema>;
export type StoryBible = z.infer<typeof storyBibleSchema>;

export const emptyStoryBible = (): StoryBible => storyBibleSchema.parse({});
