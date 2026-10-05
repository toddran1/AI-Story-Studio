import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { defaultStory } from "../src/config/load-config.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { sceneManifestSchema } from "../src/scenes/types.js";
import { acquireStoryLock } from "../src/storage/story-lock.js";
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalEntitySchema, emptyStoryBible } from "../src/domain/story-bible.js";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { sceneSchema } from "../src/scenes/types.js";
import { visualWorkflowCatalog, visualSceneImpact } from "../src/visual-canon/workflow.js";
import { prepareCreatureForms } from "../src/visual-canon/creature-forms.js";
import { loadVisualProfiles, saveVisualProfiles, approveVisualReference } from "../src/visual-canon/profiles.js";
const id = "ent_0123456789abcdef01234567";
const now = new Date().toISOString();
const entity = canonicalEntitySchema.parse({ id, type: "concept", sourceBucket: "creatures", canonicalName: "Goblin", firstAppearance: 1, lastKnownAppearance: 20 });
const bible = { ...emptyStoryBible(), canonicalEntities: [entity] };
const scene = () => sceneSchema.parse({ id: "scene-001", summary: "Goblins", startSeconds: 0, endSeconds: 10, visualPrompt: "Goblins", creatureGroups: [{ id: "g", entity: "Goblin", label: "Zombies", state: "zombie", count: 2, appearance: "Rotting goblins", excerpt: "Two dead goblins rose" }] });
const profile = () => visualProfileSchema.parse({ id: "goblin", entityId: id, visualType: "creature", status: "approved", appearance: "Green goblin", createdAt: now, updatedAt: now, references: [{ id: "base", entityId: id, imagePath: "base.png", approved: true, createdAt: now }, { id: "candidate", entityId: id, imagePath: "candidate.png", approved: false, createdAt: now }], creatureForms: [{ id: "zombie", name: "Zombie", state: "zombie", appearance: "Gray flesh", status: "draft", referenceIds: ["candidate"] }] });

describe("visual workflow review and impact", () => {
  it("reports draft forms, missing profiles and stale eras without leaking form references into base choices", () => {
    const p = profile(); p.references[1]!.approved = true;
    const catalog = visualWorkflowCatalog(bible, { [id]: p });
    expect(catalog[0]?.baseReferenceIds).toEqual(["base"]);
    expect(catalog[0]?.tasks).toMatchObject([{ kind: "form", needsSheet: false }]);
    expect(visualWorkflowCatalog(bible, {})[0]?.tasks).toMatchObject([{ kind: "profile", needsSheet: true }]);
    p.creatureForms![0]!.status = "approved";
    p.creatureForms![0]!.detectedSource = { scope: "chapter:2", fingerprint: "old", needsReview: true };
    expect(visualWorkflowCatalog(bible, { [id]: p })[0]?.tasks[0]?.stale).toBe(true);
    expect(visualWorkflowCatalog({ ...bible, canonicalEntities: [{ ...entity, visualProfilePolicy: { mode: "skip" } }] }, {})).toEqual([]);
  });
  it("reports a missing base sheet even when a scoped sheet is approved", () => {
    const p = profile(); p.references[0]!.approved = false; p.references[1]!.approved = true;
    const catalog = visualWorkflowCatalog(bible, { [id]: p });
    expect(catalog[0]?.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "reference", needsSheet: true })]));
  });
  it("includes group-only usage and protects approved and manually edited artwork", () => {
    const s = scene(); s.artwork.review = "approved";
    expect(visualSceneImpact(s, bible, id)).toMatchObject({ sceneId: "scene-001", protected: true });
    s.artwork.review = "unreviewed"; s.artwork.manuallyEdited = true;
    expect(visualSceneImpact(s, bible, id)?.protected).toBe(true);
    s.creatureGroups = [];
    expect(visualSceneImpact(s, bible, id)).toBeUndefined();
  });
  it("flags changed or removed form evidence only in its original source scope and preserves edited designs", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-workflow-"));
    try {
      await prepareCreatureForms(root, "test", bible, [scene()], 2);
      const first = await loadVisualProfiles(root, "test");
      first[id]!.creatureForms![0]!.appearance = "My edited zombie";
      await saveVisualProfiles(root, "test", first);
      await prepareCreatureForms(root, "test", bible, [], 3);
      expect((await loadVisualProfiles(root, "test"))[id]?.creatureForms?.[0]?.detectedSource?.needsReview).toBe(false);
      await prepareCreatureForms(root, "test", bible, [], 2);
      const updated = (await loadVisualProfiles(root, "test"))[id]!;
      expect(updated.creatureForms?.[0]).toMatchObject({ appearance: "My edited zombie", detectedSource: { needsReview: true } });
      const revision = updated.revision;
      await prepareCreatureForms(root, "test", bible, [], 2);
      expect((await loadVisualProfiles(root, "test"))[id]?.revision).toBe(revision);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("approves an era and its sheet atomically and rejects stale source decisions without a partial approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-era-review-"));
    try {
      const p = profile(); p.creatureForms = [];
      p.appearanceEras = [{ id: "first", name: "Living", startChapter: 1, status: "approved", appearance: "Living", visualPrompt: "", referenceIds: ["base"] }, { id: "second", name: "Zombie", startChapter: 10, status: "draft", appearance: "Zombie", visualPrompt: "", referenceIds: ["candidate"], detectedChange: { evidenceIds: ["source"], confidence: .9, excerpts: ["rose"], needsReview: true } }];
      await saveVisualProfiles(root, "test", { [id]: p });
      await expect(approveVisualReference(root, "test", id, "candidate", true, undefined, "second")).rejects.toThrow("changed source");
      expect((await loadVisualProfiles(root, "test"))[id]?.references[1]?.approved).toBe(false);
      p.appearanceEras[1]!.detectedChange!.needsReview = false;
      await saveVisualProfiles(root, "test", { [id]: p });
      const approved = await approveVisualReference(root, "test", id, "candidate", true, undefined, "second");
      expect(approved.appearanceEras?.[0]?.endChapter).toBe(9);
      expect(approved.appearanceEras?.[1]?.status).toBe("approved");
      expect(approved.references[1]?.approved).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("keeps catalog reads available during a story job and resolves previews through the artwork resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-workflow-api-"));
    try {
      const story = defaultStory("test", loadEnvironment({})); const paths = storyPaths(root, "test", 2);
      await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.bible, bible);
      const p = profile(); p.creatureForms![0]!.status = "approved";
      await saveVisualProfiles(root, "test", { [id]: p });
      const manifest = sceneManifestSchema.parse({ version: 1, chapter: 2, durationSeconds: 10, planningFingerprint: "fixture", planner: { provider: "openai", model: "fake", promptVersion: "fake" }, createdAt: now, updatedAt: now, scenes: [scene()] });
      await atomicWriteJson(paths.scenesManifest, manifest);
      const operations = new StudioOperations(root, loadEnvironment({}));
      const release = await acquireStoryLock(root, "test", "test running job");
      try { expect(await operations.visualWorkflow("test")).toHaveLength(1); } finally { await release(); }
      const preview = await operations.previewSceneVisuals("test", { scene: scene(), chapter: 2 });
      expect(preview.prompt).toContain("Gray flesh"); expect(preview.resolvedEntities).toHaveLength(1);
      expect(preview.references.loadedReferenceIds).toEqual([]);
      expect(await operations.visualImpact("test", id)).toMatchObject([{ chapter: 2, sceneId: "scene-001", protected: false }]);
      await expect(operations.previewSceneVisuals("test", { scene: scene(), chapter: 0 })).rejects.toThrow();
      await expect(operations.visualImpact("../test", id)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});
