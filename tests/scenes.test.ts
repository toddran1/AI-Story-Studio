import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateStoredArtwork, artworkFingerprint, reviewStoredArtwork } from "../src/artwork/generator.js";
import { ImageProviderRouter } from "../src/artwork/router.js";
import { ImageProvider } from "../src/artwork/provider.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { LLMProvider } from "../src/llm/provider.js";
import { applyStoredSceneRegeneration, planStoredScenes, previewStoredSceneRegeneration, sceneContentFingerprint, scenePlanningFingerprint, updateStoredScene, updateStoredSceneManifest } from "../src/scenes/manifest.js";
import { sceneProposalSourceFingerprint } from "../src/scenes/regeneration.js";
import { SCENE_PLANNER_PROMPT_VERSION, scenePlannerInstructions } from "../src/scenes/prompts.js";
import { normalizeSceneTiming, validateSceneCoverage } from "../src/scenes/timing.js";
import { enabledProductionScenes, retimeScenesToDuration } from "../src/scenes/production.js";
import { SceneManifest, sceneManifestSchema } from "../src/scenes/types.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { sceneImagePath, storyPaths } from "../src/storage/paths.js";
import { buildVideoArgs, VideoProcessor } from "../src/video/renderer.js";
import { renderStoredChapterVideo } from "../src/video/chapter-video.js";
import { testStory } from "./helpers.js";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

class SceneLLM implements LLMProvider { readonly name = "openai" as const; calls: any[] = []; async validateConfiguration() {} async generateText() { return { text: "" }; } async generateStructured<T>(request: any): Promise<any> { this.calls.push(request); return { value: request.schema.parse({ scenes: [{ summary: "Mara enters the observatory.", startSeconds: 0, endSeconds: 12, characters: ["Mara"], location: "Old Observatory", visualPrompt: "Mara beneath the brass telescope", importance: "major" }, { summary: "The star map ignites.", startSeconds: 12, endSeconds: 30, characters: ["Mara"], location: "Old Observatory", visualPrompt: "Blue constellations flare across the chamber", importance: "standard" }] }) as T }; } }
class FakeImages implements ImageProvider { readonly name = "openai"; readonly version = "fake-images-v1"; calls: any[] = []; async validateConfiguration() {} async generate(request: any) { this.calls.push(request); return { data: PNG_1X1, mimeType: "image/png" as const }; } }
class CaptureVideo implements VideoProcessor { readonly version = "capture-video"; input: any; async render(input: any, output: string, settings: any) { this.input = input; await atomicWrite(output, Buffer.from("video")); return { durationSeconds: 33, videoCodec: "h264", audioCodec: "aac", width: settings.width, height: settings.height, container: "mp4" }; } }

