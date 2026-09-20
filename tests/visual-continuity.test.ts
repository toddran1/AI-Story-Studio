import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getScenesDashboard } from "../apps/server/catalog.js";
import { JobManager } from "../apps/server/job-manager.js";
import { StudioOperations } from "../apps/server/operations.js";
import { generateStoredArtwork } from "../src/artwork/generator.js";
import { ImageProvider } from "../src/artwork/provider.js";
import { loadEnvironment } from "../src/config/env.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { LLMProvider } from "../src/llm/provider.js";
import { LLMRouter } from "../src/llm/router.js";
import { planStoredScenes, sceneContentFingerprint, updateStoredSceneManifest } from "../src/scenes/manifest.js";
import { sceneManifestSchema } from "../src/scenes/types.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { readJsonIfExists } from "../src/storage/story-files.js";
import { fingerprint } from "../src/utils/hash.js";
import {
  loadVisualContinuityHandoff,
  persistChapterVisualContinuity,
  removeVisualContinuityOverride,
  resolveChapterVisualContinuity,
  resolveVisualContinuity,
  upsertVisualContinuityOverride,
  visualContinuityHandoffSchema,
  VisualContinuityState,
} from "../src/visual-canon/continuity.js";
import { testStory } from "./helpers.js";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const env = loadEnvironment({});

class SceneLLM implements LLMProvider {
  readonly name = "openai" as const;
  calls: any[] = [];
  constructor(private plan: unknown) {}
  async validateConfiguration() {}
  async generateText() { return { text: "" }; }
  async generateStructured<T>(request: any): Promise<any> { this.calls.push(request); return { value: request.schema.parse(this.plan) as T }; }
}
class FakeImages implements ImageProvider {
  readonly name = "openai";
  readonly version = "fake-images-v1";
  calls: any[] = [];
  async validateConfiguration() {}
  async generate(request: any) { this.calls.push(request); return { data: PNG_1X1, mimeType: "image/png" as const }; }
}

const nightPlan = {
  scenes: [
    { summary: "Mara shelters in the warehouse, bleeding.", startSeconds: 0, endSeconds: 15, characters: ["Mara"], location: "Warehouse", visualPrompt: "Mara clutching her arm among crates", importance: "standard",
      visualChanges: { characters: [{ name: "Mara", op: "enter", set: { injuries: "bleeding left arm", equipment: "iron lantern" } }], environment: { set: { description: "abandoned warehouse", timeOfDay: "night" } }, objects: [{ name: "iron lantern", op: "add", set: { possessedBy: "Mara" } }] } },
    { summary: "She binds the wound and moves on.", startSeconds: 15, endSeconds: 30, characters: ["Mara"], location: "Warehouse", visualPrompt: "Mara wrapping a bandage", importance: "standard" },
  ],
};
const beachPlan = {
  scenes: [
    { summary: "Mara reaches the sunny beach.", startSeconds: 0, endSeconds: 15, characters: ["Mara"], location: "Beach", visualPrompt: "Mara on a bright afternoon beach", importance: "standard",
      visualChanges: { environment: { set: { description: "sunny beach", timeOfDay: "afternoon" } } } },
    { summary: "She rests by the waves.", startSeconds: 15, endSeconds: 30, characters: ["Mara"], location: "Beach", visualPrompt: "Mara sitting by gentle waves", importance: "standard" },
  ],
};

async function chapterFixture(root: string, story: ReturnType<typeof testStory>, chapterNumber: number) {
  const paths = storyPaths(root, story.slug, chapterNumber); const now = new Date().toISOString();
  const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
  const chapter = chapterSchema.parse({ chapter: chapterNumber, originalTitle: `Chapter ${chapterNumber}`, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 50, englishWords: 20, narrationWords: 18 }, createdAt: now, updatedAt: now, stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: complete, subtitles: { status: "pending" }, scenePlanning: { status: "pending" }, artwork: { status: "pending" }, video: { status: "pending" } }, audio: { durationSeconds: 30, codec: "mp3", container: "mp3" } });
  await atomicWriteJson(paths.chapterMeta, chapter);
  await atomicWrite(paths.narration, `Narration for chapter ${chapterNumber}. Mara continues her journey onward.`);
  await atomicWrite(paths.audio, Buffer.from(`mastered-${chapterNumber}`));
  return paths;
}

