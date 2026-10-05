import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioOperations } from "../apps/server/operations.js";
import { JobManager } from "../apps/server/job-manager.js";
import { loadEnvironment } from "../src/config/env.js";
import { LLMRouter } from "../src/llm/router.js";
import type { LLMProvider } from "../src/llm/provider.js";
import type { ImageProvider, ImageGenerationRequest } from "../src/artwork/provider.js";
import { canonicalEntitySchema, emptyStoryBible } from "../src/domain/story-bible.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { sceneManifestSchema, sceneSchema } from "../src/scenes/types.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths, sceneVersionImagePath } from "../src/storage/paths.js";
import { addVisualReferenceImage, loadVisualProfiles, saveVisualProfiles, generateStyleSheet } from "../src/visual-canon/profiles.js";
import { planReferenceBatch, runReferenceBatch } from "../src/visual-canon/reference-batch.js";
import { visualCheckResponseSchema } from "../src/artwork/visual-check.js";
import { testStory } from "./helpers.js";
const id = "ent_0123456789abcdef01234567";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PNG2 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEfQHzx5tC9AAAAABJRU5ErkJggg==", "base64");
class Images implements ImageProvider {
  name = "openai"; version = "fake-v1"; requests: ImageGenerationRequest[] = []; failAt?: number;
  async validateConfiguration() {}
  async generate(request: ImageGenerationRequest) { this.requests.push(request); if (this.failAt === this.requests.length) throw new Error("Fake provider failed"); return { data: PNG2, mimeType: "image/png" as const }; }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "visual-generation-")); const story = testStory(); story.artwork.model = "gpt-image-2.5-flare"; story.artwork.outputResolution = "native";
  const paths = storyPaths(root, story.slug, 1); const now = new Date().toISOString();
  const entity = canonicalEntitySchema.parse({ id, type: "concept", sourceBucket: "creatures", canonicalName: "Goblin", firstAppearance: 1, lastKnownAppearance: 1 });
  await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.bible, { ...emptyStoryBible(), canonicalEntities: [entity] });
  const profile = visualProfileSchema.parse({ id: "goblin", entityId: id, visualType: "creature", creatureIdentity: "template", status: "approved", appearance: "Living green goblin", creature: { anatomy: "Green living flesh" }, createdAt: now, updatedAt: now, creatureForms: [{ id: "zombie", name: "Zombie", state: "zombie", status: "draft", appearance: "Gray rotting goblin", referenceIds: [] }, { id: "skeleton", name: "Skeleton", state: "skeleton", status: "draft", appearance: "Bare skeleton goblin without flesh", referenceIds: [] }] });
  await saveVisualProfiles(root, story.slug, { [id]: profile });
  const base = await addVisualReferenceImage(root, story.slug, id, { data: PNG, role: "primary_reference", source: "uploaded", approved: true });
  const scene = sceneSchema.parse({ id: "scene-001", startSeconds: 0, endSeconds: 10, summary: "Goblins rose", visualPrompt: "Two zombie goblins", creatureGroups: [{ id: "g", entity: id, label: "Zombie goblins", state: "zombie", count: 2, formId: "zombie", appearance: "Gray rotten flesh" }], artwork: { status: "complete", review: "approved", approvedVersionId: "v1", versions: [{ id: "v1", versionNumber: 1, sceneId: "scene-001", imagePath: "scene-001-v1.png", imageFingerprint: "old", prompt: "Old", promptFingerprint: "old", createdAt: now, provider: "openai", model: story.artwork.model, review: "approved" }] } });
  const manifest = sceneManifestSchema.parse({ chapter: 1, version: 1, durationSeconds: 10, planningFingerprint: "fixture", planner: { provider: "openai", model: "fake", promptVersion: "fake" }, createdAt: now, updatedAt: now, scenes: [scene] });
  await atomicWriteJson(paths.scenesManifest, manifest); await atomicWrite(sceneVersionImagePath(root, story.slug, 1, scene.id, 1), PNG);
  await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ storyId: story.id, chapter: 1, title: "Goblins", sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 0, englishWords: 0, narrationWords: 0 }, createdAt: now, updatedAt: now, stages: Object.fromEntries(["ingestion", "translation", "narration", "storyBible", "tts"].map(stage => [stage, { status: "pending" }])) }));
  return { root, story, paths, profile: (await loadVisualProfiles(root, story.slug))[id]!, base: base.reference, scene, manifest };
}
async function finish(operations: StudioOperations, jobId: string) {
  await vi.waitFor(() => expect(["completed", "failed", "paused"]).toContain(operations.jobs.get(jobId)?.status)); await operations.jobs.flushDurable(); return operations.jobs.get(jobId)!;
}