async function fixture() { const root = await mkdtemp(join(tmpdir(), "story-scenes-")); const story = testStory(); const paths = storyPaths(root, story.slug, 1); const now = new Date().toISOString(); const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" }; const chapter = chapterSchema.parse({ chapter: 1, originalTitle: "The Observatory", sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 50, englishWords: 20, narrationWords: 18 }, createdAt: now, updatedAt: now, stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: complete, subtitles: { status: "pending" }, scenePlanning: { status: "pending" }, artwork: { status: "pending" }, video: { status: "pending" } }, audio: { durationSeconds: 30, codec: "mp3", container: "mp3" } }); await atomicWriteJson(paths.chapterMeta, chapter); await atomicWrite(paths.narration, "Mara entered the old observatory. Above her, a map of blue stars awakened."); await atomicWrite(paths.audio, Buffer.from("mastered")); return { root, story, paths }; }

describe("scene planning", () => {
  it("normalizes structured scenes into full, non-overlapping chapter coverage", () => { const story = testStory(); const scenes = normalizeSceneTiming([{ summary: "A", startSeconds: 2, endSeconds: 10, characters: [], visualPrompt: "A", importance: "standard", location: undefined }, { summary: "B", startSeconds: 14, endSeconds: 20, characters: [], visualPrompt: "B", importance: "major", location: undefined }], 30, story.scenes); validateSceneCoverage(scenes, 30); expect(scenes[0]!.startSeconds).toBe(0); expect(scenes.at(-1)!.endSeconds).toBe(30); expect(scenes[1]!.startSeconds).toBe(scenes[0]!.endSeconds); });
  it("enforces configured scene duration bounds", () => { const story = testStory(); const raw = [{ summary: "A", startSeconds: 0, endSeconds: 60, characters: [], visualPrompt: "A", importance: "standard" as const, location: undefined }]; expect(() => normalizeSceneTiming(raw, 60, story.scenes)).toThrow("at least 2"); expect(() => validateSceneCoverage([{ ...raw[0]!, id: "scene-001", artwork: { status: "pending", review: "unreviewed", versions: [] }, entityIds: [] }], 60, story.scenes)).toThrow("maximum"); });
  it("derives contiguous enabled timelines without changing stored scene timing", async () => {
    const { root, story } = await fixture();
    const planned = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    const stored = structuredClone(planned.manifest.scenes);
    const activeMiddleOmitted = structuredClone(stored);
    activeMiddleOmitted[0]!.endSeconds = 20; activeMiddleOmitted[1]!.startSeconds = 20; activeMiddleOmitted[1]!.endSeconds = 40; activeMiddleOmitted[1]!.disabled = true; activeMiddleOmitted[2] = { ...structuredClone(activeMiddleOmitted[1]!), id: "scene-003", startSeconds: 40, endSeconds: 60, disabled: false };
    const timeline = retimeScenesToDuration(enabledProductionScenes(activeMiddleOmitted), 60);
    expect(timeline.map((scene) => [scene.id, scene.startSeconds, scene.endSeconds])).toEqual([["scene-001", 0, 30], ["scene-003", 30, 60]]);
    expect(activeMiddleOmitted[1]!.startSeconds).toBe(20);
    for (const disabledIndexes of [[0], [2], [0, 1], [1, 2]] as number[][]) {
      const scenes = structuredClone(activeMiddleOmitted);
      for (const index of disabledIndexes) scenes[index]!.disabled = true;
      const enabled = enabledProductionScenes(scenes);
      if (!enabled.length) continue;
      const result = retimeScenesToDuration(enabled, 60);
      expect(result[0]!.startSeconds).toBe(0);
      expect(result.at(-1)!.endSeconds).toBe(60);
      expect(result.slice(1).every((scene, index) => scene.startSeconds === result[index]!.endSeconds)).toBe(true);
    }
    const oneEnabled = retimeScenesToDuration(enabledProductionScenes(activeMiddleOmitted.map((scene, index) => ({ ...scene, disabled: index !== 1 }))), 60);
    expect(oneEnabled).toHaveLength(1);
    expect(oneEnabled[0]).toMatchObject({ startSeconds: 0, endSeconds: 60 });
  });
  it("uses canonical Story Bible context and reuses its planning fingerprint", async () => { const { root, story } = await fixture(); const provider = new SceneLLM(); const first = await planStoredScenes({ root, story, chapter: 1, provider }); const second = await planStoredScenes({ root, story, chapter: 1, provider }); expect(first.reused).toBe(false); expect(second.reused).toBe(true); expect(provider.calls).toHaveLength(1); expect(provider.calls[0].input).toContain("CANONICAL STORY BIBLE"); expect(scenePlanningFingerprint("n", "b", "a", story.scenes, "openai", "one")).not.toBe(scenePlanningFingerprint("n", "b", "a", story.scenes, "openai", "two")); expect(scenePlanningFingerprint("n", "b", "a1", story.scenes, "openai", "one")).not.toBe(scenePlanningFingerprint("n", "b", "a2", story.scenes, "openai", "one")); });
  it("retries a transient scene-planner failure", async () => { const { root, story } = await fixture(); const provider = new SceneLLM(); const generate = provider.generateStructured.bind(provider); let attempts = 0; provider.generateStructured = async (request: any) => { if (++attempts === 1) throw Object.assign(new Error("temporarily unavailable"), { status: 503, headers: { "retry-after": "0" } }); return generate(request); }; await expect(planStoredScenes({ root, story, chapter: 1, provider })).resolves.toMatchObject({ reused: false }); expect(attempts).toBe(2); });
  it("keeps manual edits as the image-generation source of truth", async () => { const { root, story } = await fixture(); const result = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() }); const scenes = structuredClone(result.manifest.scenes); scenes[0]!.visualPrompt = "A manually art-directed brass observatory"; const updated = await updateStoredSceneManifest({ root, story, chapter: 1, scenes }); expect(updated.manuallyEdited).toBe(true); expect(updated.manualRevision).toBe(1); expect(updated.scenes[0]!.visualPrompt).toContain("manually art-directed"); expect(updated.scenes[0]!.artwork.status).toBe("pending"); });
  it("saves only the selected chapter scene and rejects an outdated draft", async () => {
    const { root, story } = await fixture();
    const planned = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    const original = planned.manifest.scenes[0]!;
    const edited = { ...original, visualPrompt: "A revised brass telescope", artwork: { ...original.artwork, review: "approved" as const } };
    const updated = await updateStoredScene({ root, story, chapter: 1, sceneId: original.id, scene: edited, expectedFingerprint: sceneContentFingerprint(original) });
    expect(updated.scenes[0]!.visualPrompt).toBe(edited.visualPrompt);
    expect(updated.scenes[0]!.artwork.review).toBe("unreviewed");
    expect(updated.scenes[1]).toEqual(planned.manifest.scenes[1]);
    await expect(updateStoredScene({ root, story, chapter: 1, sceneId: original.id, scene: edited, expectedFingerprint: sceneContentFingerprint(original) })).rejects.toThrow("changed since it was opened");
  });
  it("re-resolves Chapter scene entity IDs from edited character names and removes stale identities", async () => {
    const { root, story, paths } = await fixture();
    await atomicWriteJson(paths.bibleUpdate, { chapterSummary: "Two canonical characters.", characters: [
      { canonicalEnglishName: "Mara", originalName: "瑪拉", description: "", firstSeenChapter: 1, lastSeenChapter: 1, aliases: ["Mara Vale"] },
      { canonicalEnglishName: "Zhang Yongxing", originalName: "张永兴", description: "", firstSeenChapter: 1, lastSeenChapter: 1, aliases: [] },
    ] });
    const planned = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    let scene = planned.manifest.scenes[0]!;
    const maraId = scene.entityIds![0]!;
    const saveCharacters = async (characters: string[]) => {
      const result = await updateStoredScene({ root, story, chapter: 1, sceneId: scene.id, scene: { ...scene, characters, entityIds: scene.entityIds }, expectedFingerprint: sceneContentFingerprint(scene) });
      scene = result.scenes[0]!;
      return scene.entityIds ?? [];
    };
    const zhangIds = await saveCharacters(["Zhang Yongxing"]);
    expect(zhangIds).toHaveLength(1); expect(zhangIds[0]).not.toBe(maraId);
    expect(await saveCharacters([])).toEqual([]);
    const both = await saveCharacters(["Mara", "Zhang Yongxing"]);
    expect(both).toHaveLength(2);
    const reordered = await saveCharacters(["Zhang Yongxing", "Mara"]);
    expect(reordered).toEqual([...both].reverse());
    expect(await saveCharacters(["Unresolved name"])).toEqual([]);
    expect(await saveCharacters(["Mara Vale"])).toEqual([maraId]);
    const currentManifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    const bulkSaved = await updateStoredSceneManifest({ root, story, chapter: 1, scenes: currentManifest.scenes.map((item, index) => index === 0 ? { ...item, characters: ["Zhang Yongxing"], entityIds: [maraId] } : item) });
    expect(bulkSaved.scenes[0]!.entityIds).toHaveLength(1);
    expect(bulkSaved.scenes[0]!.entityIds[0]).not.toBe(maraId);
  });
  it("rejects stale single-scene saves when any editable field changed, but ignores artwork-only changes", async () => {
    const { root, story, paths } = await fixture();
    const planned = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    const original = planned.manifest.scenes[0]!;
    const variants: Array<[string, Partial<typeof original>]> = [
      ["disabled", { disabled: true }],
      ["entityIds", { entityIds: ["ent_000000000000000000000001"] }],
      ["direction", { direction: { lighting: "blue" } as NonNullable<typeof original.direction> }],
      ["overrides", { overrides: { customVisualPrompt: "hand-set" } as NonNullable<typeof original.overrides> }],
      ["visualChanges", { visualChanges: { characters: [{ name: "Mara", op: "update", set: { wardrobe: "red coat" } }] } }],
      ["characters", { characters: ["Someone else"] }],
      ["timing", { startSeconds: 0.25, endSeconds: 12.25 }],
    ];
    for (const [field, patch] of variants) {
      await atomicWriteJson(paths.scenesManifest, { ...planned.manifest, scenes: [{ ...original, ...patch }, planned.manifest.scenes[1]] });
      await expect(updateStoredScene({ root, story, chapter: 1, sceneId: original.id, scene: original, expectedFingerprint: sceneContentFingerprint(original) }), field).rejects.toThrow("changed since it was opened");
    }
    await atomicWriteJson(paths.scenesManifest, { ...planned.manifest, scenes: [{ ...original, artwork: { ...original.artwork, status: "complete", review: "approved", imageFingerprint: "image-only-change" } }, planned.manifest.scenes[1]] });
    const saved = await updateStoredScene({ root, story, chapter: 1, sceneId: original.id, scene: { ...original, visualPrompt: "Edited after image review" }, expectedFingerprint: sceneContentFingerprint(original) });
    expect(saved.scenes[0]!.visualPrompt).toBe("Edited after image review");
    expect(saved.scenes[0]!.artwork.imageFingerprint).toBe("image-only-change");
  });
  it("proposal fingerprints track all editable scene and narration-linked inputs", async () => {
    const { root, story } = await fixture();
    const scene = (await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() })).manifest.scenes[0]!;
    const original = sceneProposalSourceFingerprint(scene);
    const variants: Array<Partial<typeof scene>> = [
      { characters: ["Zhang Yongxing"], entityIds: ["ent_000000000000000000000001"] },
      { entityIds: ["ent_000000000000000000000001"] },
      { disabled: true },
      { direction: { lighting: "blue" } as NonNullable<typeof scene.direction> },
      { overrides: { customVisualPrompt: "new" } as NonNullable<typeof scene.overrides> },
      { visualChanges: { environment: { set: { weather: "rain" } } } },
      { startSeconds: scene.startSeconds + 0.1 },
      { narrationText: "A different linked narration span" },
    ];
    for (const patch of variants) expect(sceneProposalSourceFingerprint({ ...scene, ...patch })).not.toBe(original);
    expect(sceneProposalSourceFingerprint({ ...scene, artwork: { ...scene.artwork, review: "approved" } })).toBe(original);
  });
  it("limits a selected Chapter artwork dry run to the requested scenes without image calls", async () => {
    const { root, story } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    const images = new FakeImages();
    const report = await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneIds: ["scene-002"], dryRun: true });
    expect(report.sceneIds).toEqual(["scene-002"]);
    expect(images.calls).toHaveLength(0);
    await expect(generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneIds: ["scene-099"], dryRun: true })).rejects.toThrow("not found");
  });
  it("does not mark Chapter artwork complete when a selected job leaves another scene ungenerated", async () => {
    const { root, story, paths } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    const images = new FakeImages();
    const result = await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneIds: ["scene-001"] });
    expect(result.generated).toBe(1);
    const chapter = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    expect(chapter.stages.artwork.status).toBe("pending");
  });
  it("previews chapter scene regeneration without writes and rejects a stale proposal", async () => {
    const { root, story, paths } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    const provider = new SceneLLM();
    provider.generateStructured = async (request: any) => ({ value: request.schema.parse({ visualPrompt: "A more cinematic brass observatory" }) });
    const before = await readFile(paths.scenesManifest, "utf8");
    const proposal = await previewStoredSceneRegeneration({ root, story, chapter: 1, sceneId: "scene-001", mode: "image_prompt", provider });
    expect(proposal.proposed.visualPrompt).toBe("A more cinematic brass observatory");
    expect(await readFile(paths.scenesManifest, "utf8")).toBe(before);
    const applied = await applyStoredSceneRegeneration({ root, story, chapter: 1, sceneId: "scene-001", proposal });
    expect(applied.scenes[0]!.visualPrompt).toBe(proposal.proposed.visualPrompt);
    expect(applied.scenes[0]!.summary).toBe(proposal.current.summary);
    await expect(applyStoredSceneRegeneration({ root, story, chapter: 1, sceneId: "scene-001", proposal })).rejects.toThrow("changed since the proposal");
    const currentScene = applied.scenes[0]!;
    const nextProposal = await previewStoredSceneRegeneration({ root, story, chapter: 1, sceneId: currentScene.id, mode: "image_prompt", provider });
    await updateStoredScene({ root, story, chapter: 1, sceneId: currentScene.id, scene: { ...currentScene, direction: { lighting: "blue" } }, expectedFingerprint: sceneContentFingerprint(currentScene) });
    await expect(applyStoredSceneRegeneration({ root, story, chapter: 1, sceneId: currentScene.id, proposal: nextProposal })).rejects.toThrow("changed since the proposal");
  });
  it("documents per-scene fields, the importance rubric, and subtitle timing usage", () => {
    // Bumped to v3: the planner schema gained visualChanges and the
    // instructions gained the PREVIOUS VISUAL CONTINUITY contract.
    expect(SCENE_PLANNER_PROMPT_VERSION).toBe("scene-planner-v3");
    expect(scenePlannerInstructions).toMatch(/summary.*characters.*location/s);
    expect(scenePlannerInstructions).toMatch(/major for a pivotal set-piece.*standard for a normal story beat.*transition for connective/s);
    expect(scenePlannerInstructions).toMatch(/OPTIONAL SUBTITLE TIMING is provided, use it/i);
  });
});

