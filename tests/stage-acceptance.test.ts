import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markStagesCurrent } from "../src/studio/stage-acceptance.js";

const stageNames = ["ingestion", "translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video"];
describe("selective stage acceptance", () => {
  it("marks an existing artifact with an audit record and never changes its content", async () => {
    const root = await mkdtemp(join(tmpdir(), "stage-acceptance-")); const dir = join(root, "stories", "demo", "chapters", "0001"); await mkdir(dir, { recursive: true }); await writeFile(join(root, "stories", "demo", "story.json"), "{}");
    await writeFile(join(dir, "chapter.json"), JSON.stringify({ chapter: 1, sourceLanguage: "en", outputLanguage: "en", counts: { originalCharacters: 1, englishWords: 1, narrationWords: 1 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stages: Object.fromEntries(stageNames.map((stage) => [stage, { status: "pending" }])) }));
    const text = "Retained translation"; await writeFile(join(dir, "english.txt"), text);
    const result = await markStagesCurrent(root, "demo", { chapters: [1], stages: ["translation"], reason: "Reviewed manually" });
    expect(result.changed).toEqual([{ chapter: 1, stage: "translation" }]); expect(await readFile(join(dir, "english.txt"), "utf8")).toBe(text);
    const chapter = JSON.parse(await readFile(join(dir, "chapter.json"), "utf8")); expect(chapter.stages.translation.status).toBe("complete"); expect(chapter.stages.translation.manualAcceptance).toMatchObject({ acceptedReason: "Reviewed manually" }); expect(chapter.stages.translation.outputFingerprint).toBeTruthy();
  });
  it("rejects failed stages as ineligible", async () => {
    const root = await mkdtemp(join(tmpdir(), "stage-acceptance-")); const dir = join(root, "stories", "demo", "chapters", "0001"); await mkdir(dir, { recursive: true }); await writeFile(join(root, "stories", "demo", "story.json"), "{}");
    await writeFile(join(dir, "chapter.json"), JSON.stringify({ chapter: 1, sourceLanguage: "en", outputLanguage: "en", counts: { originalCharacters: 1, englishWords: 1, narrationWords: 1 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stages: Object.fromEntries(stageNames.map((stage) => [stage, { status: stage === "translation" ? "failed" : "pending" }])) })); await writeFile(join(dir, "english.txt"), "failed output");
    const result = await markStagesCurrent(root, "demo", { chapters: [1], stages: ["translation"] }); expect(result.changed).toHaveLength(0); expect(result.ineligible[0]?.reason).toMatch(/failed/i);
  });
});