async function storyRoot(chapters: number[]) {
  const root = await mkdtemp(join(tmpdir(), "visual-continuity-")); const story = testStory();
  await atomicWriteJson(storyPaths(root, story.slug, 1).storyConfig, story);
  for (const chapter of chapters) await chapterFixture(root, story, chapter);
  return { root, story };
}

describe("visual continuity resolver", () => {
  it("folds scene deltas so scene 1 end state is scene 2 start state", () => {
    const resolved = resolveVisualContinuity({ scenes: [
      { id: "scene-001", visualChanges: { characters: [{ name: "Mara", op: "enter", set: { injuries: "bleeding left arm", wardrobe: "red coat" } }] } },
      { id: "scene-002" },
    ] });
    expect(resolved.perScene[1]!.startState).toEqual(resolved.perScene[0]!.endState);
    expect(resolved.perScene[1]!.startState.characters[0]).toMatchObject({ name: "Mara", injuries: "bleeding left arm" });
    expect(resolved.chapterEndState.characters).toHaveLength(1);
  });

  it("lets current narration override inherited environment instead of carrying it", () => {
    const handoffState: VisualContinuityState = { characters: [{ name: "Mara", injuries: "bleeding left arm" }], environment: { description: "abandoned warehouse", timeOfDay: "night" }, objects: [] };
    const resolved = resolveVisualContinuity({
      previousHandoff: { chapter: 408, sceneId: "scene-003", state: handoffState, referenceArtwork: { sceneId: "scene-003", versionId: "v1", versionNumber: 1, imageFingerprint: "fp-prev" } },
      scenes: [{ id: "scene-001", location: "Beach", visualChanges: { environment: { set: { description: "sunny beach", timeOfDay: "afternoon" } } } }],
    });
    expect(resolved.perScene[0]!.endState.environment).toMatchObject({ description: "sunny beach", timeOfDay: "afternoon" });
    expect(resolved.perScene[0]!.endState.environment).not.toMatchObject({ description: "abandoned warehouse" });
    expect(resolved.decisions.some((d) => d.kind === "overridden" && /new setting/.test(d.summary))).toBe(true);
    // Persistent state is carried when uncontradicted
    expect(resolved.perScene[0]!.endState.characters[0]).toMatchObject({ injuries: "bleeding left arm" });
    // Previous chapter artwork is rejected when location/time changed
    expect(resolved.perScene[0]!.referenceDecision).toMatchObject({ kind: "previous-chapter", used: false });
    expect(resolved.perScene[0]!.referenceDecision!.reason).toMatch(/location or time changed/);
  });

  it("carries injuries and equipment across scenes and chapters when uncontradicted", () => {
    const resolved = resolveVisualContinuity({
      previousHandoff: { chapter: 7, sceneId: "scene-002", state: { characters: [{ name: "Mara", injuries: "scarred arm", equipment: "iron lantern" }], objects: [{ name: "iron lantern", possessedBy: "Mara" }] } },
      scenes: [{ id: "scene-001" }, { id: "scene-002" }],
    });
    expect(resolved.chapterEndState.characters[0]).toMatchObject({ injuries: "scarred arm", equipment: "iron lantern" });
    expect(resolved.decisions.some((d) => d.kind === "carried")).toBe(true);
  });

  it("clears state on exit, removal, and explicit field clears", () => {
    const resolved = resolveVisualContinuity({ scenes: [
      { id: "scene-001", visualChanges: { characters: [{ name: "Mara", op: "enter", set: { injuries: "bleeding left arm" } }, { name: "Borin", op: "enter" }], objects: [{ name: "iron lantern", op: "add" }] } },
      { id: "scene-002", visualChanges: { characters: [{ name: "Borin", op: "exit" }, { name: "Mara", op: "update", clear: ["injuries"] }], objects: [{ name: "iron lantern", op: "remove" }] } },
    ] });
    const end = resolved.perScene[1]!.endState;
    expect(end.characters.map((c) => c.name)).toEqual(["Mara"]);
    expect(end.characters[0]!.injuries).toBeUndefined();
    expect(end.objects).toHaveLength(0);
    expect(resolved.decisions.filter((d) => d.kind === "dropped")).toHaveLength(2);
  });

  it("selects previous scene approved artwork and rejects it across locations", () => {
    const resolved = resolveVisualContinuity({ scenes: [
      { id: "scene-001", location: "Warehouse", approvedArtwork: { versionId: "v2", versionNumber: 2, imageFingerprint: "fp-1" } },
      { id: "scene-002", location: "Warehouse", approvedArtwork: { versionId: "v1", versionNumber: 1, imageFingerprint: "fp-2" } },
      { id: "scene-003", location: "Rooftop" },
    ] });
    expect(resolved.perScene[1]!.referenceDecision).toMatchObject({ kind: "previous-scene", used: true, sourceSceneId: "scene-001", imageFingerprint: "fp-1" });
    expect(resolved.perScene[2]!.referenceDecision).toMatchObject({ kind: "previous-scene", used: false });
    expect(resolved.perScene[2]!.referenceDecision!.reason).toMatch(/new location/);
  });

  it("accepts the previous chapter final artwork when the setting is continuous", () => {
    const resolved = resolveVisualContinuity({
      previousHandoff: { chapter: 408, sceneId: "scene-002", state: { characters: [], environment: { description: "warehouse", timeOfDay: "night" }, objects: [] }, referenceArtwork: { sceneId: "scene-002", versionId: "v1", versionNumber: 1, imageFingerprint: "fp-final" } },
      scenes: [{ id: "scene-001", location: "Warehouse" }],
    });
    expect(resolved.perScene[0]!.referenceDecision).toMatchObject({ kind: "previous-chapter", used: true, sourceChapter: 408, imageFingerprint: "fp-final" });
  });

  it("applies manual overrides last and conservatively when stale", () => {
    const scene = { id: "scene-001", contentFingerprint: "fp-new", visualChanges: { characters: [{ name: "Mara", op: "enter" as const, set: { wardrobe: "red coat" } }] } };
    const overlay = { version: 1 as const, entries: [{ sceneId: "scene-001", note: "Mara changed into a blue cloak", setState: { characters: [{ name: "Mara", wardrobe: "blue cloak" }] }, revision: 2, updatedAt: new Date().toISOString(), sceneContentFingerprint: "fp-old" }] };
    const resolved = resolveVisualContinuity({ scenes: [scene], manualOverrides: overlay });
    // Stale content fingerprint: note-level intent only, setState skipped
    expect(resolved.perScene[0]!.endState.characters[0]).toMatchObject({ wardrobe: "red coat" });
    expect(resolved.perScene[0]!.manualOverride).toMatchObject({ stale: true, revision: 2 });
    const fresh = resolveVisualContinuity({ scenes: [{ ...scene, contentFingerprint: "fp-old" }], manualOverrides: overlay });
    expect(fresh.perScene[0]!.endState.characters[0]).toMatchObject({ wardrobe: "blue cloak" });
    expect(fresh.decisions.some((d) => d.kind === "manual")).toBe(true);
  });

  it("keeps semantic fingerprints free of timestamps", () => {
    const scenes = [{ id: "scene-001", visualChanges: { characters: [{ name: "Mara", op: "enter" as const }] } }];
    const first = resolveVisualContinuity({ scenes });
    const second = resolveVisualContinuity({ scenes });
    expect(fingerprint(first.chapterEndState)).toBe(fingerprint(second.chapterEndState));
  });
});