describe("artwork generation", () => {
  it("supports dry-run estimates, partial regeneration, fingerprints, and review states", async () => { const { root, story, paths } = await fixture(); await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() }); const images = new FakeImages(); const estimate = await generateStoredArtwork({ root, story, chapter: 1, provider: images, dryRun: true }); expect(estimate.imagesToGenerate).toBe(2); expect(images.calls).toHaveLength(0); const one = await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" }); expect(one.generated).toBe(1); expect(images.calls).toHaveLength(1); const reused = await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" }); expect(reused.generated).toBe(0); await reviewStoredArtwork({ root, story, chapter: 1, sceneId: "scene-001", review: "approved" }); const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8"))); expect(manifest.scenes[0]!.artwork.review).toBe("approved"); expect(artworkFingerprint(manifest.scenes[0]!, [], story, images.version)).toBe(manifest.scenes[0]!.artwork.fingerprint); });
  it("excludes disabled scenes from artwork generation, preflight, freshness, and stage counts while preserving their history", async () => {
    const { root, story, paths } = await fixture();
    const planned = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    const manifest = structuredClone(planned.manifest);
    manifest.scenes[1]!.disabled = true;
    manifest.scenes[1]!.artwork.status = "pending";
    manifest.scenes[1]!.artwork.review = "rejected";
    manifest.scenes[1]!.artwork.error = "preserved disabled history";
    await atomicWriteJson(paths.scenesManifest, manifest);
    const images = new FakeImages();
    const estimate = await generateStoredArtwork({ root, story, chapter: 1, provider: images, dryRun: true });
    expect(estimate.imagesToGenerate).toBe(1);
    expect(estimate.sceneIds).toEqual(["scene-001"]);
    expect(estimate.preflight?.entities.flatMap((entity: any) => entity.affectedSceneIds)).not.toContain("1:scene-002");
    const selectedDisabled = await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneIds: ["scene-002"], dryRun: true });
    expect(selectedDisabled.imagesToGenerate).toBe(0);
    expect(selectedDisabled.skippedDisabledSceneIds).toEqual(["scene-002"]);
    const selectedDisabledRun = await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-002" });
    expect(selectedDisabledRun.generated).toBe(0);
    expect(selectedDisabledRun.skippedDisabledSceneIds).toEqual(["scene-002"]);
    expect(images.calls).toHaveLength(0);
    const generated = await generateStoredArtwork({ root, story, chapter: 1, provider: images });
    expect(generated.generated).toBe(1);
    expect(images.calls).toHaveLength(1);
    const saved = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    expect(saved.scenes[1]).toMatchObject({ disabled: true, artwork: { status: "pending", review: "rejected", error: "preserved disabled history" } });
    expect((await generateStoredArtwork({ root, story, chapter: 1, provider: images, dryRun: true })).imagesToGenerate).toBe(0);
    const chapter = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    expect(chapter.stages.artwork.status).toBe("complete");
    expect(chapter.scenes).toEqual({ total: 2, generated: 1, approved: 0 });
  });
  it("reuses matching artwork after a scene is re-enabled", async () => {
    const { root, story, paths } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    const images = new FakeImages();
    await generateStoredArtwork({ root, story, chapter: 1, provider: images });
    const before = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    const disabledArtwork = structuredClone(before.scenes[1]!.artwork);
    before.scenes[1]!.disabled = true;
    await atomicWriteJson(paths.scenesManifest, before);
    expect((await generateStoredArtwork({ root, story, chapter: 1, provider: images })).generated).toBe(0);
    const enabledAgain = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    enabledAgain.scenes[1]!.disabled = false;
    await atomicWriteJson(paths.scenesManifest, enabledAgain);
    expect((await generateStoredArtwork({ root, story, chapter: 1, provider: images })).generated).toBe(0);
    expect(images.calls).toHaveLength(2);
    const after = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    expect(after.scenes[1]!.artwork).toEqual(disabledArtwork);
  });
  it("keeps the Chapter artwork aggregate ready when a finished scene is disabled", async () => {
    const { root, story, paths } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    await generateStoredArtwork({ root, story, chapter: 1, provider: new FakeImages() });
    const scene = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8"))).scenes[1]!;
    const history = structuredClone(scene.artwork);
    await updateStoredScene({ root, story, chapter: 1, sceneId: scene.id, scene: { ...scene, disabled: true }, expectedFingerprint: sceneContentFingerprint(scene) });
    const chapter = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    const after = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    expect(chapter.stages.artwork.status).toBe("complete");
    expect(chapter.stages.video.status).toBe("pending");
    expect(after.scenes[1]!.artwork).toEqual(history);
    expect(after.scenes[1]!.disabled).toBe(true);
  });
  it("regenerates only edited scenes, remakes art after style changes, and leaves TTS untouched", async () => { const { root, story, paths } = await fixture(); const planner = new SceneLLM(); const planned = await planStoredScenes({ root, story, chapter: 1, provider: planner }); const images = new FakeImages(); await generateStoredArtwork({ root, story, chapter: 1, provider: images }); const beforeChapter = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8"))); const edited = structuredClone(planned.manifest.scenes); edited[1]!.visualPrompt = "A hand-directed cobalt constellation map"; await updateStoredSceneManifest({ root, story, chapter: 1, scenes: edited }); const partial = await generateStoredArtwork({ root, story, chapter: 1, provider: images }); expect(partial.generated).toBe(1); expect(images.calls).toHaveLength(3); const restyled = { ...story, artwork: { ...story.artwork, stylePrompt: `${story.artwork.stylePrompt}, watercolor texture` } }; const styleRun = await generateStoredArtwork({ root, story: restyled, chapter: 1, provider: images }); expect(styleRun.generated).toBe(2); expect(images.calls).toHaveLength(5); expect(planner.calls).toHaveLength(1); const afterChapter = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8"))); expect(afterChapter.stages.tts).toEqual(beforeChapter.stages.tts); });
  it("routes providers without coupling scene planning to a vendor", () => { const images = new FakeImages(); expect(new ImageProviderRouter(new Map([["openai", images]])).forName("openai")).toBe(images); expect(() => new ImageProviderRouter(new Map()).forName("missing")).toThrow("not registered"); });
  it("verifies cached image bytes and does not require credentials for an intact cache hit", async () => {
    const { root, story, paths } = await fixture(); await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() }); const images = new FakeImages(); await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });
    const cacheOnly: ImageProvider = { name: images.name, version: images.version, validateConfiguration: async () => { throw new Error("missing key"); }, generate: (request) => images.generate(request) }; await expect(generateStoredArtwork({ root, story, chapter: 1, provider: cacheOnly, sceneId: "scene-001" })).resolves.toMatchObject({ generated: 0, reused: 1 });
    await atomicWrite(sceneImagePath(root, story.slug, 1, "scene-001"), Buffer.from("tampered")); await expect(reviewStoredArtwork({ root, story, chapter: 1, sceneId: "scene-001", review: "approved" })).rejects.toThrow("intact");
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" }); expect(images.calls).toHaveLength(2); expect((await readFile(paths.scenesManifest, "utf8"))).toContain("imageFingerprint");
  });
  it("retries a transient image-provider failure", async () => { const { root, story } = await fixture(); await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() }); const images = new FakeImages(); const generate = images.generate.bind(images); let attempts = 0; images.generate = async (request: any) => { if (++attempts === 1) throw Object.assign(new Error("temporarily unavailable"), { status: 503, headers: { "retry-after": "0" } }); return generate(request); }; await expect(generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" })).resolves.toMatchObject({ generated: 1 }); expect(attempts).toBe(2); });
  it("derives composition orientation from the configured artwork size", async () => {
    const { root, story } = await fixture(); await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    const landscapeImages = new FakeImages(); await generateStoredArtwork({ root, story, chapter: 1, provider: landscapeImages, sceneId: "scene-001" }); expect(landscapeImages.calls[0].prompt).toContain("landscape-safe composition");
    const portraitStory = { ...story, artwork: { ...story.artwork, aspectRatio: "9:16" as const, size: "1024x1536" as const } }; const portraitImages = new FakeImages(); await generateStoredArtwork({ root, story: portraitStory, chapter: 1, provider: portraitImages, sceneId: "scene-002" }); expect(portraitImages.calls[0].prompt).toContain("portrait-safe composition");
    expect(landscapeImages.calls[0].prompt).not.toContain("16:9-safe");
  });
});

