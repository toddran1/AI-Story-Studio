import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadStory } from "../config/load-config.js";
import type { StageModelConfig } from "../domain/provider.js";
import { stageModelConfigSchema } from "../domain/provider.js";
import { storyBibleSchema } from "../domain/story-bible.js";
import { LLMRouter } from "../llm/router.js";
import { ConfigurationError } from "../pipeline/errors.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists, readTextIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { SUMMARY_PROMPT_VERSION, summaryInstructions } from "./prompts.js";
import { contiguousRange, normalizeSummaryChapters, StorySummary, SummaryGenerationInput, summaryGenerationInputSchema, summaryIdSchema, summarySchema, SummaryProgress, summarySourceModeSchema, summaryTypeSchema } from "./types.js";

type SourceChapter = { chapter: number; text: string; characters: number; fingerprint: string };
type Segment = { chapters: number[]; text: string; inputCharacters: number };
const COMBINE_GROUP_SIZE = 12;

export class SummaryService {
  constructor(private readonly root: string, private readonly llms: LLMRouter) {}

  async list(story: string, options: { query?: string; type?: string; status?: string; sort?: "coverage" | "created" | "updated" } = {}) {
    const filters = listOptionsSchema.parse(options);
    const records: StorySummary[] = [];
    for (const name of await readdir(summaryDirectory(this.root, story)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error))) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const parsed = summarySchema.safeParse(await readJsonIfExists(join(summaryDirectory(this.root, story), name)).catch(() => undefined));
      if (parsed.success) records.push(parsed.data);
    }
    const query = filters.query?.trim().toLocaleLowerCase();
    const filtered = records.filter((item) => (!query || `${item.title}\n${item.text}`.toLocaleLowerCase().includes(query)) && (!filters.type || item.summaryType === filters.type) && (!filters.status || item.status === filters.status));
    filtered.sort(filters.sort === "coverage" ? (a, b) => a.chapters[0]! - b.chapters[0]! : filters.sort === "created" ? (a, b) => b.createdAt.localeCompare(a.createdAt) : (a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return filtered;
  }

  async get(story: string, id: string) {
    summaryIdSchema.parse(id); const raw = await readJsonIfExists(summaryPath(this.root, story, id));
    if (!raw) throw new ConfigurationError(`Summary '${id}' was not found`);
    return summarySchema.parse(raw);
  }

  async generate(storySlug: string, raw: unknown, progress?: (event: SummaryProgress) => void, existingId?: string) {
    const input = summaryGenerationInputSchema.parse(raw); const chapters = normalizeSummaryChapters(input); const story = await loadStory(storyPaths(this.root, storySlug, 1).storyConfig);
    const id = existingId ? summaryIdSchema.parse(existingId) : `sum_${randomUUID()}`; const previous = existingId ? await this.get(storySlug, id) : undefined;
    const model: StageModelConfig = input.model ?? story.pipeline.narration; const now = new Date().toISOString();
    let record = summarySchema.parse({ id, storyId: story.id, title: input.title, chapters, chapterRange: contiguousRange(chapters), summaryType: input.summaryType, sourceMode: input.sourceMode, targetLength: { words: input.targetWords }, focus: input.focus, instructions: input.instructions, text: previous?.text ?? "", status: "generating", origin: "generated", manuallyEdited: false, contextEligible: input.contextEligible, createdAt: previous?.createdAt ?? now, updatedAt: now, provenance: { model, promptVersion: SUMMARY_PROMPT_VERSION, chapterSources: [], levels: [] } });
    await atomicWriteJson(summaryPath(this.root, storySlug, id), record);
    try {
      progress?.({ phase: "preparing", completed: 0, total: chapters.length });
      const sources = await this.loadSources(storySlug, chapters, input.sourceMode);
      record.provenance.chapterSources = sources.map(({ chapter, characters, fingerprint: hash }) => ({ chapter, mode: input.sourceMode, characters, fingerprint: hash }));
      const chunks = chunk(sources, input.chunkSize).map((items) => ({ chapters: items.map((item) => item.chapter), text: items.map((item) => `CHAPTER ${item.chapter}\n${item.text}`).join("\n\n"), inputCharacters: items.reduce((sum, item) => sum + item.characters, 0) }));
      let segments: Segment[] = [];
      for (let index = 0; index < chunks.length; index++) {
        const item = chunks[index]!; progress?.({ phase: "summarizing", completed: index, total: chunks.length, level: 0, chapters: item.chapters });
        segments.push({ chapters: item.chapters, text: await this.run(model, item.text, input, story.outputLanguage, chunks.length === 1 ? input.targetWords : chunkTarget(input.targetWords, chunks.length)), inputCharacters: item.inputCharacters });
        progress?.({ phase: "summarizing", completed: index + 1, total: chunks.length, level: 0, chapters: item.chapters });
      }
      record.provenance.levels.push({ level: 0, batches: chunks.map((item, index) => ({ batch: index + 1, chapters: item.chapters, inputCharacters: item.inputCharacters })) });
      let level = 1;
      while (segments.length > 1) {
        const groups = chunk(segments, COMBINE_GROUP_SIZE); const combined: Segment[] = [];
        for (let index = 0; index < groups.length; index++) {
          const group = groups[index]!; const selected = group.flatMap((item) => item.chapters); const text = group.map((item) => `CHAPTERS ${coverage(item.chapters)}\n${item.text}`).join("\n\n");
          progress?.({ phase: groups.length === 1 ? "finalizing" : "combining", completed: index, total: groups.length, level, chapters: selected });
          combined.push({ chapters: selected, text: await this.run(model, text, input, story.outputLanguage, groups.length === 1 ? input.targetWords : chunkTarget(input.targetWords, groups.length), true), inputCharacters: [...text].length });
          progress?.({ phase: groups.length === 1 ? "finalizing" : "combining", completed: index + 1, total: groups.length, level, chapters: selected });
        }
        record.provenance.levels.push({ level, batches: groups.map((group, index) => ({ batch: index + 1, chapters: group.flatMap((item) => item.chapters), inputCharacters: group.reduce((sum, item) => sum + item.inputCharacters, 0) })) });
        segments = combined; level++;
      }
      record = summarySchema.parse({ ...record, text: segments[0]!.text, status: "complete", error: undefined, updatedAt: new Date().toISOString() }); await atomicWriteJson(summaryPath(this.root, storySlug, id), record);
      progress?.({ phase: "complete", completed: chapters.length, total: chapters.length }); return record;
    } catch (error) {
      record = summarySchema.parse({ ...record, status: "failed", error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() }); await atomicWriteJson(summaryPath(this.root, storySlug, id), record); throw error;
    }
  }

  async update(story: string, id: string, raw: unknown) {
    const patch = updateSchema.parse(raw); const current = await this.get(story, id); const textChanged = patch.text !== undefined && patch.text !== current.text;
    const updated = summarySchema.parse({ ...current, ...patch, origin: textChanged ? "manual" : current.origin, manuallyEdited: current.manuallyEdited || textChanged, updatedAt: new Date().toISOString() });
    await atomicWriteJson(summaryPath(this.root, story, id), updated); return updated;
  }

  async regenerate(story: string, id: string, overrides: unknown, progress?: (event: SummaryProgress) => void) {
    const current = await this.get(story, id); const patch = regenerateSchema.parse(overrides);
    return this.generate(story, { title: patch.title ?? current.title, chapters: current.chapters, summaryType: patch.summaryType ?? current.summaryType, sourceMode: patch.sourceMode ?? current.sourceMode, targetWords: patch.targetWords ?? current.targetLength.words, instructions: patch.instructions ?? current.instructions, focus: patch.focus ?? current.focus, model: patch.model ?? current.provenance.model, chunkSize: patch.chunkSize ?? 25, contextEligible: patch.contextEligible ?? current.contextEligible }, progress, id);
  }

  async delete(story: string, id: string) { await this.get(story, id); await rm(summaryPath(this.root, story, id)); return { id, deleted: true }; }

  private async loadSources(story: string, chapters: number[], mode: SummaryGenerationInput["sourceMode"]): Promise<SourceChapter[]> {
    const bibleRaw = mode === "chapter-summaries" ? await readJsonIfExists(storyPaths(this.root, story, 1).bible) : undefined;
    const bible = bibleRaw ? storyBibleSchema.parse(bibleRaw) : undefined; const result: SourceChapter[] = [];
    for (const chapter of chapters) {
      const paths = storyPaths(this.root, story, chapter); const text = mode === "original" ? await readTextIfExists(paths.original) : mode === "translated" ? await readTextIfExists(paths.english) : bible?.chapterSummaries[String(chapter)];
      if (!text?.trim()) throw new ConfigurationError(`Chapter ${chapter} has no ${mode === "chapter-summaries" ? "existing chapter summary" : `${mode} text`}. Choose another source mode or process the chapter first.`);
      result.push({ chapter, text: text.trim(), characters: [...text].length, fingerprint: fingerprint(text) });
    }
    return result;
  }

  private async run(model: StageModelConfig, inputText: string, input: SummaryGenerationInput, outputLanguage: string, targetWords: number, combining = false) {
    const result = await this.llms.forStage(model).generateText({ model: model.model, instructions: summaryInstructions(input.summaryType, targetWords, outputLanguage, input.focus, input.instructions, combining), input: inputText });
    const text = result.text.trim().replace(/^```(?:text|markdown)?\s*\n?|\n?```$/gi, "").trim();
    if (!text) throw new Error("The summary model returned empty text");
    if ([...text].length > 1_000_000) throw new Error("The generated summary exceeds the 1,000,000-character storage limit");
    return text;
  }
}