describe("chapter handoff artifacts and planning integration", () => {
  it("persists the chapter end state and feeds it into the next chapter's planning input", async () => {
    const { root, story } = await storyRoot([1, 2]);
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) });
    const handoff = visualContinuityHandoffSchema.parse(await readJsonIfExists(storyPaths(root, story.slug, 1).visualContinuity));
    expect(handoff.source).toEqual({ chapter: 1, sceneId: "scene-002" });
    expect(handoff.state.environment).toMatchObject({ description: "abandoned warehouse", timeOfDay: "night" });
    expect(handoff.state.characters[0]).toMatchObject({ name: "Mara", injuries: "bleeding left arm" });
    expect(handoff.stateFingerprint).toBe(fingerprint(handoff.state));
    expect(handoff.origin).toBe("automatic");

    const planner = new SceneLLM(beachPlan);
    await planStoredScenes({ root, story, chapter: 2, provider: planner });
    expect(planner.calls[0].input).toContain("PREVIOUS VISUAL CONTINUITY");
    expect(planner.calls[0].input).toContain("night");
    expect(planner.calls[0].input).toContain("bleeding left arm");
    // Chapter 2 resolution: narration override, injury carried
    const { resolved, previous } = await resolveChapterVisualContinuity({ root, slug: story.slug, chapter: 2, manifest: sceneManifestSchema.parse(await readJsonIfExists(storyPaths(root, story.slug, 2).scenesManifest)) });
    expect(previous).toMatchObject({ chapter: 1, sceneId: "scene-002", stateFingerprint: handoff.stateFingerprint });
    expect(resolved.perScene[0]!.endState.environment).toMatchObject({ timeOfDay: "afternoon" });
    expect(resolved.chapterEndState.characters[0]).toMatchObject({ injuries: "bleeding left arm" });
  });

  it("plans chapter 1 normally with no continuity section and no handoff", async () => {
    const { root, story } = await storyRoot([1]);
    const planner = new SceneLLM(nightPlan);
    const result = await planStoredScenes({ root, story, chapter: 1, provider: planner });
    expect(result.reused).toBe(false);
    expect(planner.calls[0].input).not.toContain("PREVIOUS VISUAL CONTINUITY");
    const { previous } = await resolveChapterVisualContinuity({ root, slug: story.slug, chapter: 1, manifest: result.manifest });
    expect(previous).toBeUndefined();
  });

  it("treats a corrupt previous handoff as absent and still plans", async () => {
    const { root, story } = await storyRoot([1, 2]);
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) });
    await atomicWrite(storyPaths(root, story.slug, 1).visualContinuity, "{ not json");
    const planner = new SceneLLM(beachPlan);
    await expect(planStoredScenes({ root, story, chapter: 2, provider: planner })).resolves.toMatchObject({ reused: false });
    // Legacy lazy derivation: the previous manifest carries deltas, so continuity is rebuilt incrementally
    expect(planner.calls[0].input).toContain("PREVIOUS VISUAL CONTINUITY");
  });

  it("makes the next chapter stale when the previous handoff changes, leaving earlier chapters current", async () => {
    const { root, story } = await storyRoot([1, 2]);
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) });
    await planStoredScenes({ root, story, chapter: 2, provider: new SceneLLM(beachPlan) });
    expect((await planStoredScenes({ root, story, chapter: 2, provider: new SceneLLM(beachPlan) })).reused).toBe(true);

    const handoffPath = storyPaths(root, story.slug, 1).visualContinuity;
    const handoff = visualContinuityHandoffSchema.parse(await readJsonIfExists(handoffPath));
    const changed = { ...handoff, state: { ...handoff.state, characters: [{ name: "Mara", injuries: "broken leg" }] } };
    await atomicWriteJson(handoffPath, { ...changed, stateFingerprint: fingerprint(changed.state), updatedAt: new Date().toISOString() });

    expect((await planStoredScenes({ root, story, chapter: 2, provider: new SceneLLM(beachPlan) })).reused).toBe(false);
    expect((await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) })).reused).toBe(true);
  });

  it("folds a scene 2 delta edit forward to scene 3 while scene 1 is untouched", async () => {
    const { root, story } = await storyRoot([1]);
    const denseStory = { ...story, scenes: { ...story.scenes, targetDurationSeconds: 10, minimumDurationSeconds: 10 } };
    const threeScenePlan = { scenes: [
      { summary: "A", startSeconds: 0, endSeconds: 10, characters: ["Mara"], location: "Warehouse", visualPrompt: "A", importance: "standard" as const },
      { summary: "B", startSeconds: 10, endSeconds: 20, characters: ["Mara"], location: "Warehouse", visualPrompt: "B", importance: "standard" as const, visualChanges: { characters: [{ name: "Mara", op: "enter", set: { injuries: "cut hand" } }] } },
      { summary: "C", startSeconds: 20, endSeconds: 30, characters: ["Mara"], location: "Warehouse", visualPrompt: "C", importance: "standard" as const },
    ] };
    const planned = await planStoredScenes({ root, story: denseStory, chapter: 1, provider: new SceneLLM(threeScenePlan) });
    const edited = structuredClone(planned.manifest.scenes);
    edited[1]!.visualChanges = { characters: [{ name: "Mara", op: "enter", set: { injuries: "burned hand", equipment: "silver ring" } }] };
    const updated = await updateStoredSceneManifest({ root, story: denseStory, chapter: 1, scenes: edited });
    expect(updated.scenes[1]!.artwork.status).toBe("pending");
    const { resolved } = await resolveChapterVisualContinuity({ root, slug: story.slug, chapter: 1, manifest: updated });
    expect(resolved.perScene[0]!.endState.characters).toHaveLength(0);
    expect(resolved.perScene[2]!.startState.characters[0]).toMatchObject({ injuries: "burned hand", equipment: "silver ring" });
  });

  it("survives forced re-planning, wins in resolution, and resets on delete", async () => {
    const { root, story } = await storyRoot([1]);
    const planned = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) });
    await upsertVisualContinuityOverride({ root, slug: story.slug, chapter: 1, entry: { sceneId: "scene-002", note: "Mara's wound was healed off-page", setState: { characters: [{ name: "Mara", injuries: undefined, condition: "recovered" }] }, revision: 1, updatedAt: new Date().toISOString(), sceneContentFingerprint: sceneContentFingerprint(planned.manifest.scenes[1]!) } });
    const replanned = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan), force: true });
    expect(replanned.reused).toBe(false);
    const overlayRaw = await readJsonIfExists<{ entries: unknown[] }>(storyPaths(root, story.slug, 1).visualContinuityManual);
    expect(overlayRaw?.entries).toHaveLength(1);
    const { resolved } = await resolveChapterVisualContinuity({ root, slug: story.slug, chapter: 1, manifest: replanned.manifest });
    expect(resolved.chapterEndState.characters[0]).toMatchObject({ condition: "recovered" });
    await removeVisualContinuityOverride({ root, slug: story.slug, chapter: 1, sceneId: "scene-002" });
    const reset = await resolveChapterVisualContinuity({ root, slug: story.slug, chapter: 1, manifest: replanned.manifest });
    expect(reset.resolved.chapterEndState.characters[0]).toMatchObject({ injuries: "bleeding left arm" });
  });

  it("loads legacy manifests without visualChanges without rewriting them", async () => {
    const { root, story } = await storyRoot([1]);
    const legacyPlan = { scenes: [
      { summary: "A", startSeconds: 0, endSeconds: 15, characters: ["Mara"], location: "Warehouse", visualPrompt: "A", importance: "standard" },
      { summary: "B", startSeconds: 15, endSeconds: 30, characters: ["Mara"], location: "Warehouse", visualPrompt: "B", importance: "standard" },
    ] };
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(legacyPlan) });
    const before = await readFile(storyPaths(root, story.slug, 1).scenesManifest, "utf8");
    const { resolved, previous } = await resolveChapterVisualContinuity({ root, slug: story.slug, chapter: 1, manifest: sceneManifestSchema.parse(JSON.parse(before)) });
    expect(previous).toBeUndefined();
    expect(resolved.chapterEndState).toEqual({ characters: [], objects: [] });
    expect(resolved.perScene[0]!.changes).toBeUndefined();
    expect(await readFile(storyPaths(root, story.slug, 1).scenesManifest, "utf8")).toBe(before);
  });

  it("keeps a stable state fingerprint across repeated persistence", async () => {
    const { root, story } = await storyRoot([1]);
    const planned = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) });
    await persistChapterVisualContinuity({ root, slug: story.slug, chapter: 1, manifest: planned.manifest });
    const first = await loadVisualContinuityHandoff(root, story.slug, 1);
    await persistChapterVisualContinuity({ root, slug: story.slug, chapter: 1, manifest: planned.manifest });
    const second = await loadVisualContinuityHandoff(root, story.slug, 1);
    expect(first!.stateFingerprint).toBe(second!.stateFingerprint);
    expect(first!.updatedAt).toBe(second!.updatedAt);
  });
});

