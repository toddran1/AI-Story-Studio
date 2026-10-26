import { generateStoredArtwork, backingArtworkVersion } from "../src/artwork/generator.js";
import { fingerprint } from "../src/utils/hash.js";
import { VISUAL_CHECK_CATEGORIES } from "../src/artwork/visual-check.js";
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
import { storyPaths, sceneImagePath, sceneVersionImagePath } from "../src/storage/paths.js";
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
  it("builds a source-backed storyboard without calling image or QA providers", async () => {
    const f = await fixture(); try {
      f.profile.creatureForms![0]!.status = "approved"; await saveVisualProfiles(f.root, f.story.slug, { [id]: f.profile });
      f.manifest.scenes[0]!.narrationText = "The goblins rose under moonlight.";
      f.manifest.scenes[0]!.visualChanges = { environment: { set: { timeOfDay: "night" } } };
      await atomicWriteJson(f.paths.scenesManifest, f.manifest);
      const images = new Images(); const operations = new StudioOperations(f.root, loadEnvironment({}), undefined, { image: images });
      const board = await operations.imageStoryboard(f.story.slug, { chapters: [1] });
      expect(board.rows).toHaveLength(1);
      expect(board.rows[0]).toMatchObject({ status: "unchecked", protected: true, needsAttention: true });
      expect(board.rows[0]!.facts).toEqual(expect.arrayContaining([expect.objectContaining({ field: "timeOfDay", value: "night", passage: "The goblins rose under moonlight." })]));
      expect(board.rows[0]!.check?.sourceFingerprint).toBeTruthy();
      expect(images.requests).toHaveLength(0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("repairs an exact source frame into a new version while retaining the approved production image", async () => {
    const f = await fixture(); try {
      f.profile.creatureForms![0]!.status = "approved"; await saveVisualProfiles(f.root, f.story.slug, { [id]: f.profile });
      const images = new Images(); const operations = new StudioOperations(f.root, loadEnvironment({}), undefined, { image: images });
      const target = { chapter: 1, sceneId: f.scene.id };
      const context = await operations.getArtworkVisualCheck(f.story.slug, target);
      const input = { target, repair: { sourceVersionId: "v1", instruction: "Remove the sword; preserve the goblin faces and scene composition." }, sourceFingerprint: context.sourceFingerprint };
      const rejected = await operations.startImageRepair(f.story.slug, { ...input, sourceFingerprint: "changed" });
      expect((await finish(operations, rejected.id)).status).toBe("failed"); expect(images.requests).toHaveLength(0);
      const job = await operations.startImageRepair(f.story.slug, input);
      expect((await finish(operations, job.id)).status).toBe("completed");
      expect(images.requests[0]?.referenceImages?.[0]?.data).toEqual(PNG);
      expect(images.requests[0]?.prompt).toContain("TARGETED REPAIR");
      expect(images.requests[0]?.prompt).toContain("Remove the sword");
      const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(f.paths.scenesManifest, "utf8")));
      expect(manifest.scenes[0]?.artwork.approvedVersionId).toBe("v1");
      expect(manifest.scenes[0]?.artwork.versions).toHaveLength(2);
      expect(manifest.scenes[0]?.artwork.versions[1]?.provenance?.repair).toMatchObject(input.repair);
      expect(await readFile(sceneVersionImagePath(f.root, f.story.slug, 1, f.scene.id, 1))).toEqual(PNG);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("automatically checks protected artwork, reuses the check, and never regenerates the approved frame", async () => {
    const f = await fixture(); try {
      f.profile.creatureForms![0]!.status = "approved"; await saveVisualProfiles(f.root, f.story.slug, { [id]: f.profile });
      let checks = 0;
      const llm: LLMProvider = { name: "openai", supportsImageInputs: true, async validateConfiguration() {}, async generateText() { throw new Error("Not used"); }, async generateStructured(request) { checks++; return { value: request.schema.parse({ summary: "Matches the current frame", ...Object.fromEntries(VISUAL_CHECK_CATEGORIES.map(category => [category, { status: "match", observation: "Matches supported visible facts" }])) }) }; } };
      const images = new Images(); const operations = new StudioOperations(f.root, loadEnvironment({}), undefined, { image: images, llm: new LLMRouter(new Map([["openai", llm]])) });
      const input = { scope: { chapters: [1] }, budgetUsd: 1, maxRequests: 2, checkAllowanceUsd: .25 };
      const plan = await operations.planImageAutomation(f.story.slug, input);
      const job = await operations.startImageAutomation(f.story.slug, { ...input, planFingerprint: plan.fingerprint });
      const done = await finish(operations, job.id);
      expect(done.status, JSON.stringify(done.error)).toBe("completed");
      expect(done.result).toMatchObject({ status: "completed", reservedUsd: .25, requests: 1, outcomes: [{ status: "ready" }] });
      const next = await operations.planImageAutomation(f.story.slug, input);
      const repeated = await operations.startImageAutomation(f.story.slug, { ...input, planFingerprint: next.fingerprint });
      expect((await finish(operations, repeated.id)).result).toMatchObject({ requests: 0 });
      expect(images.requests).toHaveLength(0); expect(checks).toBe(1);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
  it("stops before a paid check when the reserved-cost limit is exhausted", async () => {
    const f = await fixture(); try {
      f.profile.creatureForms![0]!.status = "approved"; await saveVisualProfiles(f.root, f.story.slug, { [id]: f.profile });
      let checks = 0;
      const llm: LLMProvider = { name: "openai", supportsImageInputs: true, async validateConfiguration() {}, async generateText() { throw new Error("Not used"); }, async generateStructured() { checks++; throw new Error("Must not run"); } };
      const operations = new StudioOperations(f.root, loadEnvironment({}), undefined, { llm: new LLMRouter(new Map([["openai", llm]])) });
      const input = { scope: { chapters: [1] }, budgetUsd: .1, checkAllowanceUsd: .25 };
      const plan = await operations.planImageAutomation(f.story.slug, input);
      const job = await operations.startImageAutomation(f.story.slug, { ...input, planFingerprint: plan.fingerprint });
      expect((await finish(operations, job.id)).result).toMatchObject({ status: "budget_reached", requests: 0, reservedUsd: 0 });
      expect(checks).toBe(0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("generates and checks a draft, performs only the bounded repair, and leaves the unresolved mismatch for review", async () => {
    const f = await fixture(); try {
      f.profile.creatureForms![0]!.status = "approved"; await saveVisualProfiles(f.root, f.story.slug, { [id]: f.profile });
      delete f.manifest.scenes[0]!.artwork.approvedVersionId; f.manifest.scenes[0]!.artwork.review = "needs-regeneration"; f.manifest.scenes[0]!.artwork.versions[0]!.review = "unreviewed";
      await atomicWriteJson(f.paths.scenesManifest,f.manifest);
      let checks=0;
      const llm: LLMProvider = { name:"openai",supportsImageInputs:true,async validateConfiguration(){},async generateText(){throw new Error("Not used");},async generateStructured(request){checks++;return {value:request.schema.parse({summary:"Sword should be absent",...Object.fromEntries(VISUAL_CHECK_CATEGORIES.map(category=>[category,{status:category==="equipment"?"mismatch":"match",observation:category==="equipment"?"An extra sword is visible":"Matches"}]))})};} };
      const images = new Images(); const operations = new StudioOperations(f.root,loadEnvironment({}),undefined,{image:images,llm:new LLMRouter(new Map([["openai",llm]]))});
      const input={scope:{chapters:[1]},budgetUsd:5,maxRepairs:1}; const plan=await operations.planImageAutomation(f.story.slug,input);
      const job=await operations.startImageAutomation(f.story.slug,{...input,planFingerprint:plan.fingerprint}); const done=await finish(operations,job.id);
      expect(done.result,JSON.stringify(done.result)).toMatchObject({status:"completed_with_exceptions",requests:4,outcomes:[{status:"mismatch",repairs:1}]});
      expect(images.requests).toHaveLength(2); expect(checks).toBe(2);
      expect(images.requests[1]?.prompt).toContain("TARGETED REPAIR");
      const manifest=sceneManifestSchema.parse(JSON.parse(await readFile(f.paths.scenesManifest,"utf8")));
      expect(manifest.scenes[0]?.artwork.approvedVersionId).toBeUndefined(); expect(manifest.scenes[0]?.artwork.versions).toHaveLength(3);
    }finally{await rm(f.root,{recursive:true,force:true});}
  });

  it("repairs a corrupt review cache instead of permanently blocking a fresh check", async () => {
    const f=await fixture();try{
      f.profile.creatureForms![0]!.status="approved";await saveVisualProfiles(f.root,f.story.slug,{[id]:f.profile});
      let calls=0;const llm:LLMProvider={name:"openai",supportsImageInputs:true,async validateConfiguration(){},async generateText(){throw new Error("Not used");},async generateStructured(request){calls++;return {value:request.schema.parse({summary:"Matches",...Object.fromEntries(VISUAL_CHECK_CATEGORIES.map(c=>[c,{status:"match",observation:"Matches"}]))})};}};
      const operations=new StudioOperations(f.root,loadEnvironment({}),undefined,{llm:new LLMRouter(new Map([["openai",llm]]))});
      await atomicWrite(`${sceneVersionImagePath(f.root,f.story.slug,1,f.scene.id,1)}.visual-check.json`,"{ invalid");
      const target={chapter:1,sceneId:f.scene.id};expect((await operations.getArtworkVisualCheck(f.story.slug,target)).check).toBeNull();
      const job=await operations.startArtworkVisualCheck(f.story.slug,{target});expect((await finish(operations,job.id)).status).toBe("completed");expect(calls).toBe(1);
    }finally{await rm(f.root,{recursive:true,force:true});}
  });
  it("honors a pause after generation before issuing the next QA request", async () => {
    const f=await fixture();try{
      f.profile.creatureForms![0]!.status="approved";await saveVisualProfiles(f.root,f.story.slug,{[id]:f.profile});
      delete f.manifest.scenes[0]!.artwork.approvedVersionId;f.manifest.scenes[0]!.artwork.review="needs-regeneration";await atomicWriteJson(f.paths.scenesManifest,f.manifest);
      let checks=0;let jobId="";const llm:LLMProvider={name:"openai",supportsImageInputs:true,async validateConfiguration(){},async generateText(){throw new Error("Not used");},async generateStructured(){checks++;throw new Error("QA must not run after pause");}};
      const images=new Images();const operations=new StudioOperations(f.root,loadEnvironment({}),undefined,{image:images,llm:new LLMRouter(new Map([["openai",llm]]))});
      const generate=images.generate.bind(images);images.generate=async request=>{const result=await generate(request);operations.jobs.pause(jobId);return result;};
      const input={scope:{chapters:[1]}};const plan=await operations.planImageAutomation(f.story.slug,input);const job=await operations.startImageAutomation(f.story.slug,{...input,planFingerprint:plan.fingerprint});jobId=job.id;
      const done=await finish(operations,job.id);expect(done.result).toMatchObject({status:"paused",requests:1});expect(checks).toBe(0);expect(images.requests).toHaveLength(1);
    }finally{await rm(f.root,{recursive:true,force:true});}
  });
  it("paginates the storyboard without resolving or reading every frame", async () => {
    const f=await fixture();try{
      f.profile.creatureForms![0]!.status="approved";await saveVisualProfiles(f.root,f.story.slug,{[id]:f.profile});
      f.manifest.scenes=[1,2,3].map(n=>{const scene=structuredClone(f.scene);scene.id=`scene-${String(n).padStart(3,"0")}`;scene.artwork.versions.forEach(v=>{v.sceneId=scene.id;});return scene;});await atomicWriteJson(f.paths.scenesManifest,f.manifest);
      const operations=new StudioOperations(f.root,loadEnvironment({}));const preview=vi.spyOn(operations,"previewSceneVisuals");
      const board=await operations.imageStoryboard(f.story.slug,{chapters:[1],offset:1,limit:1});
      expect(board).toMatchObject({totalRows:3,offset:1,hasMore:true});expect(board.rows.map(r=>r.scene.id)).toEqual(["scene-002"]);expect(preview).toHaveBeenCalledTimes(1);
    }finally{await rm(f.root,{recursive:true,force:true});}
  });

  it("retains manually accepted production art without an approved-version ID when creating a repair", async () => {
    const f=await fixture();try{
      f.profile.creatureForms![0]!.status="approved";await saveVisualProfiles(f.root,f.story.slug,{[id]:f.profile});
      const art=f.manifest.scenes[0]!.artwork;delete art.approvedVersionId;art.review="unreviewed";art.manuallyEdited=true;art.imageFingerprint=fingerprint(PNG.toString("base64"));art.versions[0]!.imageFingerprint=art.imageFingerprint;
      await atomicWriteJson(f.paths.scenesManifest,f.manifest);await atomicWrite(sceneImagePath(f.root,f.story.slug,1,f.scene.id),PNG);
      const images=new Images();const operations=new StudioOperations(f.root,loadEnvironment({}),undefined,{image:images});const target={chapter:1,sceneId:f.scene.id};const check=await operations.getArtworkVisualCheck(f.story.slug,target);
      const job=await operations.startImageRepair(f.story.slug,{target,repair:{sourceVersionId:"v1",instruction:"Remove the sword"},sourceFingerprint:check.sourceFingerprint});
      expect((await finish(operations,job.id)).status).toBe("completed");
      const saved=sceneManifestSchema.parse(JSON.parse(await readFile(f.paths.scenesManifest,"utf8"))).scenes[0]!;
      expect(saved.artwork.versions).toHaveLength(2);expect(saved.artwork.manuallyEdited).toBe(true);expect(backingArtworkVersion(saved)?.id).toBe("v1");
      expect(await readFile(sceneImagePath(f.root,f.story.slug,1,f.scene.id))).toEqual(PNG);
    }finally{await rm(f.root,{recursive:true,force:true});}
  });
  it("backs up a legacy original before generating its first replacement", async () => {
    const f=await fixture();try{
      f.profile.creatureForms![0]!.status="approved";await saveVisualProfiles(f.root,f.story.slug,{[id]:f.profile});
      const art=f.manifest.scenes[0]!.artwork;art.versions=[];delete art.approvedVersionId;art.review="unreviewed";art.imageFingerprint=fingerprint(PNG.toString("base64"));
      await atomicWriteJson(f.paths.scenesManifest,f.manifest);await atomicWrite(sceneImagePath(f.root,f.story.slug,1,f.scene.id),PNG);
      const images=new Images();await generateStoredArtwork({root:f.root,story:f.story,chapter:1,provider:images,force:true});
      expect(await readFile(sceneVersionImagePath(f.root,f.story.slug,1,f.scene.id,1))).toEqual(PNG);
      expect(await readFile(sceneImagePath(f.root,f.story.slug,1,f.scene.id))).toEqual(PNG2);
    }finally{await rm(f.root,{recursive:true,force:true});}
  });

});
