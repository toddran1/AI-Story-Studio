import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../src/llm/provider.js";
import { emptyStoryBible } from "../src/domain/story-bible.js";
import { planScenes, planVisualScenes } from "../src/scenes/planner.js";
import { estimateScenePacing, scenePacingSchema } from "../src/scenes/pacing.js";
import { productionSceneManifestSchema, sceneManifestSchema } from "../src/scenes/types.js";
import { testStory } from "./helpers.js";
import { resolveVisualEntities } from "../src/scenes/identity.js";
import { canonicalEntitySchema } from "../src/domain/story-bible.js";

describe("shared summary visual planning", () => {
  it("resolves full, short, canonical and original names to one visual identity", () => {
    const entity = canonicalEntitySchema.parse({ id: "ent_111111111111111111111111", type: "character", canonicalName: "Su Ming", originalName: "苏铭", firstAppearance: 1, lastKnownAppearance: 4,
      localizedNaming: { locale: "en-US", fullName: "Malakai Sterling", shortName: "Malakai", usageMode: "ai_contextual" } });
    expect(resolveVisualEntities(["Su Ming", "苏铭", "Malakai Sterling", "Malakai"], [entity]).map((value) => value.id)).toEqual([entity.id]);
    const another = { ...entity, id: "ent-other", canonicalName: "Someone Else", originalName: "其他" };
    expect(resolveVisualEntities(["Malakai"], [entity, another])).toEqual([]);
  });
  it("uses measured audio duration and validated pacing targets", () => {
    expect(estimateScenePacing("Short text", {}, 308)).toMatchObject({ durationSeconds: 308, sceneCount: 14, averageDurationSeconds: 22, durationSource: "mastered-audio" });
    expect(estimateScenePacing("Short text", { pacing: "slow" }, 300).sceneCount).toBe(10);
    expect(estimateScenePacing("Short text", { pacing: "fast" }, 300).sceneCount).toBe(25);
    expect(estimateScenePacing("Short text", { pacing: "custom", sceneCount: 17 }, 300).sceneCount).toBe(17);
    expect(estimateScenePacing("Short text", { pacing: "custom", secondsPerScene: 15 }, 300).sceneCount).toBe(20);
    expect(estimateScenePacing(Array(750).fill("word").join(" ")).durationSeconds).toBe(300);
    expect(scenePacingSchema.safeParse({ pacing: "custom" }).success).toBe(false);
    expect(scenePacingSchema.safeParse({ sceneCount: 2, secondsPerScene: 20 }).success).toBe(false);
    expect(scenePacingSchema.safeParse({ sceneCount: 101 }).success).toBe(false);
    expect(() => estimateScenePacing("text", {}, NaN)).toThrow("positive");
  });

  it("plans only the recap narration with canonical localized identity guidance", async () => {
    const calls: Array<{ input: string; instructions: string; schemaName: string }> = [];
    const provider: LLMProvider = {
      name: "openai", validateConfiguration: async () => {}, generateText: async () => ({ text: "" }),
      generateStructured: async (request) => { calls.push(request); return { value: request.schema.parse({ scenes: [{
        summary: "The necromancer arrives", startSeconds: 0, endSeconds: 22, characters: ["Su Ming"],
        visualPrompt: "Su Ming enters the established dungeon", importance: "standard",
      }] }) }; },
    };
    const story = testStory();
    await planVisualScenes(provider, story.pipeline.scenePlanner, {
      sourceType: "summary", sourceId: "sum-test", sourceLabel: "SUMMARY: Dungeon recap",
      narration: "Malakai entered the dungeon.", canonicalSummary: "Su Ming entered the dungeon.",
      sourceChapters: [1, 4], durationSeconds: 22, targetSceneCount: 1,
      bible: emptyStoryBible(), settings: story.scenes,
      namingIdentities: [{ entityId: "ent-su-ming", canonicalName: "Su Ming", originalName: "苏铭", narrationNames: ["Malakai Sterling", "Malakai"] }],
    });
    expect(calls[0]!.input).toContain("FINAL NARRATION:\nMalakai entered the dungeon.");
    expect(calls[0]!.input).toContain("Malakai Sterling");
    expect(calls[0]!.input).toContain("ent-su-ming");
    expect(calls[0]!.input).toContain("SOURCE CHAPTERS: [1,4]");
    expect(calls[0]!.instructions).toContain("not every event in its source chapters");
    expect(calls[0]!.schemaName).toBe("summary_scene_plan");
    await planScenes(provider, story.pipeline.scenePlanner, { chapter: 1, narration: "Original chapter narration", durationSeconds: 22, bible: emptyStoryBible(), settings: story.scenes });
    expect(calls[1]!.schemaName).toBe("chapter_scene_plan");
    expect(calls[1]!.input).not.toContain("SUPPORTING CANONICAL SUMMARY");
    expect(calls[1]!.instructions).not.toContain("recap");
  });

  it("shares manifest metadata without assigning summaries a fake chapter", () => {
    const common = { version: 1, durationSeconds: 22, planningFingerprint: "input", planner: { provider: "fake", model: "test", promptVersion: "v1" }, createdAt: "now", updatedAt: "now",
      scenes: [{ id: "scene-001", summary: "Arrival", startSeconds: 0, endSeconds: 22, visualPrompt: "A dungeon entrance", narrationText: "Malakai entered.", entityIds: ["ent-su-ming"], visualType: "image" }] };
    const summary = productionSceneManifestSchema.parse({ ...common, sourceType: "summary", sourceId: "sum-test", sourceChapters: [1, 4], timingMethod: "estimated" });
    expect(summary).not.toHaveProperty("chapter");
    expect(summary.scenes[0]!.entityIds).toEqual(["ent-su-ming"]);
    expect(sceneManifestSchema.parse({ ...common, chapter: 1 })).toHaveProperty("chapter", 1);
    expect(sceneManifestSchema.safeParse({ ...common, chapter: 1, sourceType: "summary" }).success).toBe(false);
  });
});