describe("artwork continuity references", () => {
  async function twoChapterArtwork(storyModel: string) {
    const { root, story } = await storyRoot([1, 2]);
    const imageStory = { ...story, artwork: { ...story.artwork, model: storyModel } };
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) });
    const images = new FakeImages();
    await generateStoredArtwork({ root, story: imageStory, chapter: 1, provider: images, sceneId: "scene-002" });
    const operations = new StudioOperations(root, env, new JobManager(), { llm: new LLMRouter(new Map()) });
    await operations.reviewArtwork(story.slug, 1, "scene-002", "approved");
    await persistChapterVisualContinuity({ root, slug: story.slug, chapter: 1, manifest: sceneManifestSchema.parse(await readJsonIfExists(storyPaths(root, story.slug, 1).scenesManifest)) });
    await planStoredScenes({ root, story, chapter: 2, provider: new SceneLLM(beachPlan) });
    return { root, story: imageStory, images };
  }

  it("falls back to textual continuity when the provider cannot consume reference images", async () => {
    // gpt-image-1 does not accept reference images; the continuity decision is
    // relevant (same warehouse setting) so provenance must record the fallback.
    const { root, story, images } = await twoChapterArtwork("gpt-image-1");
    images.calls.length = 0;
    const continuePlan = { scenes: [
      { summary: "Mara searches the warehouse at night.", startSeconds: 0, endSeconds: 15, characters: ["Mara"], location: "Warehouse", visualPrompt: "Mara among the crates", importance: "standard" },
      { summary: "She finds the ledger.", startSeconds: 15, endSeconds: 30, characters: ["Mara"], location: "Warehouse", visualPrompt: "A dusty ledger", importance: "standard" },
    ] };
    await planStoredScenes({ root, story, chapter: 2, provider: new SceneLLM(continuePlan), force: true });
    const result = await generateStoredArtwork({ root, story, chapter: 2, provider: images, sceneId: "scene-001" });
    expect(result.generated).toBe(1);
    expect(images.calls[0].prompt).toContain("CURRENT VISUAL CONTINUITY");
    expect(images.calls[0].prompt).toContain("bleeding left arm");
    expect(images.calls[0].referenceImages ?? []).toHaveLength(0);
    const manifest = sceneManifestSchema.parse(await readJsonIfExists(storyPaths(root, story.slug, 2).scenesManifest));
    const version = manifest.scenes[0]!.artwork.versions.at(-1)!;
    expect(version.provenance).toMatchObject({ referencesUsed: "text-only" });
    expect(version.provenance?.continuityReference).toMatchObject({ kind: "previous-chapter", used: false });
    expect(String((version.provenance?.continuityReference as { reason?: string })?.reason)).toMatch(/cannot consume reference images/);
  });

  it("rejects the previous chapter artwork when the setting changed and records the decision", async () => {
    const { root, story, images } = await twoChapterArtwork("gpt-image-2.5-flare");
    images.calls.length = 0;
    await generateStoredArtwork({ root, story, chapter: 2, provider: images, sceneId: "scene-001" });
    // beachPlan scene 1 moves to the beach: no previous-chapter reference image
    const referenceRoles = (images.calls[0].referenceImages ?? []).map((ref: { role?: string }) => ref.role);
    expect(referenceRoles).not.toContain("previous-chapter");
    const manifest = sceneManifestSchema.parse(await readJsonIfExists(storyPaths(root, story.slug, 2).scenesManifest));
    const version = manifest.scenes[0]!.artwork.versions.at(-1)!;
    expect(version.provenance?.continuityReference).toMatchObject({ kind: "previous-chapter", used: false });
    expect(String(version.provenance?.continuityReference && (version.provenance.continuityReference as { reason?: string }).reason)).toMatch(/location or time changed/);
  });

  it("sends the previous scene approved artwork as a continuity reference when continuous", async () => {
    const { root, story } = await storyRoot([1]);
    const imageStory = { ...story, artwork: { ...story.artwork, model: "gpt-image-2.5-flare" } };
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) });
    const images = new FakeImages();
    await generateStoredArtwork({ root, story: imageStory, chapter: 1, provider: images, sceneId: "scene-001" });
    const operations = new StudioOperations(root, env, new JobManager(), { llm: new LLMRouter(new Map()) });
    await operations.reviewArtwork(story.slug, 1, "scene-001", "approved");
    images.calls.length = 0;
    await generateStoredArtwork({ root, story: imageStory, chapter: 1, provider: images, sceneId: "scene-002" });
    const referenceRoles = (images.calls[0].referenceImages ?? []).map((ref: { role?: string }) => ref.role);
    expect(referenceRoles).toContain("previous-scene");
    const manifest = sceneManifestSchema.parse(await readJsonIfExists(storyPaths(root, story.slug, 1).scenesManifest));
    expect(manifest.scenes[1]!.artwork.versions.at(-1)!.provenance?.continuityReference).toMatchObject({ kind: "previous-scene", used: true });
  });

  it("keeps generating with textual continuity when the previous artwork file is missing", async () => {
    const { root, story } = await storyRoot([1]);
    const imageStory = { ...story, artwork: { ...story.artwork, model: "gpt-image-2.5-flare" } };
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) });
    const images = new FakeImages();
    await generateStoredArtwork({ root, story: imageStory, chapter: 1, provider: images, sceneId: "scene-001" });
    const operations = new StudioOperations(root, env, new JobManager(), { llm: new LLMRouter(new Map()) });
    await operations.reviewArtwork(story.slug, 1, "scene-001", "approved");
    await atomicWrite(storyPaths(root, story.slug, 1).scenesDirectory + "/scene-001-v1.png", Buffer.from("corrupt"));
    images.calls.length = 0;
    await expect(generateStoredArtwork({ root, story: imageStory, chapter: 1, provider: images, sceneId: "scene-002" })).resolves.toMatchObject({ generated: 1 });
    const manifest = sceneManifestSchema.parse(await readJsonIfExists(storyPaths(root, story.slug, 1).scenesManifest));
    const provenance = manifest.scenes[1]!.artwork.versions.at(-1)!.provenance?.continuityReference as { used: boolean; reason?: string };
    expect(provenance.used).toBe(false);
    expect(provenance.reason).toMatch(/unavailable/);
  });
});

