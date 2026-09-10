import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { Chapter, StageName, chapterSchema } from "../domain/chapter.js";
import { StoryBible, storyBibleSchema } from "../domain/story-bible.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths, voicePreviewPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";

export const bibleCategorySchema = z.enum(["characters", "locations", "factions", "abilities", "classes", "ranks", "items", "creatures", "systemTerms", "relationships", "translationTerms"]);
export type BibleCategory = z.infer<typeof bibleCategorySchema>;
const bibleMutationSchema = z.object({ id: z.string().uuid(), category: bibleCategorySchema, key: z.string(), action: z.enum(["upsert", "delete"]), value: z.record(z.string(), z.unknown()).optional(), createdAt: z.string(), updatedAt: z.string() });
const bibleOverlaySchema = z.object({ version: z.literal(1), mutations: z.array(bibleMutationSchema).default([]) });
export type BibleEntry = { id: string; category: BibleCategory; key: string; value: Record<string, unknown>; manual: boolean };

export async function applyManualBibleOverlay(root: string, slug: string, base: StoryBible) {
  const overlay = bibleOverlaySchema.parse((await readJsonIfExists(storyPaths(root, slug, 1).bibleManual)) ?? { version: 1, mutations: [] });
  const result = structuredClone(base);
  const entries: BibleEntry[] = [];
  for (const category of bibleCategorySchema.options) {
    const mutations = overlay.mutations.filter((item) => item.category === category);
    const automatic = (result[category] as Array<Record<string, unknown>>).filter((value) => !mutations.some((item) => item.key === entryKey(category, value)));
    const manual = mutations.filter((item) => item.action === "upsert" && item.value).map((item) => item.value!);
    (result as unknown as Record<string, unknown>)[category] = [...automatic, ...manual];
    entries.push(...automatic.map((value) => ({ id: `auto-${fingerprint({ category, key: entryKey(category, value) }).slice(0, 16)}`, category, key: entryKey(category, value), value, manual: false })));
    entries.push(...mutations.filter((item) => item.action === "upsert" && item.value).map((item) => ({ id: item.id, category, key: item.key, value: item.value!, manual: true })));
  }
  return { bible: storyBibleSchema.parse(result), entries };
}

export async function addManualBibleEntry(root: string, slug: string, base: StoryBible, category: BibleCategory, value: Record<string, unknown>, replacementKey?: string) {
  validateBibleValue(base, category, value); const paths = storyPaths(root, slug, 1); const overlay = bibleOverlaySchema.parse((await readJsonIfExists(paths.bibleManual)) ?? { version: 1, mutations: [] });
  const now = new Date().toISOString(); const mutation = bibleMutationSchema.parse({ id: randomUUID(), category, key: replacementKey ?? entryKey(category, value), action: "upsert", value, createdAt: now, updatedAt: now });
  overlay.mutations.push(mutation); await atomicWriteJson(paths.bibleManual, overlay); return mutation.id;
}

export async function updateManualBibleEntry(root: string, slug: string, base: StoryBible, id: string, value: Record<string, unknown>) {
  const paths = storyPaths(root, slug, 1); const overlay = bibleOverlaySchema.parse((await readJsonIfExists(paths.bibleManual)) ?? { version: 1, mutations: [] }); const mutation = overlay.mutations.find((item) => item.id === id && item.action === "upsert");
  if (!mutation) throw new Error("Manual Story Bible entry was not found"); validateBibleValue(base, mutation.category, value); mutation.value = value; mutation.updatedAt = new Date().toISOString(); await atomicWriteJson(paths.bibleManual, overlay);
}

export async function deleteBibleEntry(root: string, slug: string, base: StoryBible, id: string) {
  const paths = storyPaths(root, slug, 1); const overlay = bibleOverlaySchema.parse((await readJsonIfExists(paths.bibleManual)) ?? { version: 1, mutations: [] }); const manual = overlay.mutations.find((item) => item.id === id);
  if (manual) overlay.mutations = overlay.mutations.filter((item) => item.id !== id);
  else {
    const view = await applyManualBibleOverlay(root, slug, base); const entry = view.entries.find((item) => item.id === id); if (!entry) throw new Error("Story Bible entry was not found"); const now = new Date().toISOString(); overlay.mutations.push({ id: randomUUID(), category: entry.category, key: entryKey(entry.category, entry.value), action: "delete", createdAt: now, updatedAt: now });
  }
  await atomicWriteJson(paths.bibleManual, overlay);
}

export const chapterTextEditSchema = z.object({ field: z.enum(["translation", "narration"]), text: z.string().trim().min(1).max(2_000_000) }).strict();
export async function saveChapterTextEdit(root: string, slug: string, chapterNumber: number, input: z.infer<typeof chapterTextEditSchema>) {
  const { field, text } = chapterTextEditSchema.parse(input); const paths = storyPaths(root, slug, chapterNumber); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta); if (!raw) throw new Error(`Chapter ${chapterNumber} has not been processed`); const chapter = chapterSchema.parse(raw);
  const stage: StageName = field; const output = field === "translation" ? paths.english : paths.narration; const now = new Date().toISOString(); const outputFingerprint = fingerprint(Buffer.from(text).toString("base64"));
  await atomicWrite(output, text); chapter.stages[stage] = { status: "complete", provider: "manual", model: "studio-editor", fingerprint: `manual:${outputFingerprint}`, outputFingerprint, completedAt: now };
  const order: StageName[] = ["translation", "narration", "qa", "storyBible", "tts", "audioMastering", "subtitles", "scenePlanning", "artwork", "video"];
  const invalidated = order.slice(order.indexOf(stage) + 1); for (const name of invalidated) chapter.stages[name] = { status: "pending" };
  if (field === "translation") chapter.counts.englishWords = wordCount(text); else chapter.counts.narrationWords = wordCount(text); chapter.quality = undefined; chapter.audio = undefined; chapter.subtitle = undefined; chapter.video = undefined; chapter.scenes = undefined; chapter.updatedAt = now; await atomicWriteJson(paths.chapterMeta, chapter);
  return { chapter, invalidated };
}

export const voicePreviewSchema = z.object({ text: z.string().trim().min(1).max(1200), model: z.string().trim().min(1).optional(), referenceId: z.string().trim().optional(), speed: z.number().min(.5).max(2).optional() }).strict();
export async function saveVoicePreview(root: string, slug: string, audio: Uint8Array, request: z.infer<typeof voicePreviewSchema>) {
  if (!audio.length) throw new Error("Voice provider returned empty audio"); const id = randomUUID(); const paths = voicePreviewPaths(root, slug, id); await mkdir(paths.directory, { recursive: true }); await atomicWrite(paths.audio, audio); await atomicWriteJson(paths.manifest, { version: 1, id, story: slug, createdAt: new Date().toISOString(), request: { ...request, text: undefined, textFingerprint: fingerprint(request.text) }, bytes: audio.byteLength }); return { id, audioUrl: `/api/stories/${slug}/voice-previews/${id}.mp3`, bytes: audio.byteLength };
}

function validateBibleValue(base: StoryBible, category: BibleCategory, value: Record<string, unknown>) { storyBibleSchema.parse({ ...base, [category]: [value] }); }
function entryKey(category: BibleCategory, value: Record<string, unknown>) { if (category === "relationships") return `${value.subject}\0${value.relationship}\0${value.object}`.toLowerCase(); if (category === "translationTerms") return String(value.original).toLowerCase(); return String(value.originalName || value.canonicalEnglishName).toLowerCase(); }
const wordCount = (text: string) => text.trim().split(/\s+/).length;
