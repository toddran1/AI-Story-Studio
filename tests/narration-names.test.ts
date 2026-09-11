import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chapterSchema } from "../src/domain/chapter.js";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { narrationInstructions } from "../src/narration/prompts.js";
import { polishNarration } from "../src/narration/narration-editor.js";
import { LLMProvider } from "../src/llm/provider.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { applyCanonicalOverlay, updateCanonicalEntity } from "../src/story-bible/canonical.js";
import { invalidateNarrationNamingChange, loadNarrationNamingEntities } from "../src/story-bible/narration-names.js";
import { retrieveRelevantContext } from "../src/story-bible/retrieval.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";
import { qaInstructions } from "../src/qa/prompts.js";
import { storyBibleInstructions } from "../src/story-bible/prompts.js";

const update = (chapter = 1) => storyBibleUpdateSchema.parse({ chapterSummary: "Michael enters.", characters: [{ canonicalEnglishName: "Michael Johnson", originalName: "米高", description: "A coach", aliases: ["Michael", "Mike", "Mikey", "Coach Johnson"], firstSeenChapter: chapter, lastSeenChapter: chapter }] });

describe("preferred narration names", () => {
  it("persists preferred names and per-alias behavior through protected-overlay rebuilds", async () => {
    const root = await mkdtemp(join(tmpdir(), "narration-names-")); const base = mergeStoryBible(emptyStoryBible(), update(), 1); const entity = base.canonicalEntities[0]!;
    const patch = { preferredNarrationName: "Big Mike", aliasNarrationRules: [{ alias: "Michael", behavior: "use_preferred" as const }, { alias: "Coach Johnson", behavior: "custom" as const, replacement: "Coach Big Mike" }, { alias: "Mikey", behavior: "no_override" as const }] };
    const saved = await updateCanonicalEntity(root, "demo-story", base, entity.id, patch); expect(saved.bible.canonicalEntities[0]).toMatchObject(patch);
    const rebuilt = mergeStoryBible(emptyStoryBible(), update(), 1); const reapplied = await applyCanonicalOverlay(root, "demo-story", rebuilt); expect(reapplied.bible.canonicalEntities[0]).toMatchObject(patch);
  });

  it("retrieves bounded current-chapter naming rules without replacing chapter text", async () => {
    const root = await mkdtemp(join(tmpdir(), "narration-context-")); const base = mergeStoryBible(emptyStoryBible(), update(), 1); const entity = base.canonicalEntities[0]!;
    await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, base); await updateCanonicalEntity(root, "demo-story", base, entity.id, { preferredNarrationName: "Big Mike", aliasNarrationRules: [{ alias: "Mike", behavior: "use_preferred" }] });
    const naming = await loadNarrationNamingEntities(root, "demo-story"); const source = `Mike adjusted Coach Johnson's jacket.`; const context = retrieveRelevantContext(emptyStoryBible(), source, 1, { narrationNamingEntities: naming, maxCharacters: 1600 });
    expect(context.canonicalEntities[0]).toMatchObject({ canonicalName: "Michael Johnson", preferredNarrationName: "Big Mike", aliasNarrationRules: [{ alias: "Mike", behavior: "use_preferred" }] });
    expect(source).toBe(`Mike adjusted Coach Johnson's jacket.`); expect(JSON.stringify(context).length).toBeLessThanOrEqual(1600);
  });

  it("marks AI narration stale while preserving manual narration and downstream invalidation", async () => {
    const root = await mkdtemp(join(tmpdir(), "narration-invalidation-")); const base = mergeStoryBible(emptyStoryBible(), update(), 1); const before = base.canonicalEntities[0]!; const after = { ...before, preferredNarrationName: "Big Mike" };
    for (const [number, provider] of [[1, "openai"], [2, "manual"]] as const) { const paths = storyPaths(root, "demo-story", number); await mkdir(paths.chapterDir, { recursive: true }); await writeFile(paths.original, number === 1 ? "Michael entered." : "Mike spoke."); await writeFile(paths.narration, "Existing narration"); await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: number, sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 10, englishWords: 2, narrationWords: 2 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stages: { ingestion: { status: "complete" }, translation: { status: "complete" }, narration: { status: "complete", provider }, qa: { status: "complete" }, storyBible: { status: "complete" }, tts: { status: "complete" }, audioMastering: { status: "complete" }, alignment: { status: "complete" }, subtitles: { status: "complete" }, scenePlanning: { status: "complete" }, artwork: { status: "complete" }, video: { status: "complete" } } })); }
    const result = await invalidateNarrationNamingChange(root, "demo-story", before, after); expect(result.affectedChapters).toEqual([1, 2]); expect(result.manualNarrationChapters).toEqual([2]);
    const ai = chapterSchema.parse(JSON.parse(await readFile(storyPaths(root, "demo-story", 1).chapterMeta, "utf8"))); const manual = chapterSchema.parse(JSON.parse(await readFile(storyPaths(root, "demo-story", 2).chapterMeta, "utf8")));
    expect(ai.stages.narration).toMatchObject({ status: "pending", staleReason: expect.stringContaining("Michael Johnson") }); expect(ai.stages.translation.status).toBe("complete"); expect(ai.stages.qa.status).toBe("pending");
    expect(manual.stages.narration).toMatchObject({ status: "complete", provider: "manual", manualReviewRequired: true }); expect(await readFile(storyPaths(root, "demo-story", 2).narration, "utf8")).toBe("Existing narration");
  });

  it("instructs the model to preserve grammar and contextual references instead of blind replacement", () => {
    const prompt = narrationInstructions("English"); expect(prompt).toMatch(/default narration-facing name in place of the canonical\/original name/i); expect(prompt).toMatch(/never perform blind literal replacement/i); expect(prompt).toMatch(/possessives/); expect(prompt).toMatch(/dialogue-specific nicknames and vocatives/); expect(prompt).toMatch(/formal titles/); expect(prompt).toMatch(/pronouns/);
  });

  it("teaches QA and Story Bible extraction that preferred names preserve canonical identity", () => {
    expect(qaInstructions).toMatch(/authorized narration-facing rendering/i); expect(qaInstructions).toMatch(/do not flag an authorized preferred\/custom name substitution/i);
    expect(storyBibleInstructions).toMatch(/resolve it back to that existing canonical entity/i); expect(storyBibleInstructions).toMatch(/never create a duplicate entity/i);
  });

  it("passes structured naming rules into the narration request", async () => {
    let request: any; const provider: LLMProvider = { name: "openai", validateConfiguration: async () => undefined, generateText: async (value) => { request = value; return { text: "Big Mike entered." }; }, generateStructured: async () => { throw new Error("unused"); } };
    await polishNarration(provider, { provider: "openai", model: "test-model" }, "Michael entered.", "English", { canonicalEntities: [{ canonicalName: "Michael Johnson", preferredNarrationName: "Big Mike", aliasNarrationRules: [{ alias: "Michael", behavior: "use_preferred" }] }] });
    expect(request.input).toContain('"preferredNarrationName": "Big Mike"'); expect(request.input).toContain('"behavior": "use_preferred"'); expect(request.instructions).toMatch(/context requires/);
  });
});