describe("scenes dashboard and override endpoint", () => {
  it("exposes per-scene continuity and the previous handoff on the dashboard", async () => {
    const { root, story } = await storyRoot([1, 2]);
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) });
    await planStoredScenes({ root, story, chapter: 2, provider: new SceneLLM(beachPlan) });
    const dashboard = await getScenesDashboard(root, story.slug, 2);
    expect(dashboard.previousHandoff).toMatchObject({ chapter: 1, sceneId: "scene-002", hasApprovedArtwork: false, usedAsReference: false, origin: "automatic" });
    const scene = dashboard.manifest!.scenes[0]!;
    expect(scene.continuity!.startState.characters[0]).toMatchObject({ injuries: "bleeding left arm" });
    expect(scene.continuity!.endState.environment).toMatchObject({ timeOfDay: "afternoon" });
    expect(scene.continuity!.referenceDecision).toMatchObject({ kind: "previous-chapter", used: false });
    expect(dashboard.manifest!.scenes[1]!.continuity!.startState).toEqual(scene.continuity!.endState);
  });

  it("upserts and deletes overlay entries through the operations endpoint and invalidates scene planning", async () => {
    const { root, story } = await storyRoot([1]);
    const planned = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) });
    const operations = new StudioOperations(root, env, new JobManager(), { llm: new LLMRouter(new Map()) });
    const overlay = await operations.updateSceneContinuity(story.slug, 1, "scene-002", { note: "Mara healed", setState: { characters: [{ name: "Mara", condition: "recovered" }] }, sceneContentFingerprint: sceneContentFingerprint(planned.manifest.scenes[1]!) });
    expect(overlay.entries).toHaveLength(1);
    expect(overlay.entries[0]).toMatchObject({ sceneId: "scene-002", revision: 1 });
    const chapter = chapterSchema.parse(await readJsonIfExists(storyPaths(root, story.slug, 1).chapterMeta));
    expect(chapter.stages.scenePlanning.status).toBe("complete");
    expect(chapter.stages.scenePlanning.staleReason).toMatch(/continuity/i);
    // Overlay change also made the planning fingerprint move: no silent reuse
    expect((await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(nightPlan) })).reused).toBe(false);
    const afterDelete = await operations.deleteSceneContinuity(story.slug, 1, "scene-002");
    expect(afterDelete.entries).toHaveLength(0);
    const { resolved } = await resolveChapterVisualContinuity({ root, slug: story.slug, chapter: 1, manifest: sceneManifestSchema.parse(await readJsonIfExists(storyPaths(root, story.slug, 1).scenesManifest)) });
    expect(resolved.chapterEndState.characters[0]).toMatchObject({ injuries: "bleeding left arm" });
  });
});