export const updateSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), text: z.string().min(1).max(1_000_000).optional(), contextEligible: z.boolean().optional() }).strict().refine((value) => value.title !== undefined || value.text !== undefined || value.contextEligible !== undefined, { message: "Provide a title, summary text, or context setting to update" });
export const regenerateSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), summaryType: summaryTypeSchema.optional(), sourceMode: summarySourceModeSchema.optional(), targetWords: z.number().int().min(50).max(20_000).optional(), instructions: z.string().trim().max(5_000).optional(), focus: z.string().trim().max(500).optional(), model: stageModelConfigSchema.optional(), chunkSize: z.number().int().min(1).max(100).optional(), contextEligible: z.boolean().optional() }).strict();
const listOptionsSchema = z.object({ query: z.string().trim().max(500).optional(), type: summaryTypeSchema.optional(), status: z.enum(["generating", "complete", "failed"]).optional(), sort: z.enum(["coverage", "created", "updated"]).default("updated") }).strict();

export type EligibleSummaryContext = { id: string; title: string; chapters: number[]; text: string };

/** Selects only explicitly eligible, completed, non-future summaries and enforces a hard character budget. */
export async function loadEligibleSummaryContext(root: string, story: string, chapter: number, sourceText: string, options: { maxItems?: number; maxCharacters?: number } = {}): Promise<EligibleSummaryContext[]> {
  const maxItems = Math.max(0, Math.min(10, options.maxItems ?? 3));
  let remaining = Math.max(0, Math.min(20_000, options.maxCharacters ?? 6_000));
  if (!maxItems || !remaining) return [];
  const candidates: StorySummary[] = [];
  for (const name of await readdir(summaryDirectory(root, story)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error))) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const parsed = summarySchema.safeParse(await readJsonIfExists(join(summaryDirectory(root, story), name)).catch(() => undefined));
    if (parsed.success && parsed.data.status === "complete" && parsed.data.contextEligible && parsed.data.chapters.every((number) => number < chapter)) candidates.push(parsed.data);
  }
  const terms = searchTerms(sourceText);
  candidates.sort((a, b) => relevance(b, terms, chapter) - relevance(a, terms, chapter) || b.updatedAt.localeCompare(a.updatedAt));
  const selected: EligibleSummaryContext[] = [];
  for (const item of candidates) {
    if (selected.length >= maxItems || remaining <= 0) break;
    const prefix = `${item.title}\n`; const prefixLength = [...prefix].length;
    if (prefixLength >= remaining) break;
    const text = [...item.text].slice(0, remaining - prefixLength).join("").trim();
    if (!text) continue;
    selected.push({ id: item.id, title: item.title, chapters: item.chapters, text });
    remaining -= prefixLength + [...text].length;
  }
  return selected;
}

function summaryDirectory(root: string, story: string) { return join(root, "stories", story, "summaries"); }
function summaryPath(root: string, story: string, id: string) { return join(summaryDirectory(root, story), `${summaryIdSchema.parse(id)}.json`); }
function chunk<T>(items: T[], size: number): T[][] { const result: T[][] = []; for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size)); return result; }
function chunkTarget(target: number, chunks: number) { return Math.max(150, Math.min(1_200, Math.ceil(target / Math.max(1, chunks) * 1.5))); }
export function coverage(chapters: number[]) { const range = contiguousRange(chapters); return range ? `${range.from}–${range.to}` : chapters.join(", "); }
function searchTerms(text: string) { return new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.slice(0, 2_000) ?? []); }
function relevance(item: StorySummary, terms: Set<string>, chapter: number) { const matches = (item.title + " " + item.text).toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.reduce((sum, term) => sum + Number(terms.has(term)), 0) ?? 0; return matches * 10_000 - Math.max(0, chapter - Math.max(...item.chapters)); }