describe("scene artwork video selection", () => {
  it("uses a complete approved scene reel and emits ordered FFmpeg image inputs", async () => { const { root, story, paths } = await fixture(); await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() }); const images = new FakeImages(); await generateStoredArtwork({ root, story, chapter: 1, provider: images }); const raw = JSON.parse(await readFile(paths.scenesManifest, "utf8")) as SceneManifest; for (const scene of raw.scenes) scene.artwork.review = "approved"; await atomicWriteJson(paths.scenesManifest, raw); const video = new CaptureVideo(); await renderStoredChapterVideo({ root, story: { ...story, video: { ...story.video, subtitleMode: "none" } }, chapter: 1, processor: video }); expect(video.input.sceneArtwork).toHaveLength(2); const command = buildVideoArgs({ ...video.input, audioDurationSeconds: 30 }, "out.mp4", { ...story.video, subtitleMode: "none" }).join(" "); expect(command).toContain(sceneImagePath(root, story.slug, 1, "scene-001")); expect(command).toContain("concat=n=2:v=1:a=0"); });
  it("omits disabled Chapter artwork, re-times active scenes to audio, and fingerprints enablement only", async () => {
    const { root, story, paths } = await fixture();
    const planned = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
    const threeScenePlan = structuredClone(planned.manifest);
    const third = structuredClone(threeScenePlan.scenes[1]!);
    third.id = "scene-003"; third.summary = "A third visual beat."; third.startSeconds = 20; third.endSeconds = 30;
    threeScenePlan.scenes[0]!.startSeconds = 0; threeScenePlan.scenes[0]!.endSeconds = 10;
    threeScenePlan.scenes[1]!.startSeconds = 10; threeScenePlan.scenes[1]!.endSeconds = 20;
    threeScenePlan.scenes.push(third);
    await atomicWriteJson(paths.scenesManifest, sceneManifestSchema.parse(threeScenePlan));
    await generateStoredArtwork({ root, story, chapter: 1, provider: new FakeImages() });
    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    for (const scene of manifest.scenes) scene.artwork.review = "approved";
    const preservedDisabledImageFingerprint = manifest.scenes[1]!.artwork.imageFingerprint;
    await atomicWriteJson(paths.scenesManifest, manifest);
    const videoStory = { ...story, video: { ...story.video, subtitleMode: "none" as const } };
    const renderer = new CaptureVideo();
    const first = await renderStoredChapterVideo({ root, story: videoStory, chapter: 1, processor: renderer });
    expect(first.reused).toBe(false);
    expect(renderer.input.sceneArtwork).toHaveLength(3);
    const disabledManifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    disabledManifest.scenes[1]!.disabled = true;
    disabledManifest.scenes[1]!.artwork.review = "rejected";
    disabledManifest.scenes[1]!.artwork.status = "failed";
    await atomicWriteJson(paths.scenesManifest, disabledManifest);
    await atomicWrite(sceneImagePath(root, story.slug, 1, "scene-002"), "corrupt disabled art");
    const disabledRender = await renderStoredChapterVideo({ root, story: videoStory, chapter: 1, processor: renderer });
    expect(disabledRender.reused).toBe(false);
    expect(renderer.input.sceneArtwork).toHaveLength(2);
    expect(renderer.input.sceneArtwork.map((item: any) => item.durationSeconds)).toEqual([15, 15]);
    expect(renderer.input.sceneArtwork.reduce((sum: number, item: any) => sum + item.durationSeconds, 0)).toBe(30);
    expect(renderer.input.sceneArtwork.map((item: any) => item.path)).not.toContain(sceneImagePath(root, story.slug, 1, "scene-002"));
    const changedDisabledHistory = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    changedDisabledHistory.scenes[1]!.artwork.review = "unreviewed";
    changedDisabledHistory.scenes[1]!.artwork.fingerprint = "changed-disabled-fingerprint";
    await atomicWriteJson(paths.scenesManifest, changedDisabledHistory);
    expect((await renderStoredChapterVideo({ root, story: videoStory, chapter: 1, processor: renderer })).reused).toBe(true);
    const reenabled = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    reenabled.scenes[1]!.disabled = false;
    reenabled.scenes[1]!.artwork.status = "complete";
    reenabled.scenes[1]!.artwork.review = "approved";
    reenabled.scenes[1]!.artwork.imageFingerprint = preservedDisabledImageFingerprint;
    await atomicWriteJson(paths.scenesManifest, reenabled);
    await atomicWrite(sceneImagePath(root, story.slug, 1, "scene-002"), PNG_1X1);
    expect((await renderStoredChapterVideo({ root, story: videoStory, chapter: 1, processor: renderer })).reused).toBe(false);
    expect(renderer.input.sceneArtwork).toHaveLength(3);
  });
  it("falls back when any scene image is not approved", async () => { const { root, story } = await fixture(); await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() }); await generateStoredArtwork({ root, story, chapter: 1, provider: new FakeImages() }); await reviewStoredArtwork({ root, story, chapter: 1, sceneId: "scene-001", review: "approved" }); const video = new CaptureVideo(); await renderStoredChapterVideo({ root, story: { ...story, video: { ...story.video, subtitleMode: "none", backgroundMode: "gradient" } }, chapter: 1, processor: video }); expect(video.input.sceneArtwork).toBeUndefined(); expect(video.input.cover).toBeUndefined(); });
});