describe("visual workflow generation", () => {
  it("conditions a skeleton sheet on an approved identity image without inheriting living anatomy", async () => {
    const f = await fixture(); try {
      const images = new Images(); const generated = await generateStyleSheet(f.root, f.story.slug, id, images, f.story, { creatureFormId: "skeleton" });
      expect(images.requests[0]?.referenceImages?.map(image => image.referenceId)).toEqual([f.base.id]);
      expect(images.requests[0]?.prompt).toContain("Bare skeleton goblin without flesh"); expect(images.requests[0]?.prompt).not.toContain("Green living flesh");
      expect(generated.reference).toMatchObject({ approved: false, provenance: { identityMode: "image-conditioned", identityReferenceIds: [f.base.id] } });
      f.story.artwork.model = "gpt-image-1";
      const fallback = await generateStyleSheet(f.root, f.story.slug, id, images, f.story, { creatureFormId: "skeleton" });
      expect(images.requests[1]?.referenceImages).toBeUndefined(); expect(fallback.reference.provenance?.identityMode).toBe("text-only");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("retries failed entries while reusing saved candidates and detecting damaged image files", async () => {
    const f = await fixture(); try {
      const images = new Images(); images.failAt = 2;
      const input = { selection: [{ entityId: id, kind: "form", scopeId: "zombie" }, { entityId: id, kind: "form", scopeId: "skeleton" }] };
      const plan = await planReferenceBatch(f.root, f.story, images, input); expect(plan.imageCount).toBe(2); expect(plan.estimatedCostUsd).toBeGreaterThan(0);
      const result = await runReferenceBatch(f.root, f.story, images, plan, () => undefined);
      expect(result.status).toBe("completed_with_errors"); expect(result.outcomes.map(item => item.status)).toEqual(["generated", "failed"]);
      const retry = await planReferenceBatch(f.root, f.story, images, input); expect(retry.imageCount).toBe(1); expect(retry.entries[0]?.reuseReferenceId).toBe(result.outcomes[0]?.referenceId);
      images.failAt = undefined; await runReferenceBatch(f.root, f.story, images, retry, () => undefined); expect(images.requests).toHaveLength(3);
      const saved = (await loadVisualProfiles(f.root, f.story.slug))[id]!;
      const candidate = saved.references.find(ref => ref.id === result.outcomes[0]?.referenceId)!;
      await atomicWrite(candidate.imagePath, PNG);
      expect((await planReferenceBatch(f.root, f.story, images, input)).imageCount).toBe(1);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("stops before the next image and rejects a changed plan before any provider call", async () => {
    const f = await fixture(); try {
      const images = new Images(); const operations = new StudioOperations(f.root, loadEnvironment({}), undefined, { image: images });
      const input = { selection: [{ entityId: id, kind: "form" as const, scopeId: "zombie" }] };
      const plan = await operations.planVisualReferences(f.story.slug, input);
      const paused = await runReferenceBatch(f.root, f.story, images, plan, () => undefined, () => true); expect(paused.status).toBe("paused");
      f.profile.creatureForms![0]!.appearance = "Changed zombie"; await saveVisualProfiles(f.root, f.story.slug, { [id]: f.profile });
      const job = await operations.startVisualReferences(f.story.slug, { ...input, planFingerprint: plan.fingerprint });
      expect((await finish(operations, job.id)).status).toBe("failed"); expect(images.requests).toHaveLength(0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("requires explicit inclusion of protected scenes and preserves their approved version when generating a candidate", async () => {
    const f = await fixture(); try {
      f.profile.creatureForms![0]!.status = "approved"; await saveVisualProfiles(f.root, f.story.slug, { [id]: f.profile });
      const images = new Images(); const operations = new StudioOperations(f.root, loadEnvironment({}), undefined, { image: images });
      const input = { entityId: id, selection: [{ chapter: 1, sceneId: f.scene.id }] };
      const blocked = await operations.planVisualRegeneration(f.story.slug, input); expect(blocked.imageCount).toBe(0); expect(blocked.entries[0]?.blockedReason).toContain("protected");
      const plan = await operations.planVisualRegeneration(f.story.slug, { ...input, includeProtected: true });
      const job = await operations.startVisualRegeneration(f.story.slug, { ...input, includeProtected: true, planFingerprint: plan.fingerprint });
      expect((await finish(operations, job.id)).status).toBe("completed");
      const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(f.paths.scenesManifest, "utf8")));
      expect(manifest.scenes[0]?.artwork.approvedVersionId).toBe("v1"); expect(manifest.scenes[0]?.artwork.versions).toHaveLength(2); expect(manifest.scenes[0]?.artwork.versions[1]?.review).toBe("unreviewed");
      expect(await readFile(sceneVersionImagePath(f.root, f.story.slug, 1, f.scene.id, 1))).toEqual(PNG);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("retains an approved chapter image when a replacement provider fails", async () => {
    const f = await fixture(); try {
      f.profile.creatureForms![0]!.status = "approved"; await saveVisualProfiles(f.root, f.story.slug, { [id]: f.profile });
      const images = new Images(); images.failAt = 1;
      const operations = new StudioOperations(f.root, loadEnvironment({}), undefined, { image: images });
      const input = { entityId: id, selection: [{ chapter: 1, sceneId: f.scene.id }], includeProtected: true };
      const plan = await operations.planVisualRegeneration(f.story.slug, input);
      const job = await operations.startVisualRegeneration(f.story.slug, { ...input, planFingerprint: plan.fingerprint });
      expect((await finish(operations, job.id)).status).toBe("failed");
      const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(f.paths.scenesManifest, "utf8")));
      expect(manifest.scenes[0]!.artwork).toMatchObject({ status: "complete", review: "approved", approvedVersionId: "v1" });
      expect(await readFile(sceneVersionImagePath(f.root, f.story.slug, 1, f.scene.id, 1))).toEqual(PNG);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("runs an advisory image check, reuses it, flags changed artwork and never changes approval", async () => {
    const f = await fixture(); try {
      f.profile.creatureForms![0]!.status = "approved"; await saveVisualProfiles(f.root, f.story.slug, { [id]: f.profile });
      const response = visualCheckResponseSchema.parse({ summary: "Count needs review", identity: { status: "match", observation: "Goblin shapes" }, creatureForm: { status: "match", observation: "Rotting flesh" }, count: { status: "mismatch", observation: "Only one goblin is visible" }, signatureFeatures: { status: "uncertain", observation: "Too small to see" }, composition: { status: "match", observation: "Clear scene" } });
      const requests: any[] = [];
      const llm: LLMProvider = { name: "openai", supportsImageInputs: true, async validateConfiguration() {}, async generateText() { throw new Error("Not used"); }, async generateStructured(request) { requests.push(request); return { value: request.schema.parse(response) }; } };
      const operations = new StudioOperations(f.root, loadEnvironment({}), undefined, { llm: new LLMRouter(new Map([["openai", llm]])) });
      const input = { target: { chapter: 1, sceneId: f.scene.id, versionId: "v1" } };
      const first = await operations.startArtworkVisualCheck(f.story.slug, input); const done = await finish(operations, first.id);
      expect(done.status, JSON.stringify(done.error)).toBe("completed"); expect((done.result as any).check.count.status).toBe("mismatch"); expect(requests[0].images[0].data).toEqual(PNG);
      const reused = await operations.startArtworkVisualCheck(f.story.slug, input); await finish(operations, reused.id); expect(requests).toHaveLength(1);
      expect((await operations.getArtworkVisualCheck(f.story.slug, input.target)).stale).toBe(false);
      await atomicWrite(sceneVersionImagePath(f.root, f.story.slug, 1, f.scene.id, 1), PNG2);
      expect((await operations.getArtworkVisualCheck(f.story.slug, input.target)).stale).toBe(true);
      const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(f.paths.scenesManifest, "utf8"))); expect(manifest.scenes[0]?.artwork.approvedVersionId).toBe("v1"); expect(manifest.scenes[0]?.artwork.review).toBe("approved");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("retains a stop request made before a visual job registers its pause handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-early-stop-")); let release!: () => void;
    try {
      const jobs = new JobManager(); let stopped = false;
      const job = await jobs.createDurable(join(root, "jobs"), "test", async control => {
        await new Promise<void>(resolve => { release = resolve; });
        control.setPause(() => { stopped = true; });
        return { status: stopped ? "paused" : "completed" };
      }, {}, "visualWorkflow");
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(jobs.pause(job.id)).toBe(true); release();
      await vi.waitFor(() => expect(jobs.get(job.id)?.status).toBe("paused"));
      await jobs.flushDurable();
    } finally { release?.(); await rm(root, { recursive: true, force: true }); }
  });
  it("restores interrupted visual jobs as paused without replaying paid work", async () => {
    const root = await mkdtemp(join(tmpdir(), "visual-job-restore-")); let release!: () => void;
    try {
      const jobs = new JobManager(); const directory = join(root, "jobs");
      const job = await jobs.createDurable(directory, "test", async control => { control.update({ index: 2, total: 3, outcomes: [{ key: "done", status: "generated" }] }); await new Promise<void>(resolve => { release = resolve; }); return { status: "completed" }; }, { operation: "references" }, "visualWorkflow");
      await vi.waitFor(() => expect(jobs.get(job.id)?.status).toBe("running")); await jobs.flushDurable();
      const restored = new JobManager(); await restored.restoreDurable(directory);
      expect(restored.get(job.id)).toMatchObject({ type: "visualWorkflow", status: "paused", progress: { outcomes: [{ status: "generated" }] } });
      release(); await vi.waitFor(() => expect(jobs.get(job.id)?.status).toBe("completed")); await jobs.flushDurable();
    } finally { release?.(); await rm(root, { recursive: true, force: true }); }
  });
});
