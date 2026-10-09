import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { storySchema, type Story } from "../domain/story.js";
import { chapterSchema, stageNameSchema } from "../domain/chapter.js";
import { qaStateSchema } from "../domain/qa.js";
import { sourceManifestSchema } from "../source/types.js";
import { importedChapterFingerprint } from "../source/importer.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { storyPaths } from "../storage/paths.js";
import { withStoryLock } from "../storage/story-lock.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import { inspectStageArtifact } from "../studio/artifact-state.js";
import { directStagePrerequisites, orderedBatchStages } from "../studio/stage-execution.js";
import { manualAcceptanceFingerprint } from "../studio/stage-acceptance.js";
import { sceneManifestSchema } from "../scenes/types.js";
import { writeArtworkOutputManifest } from "../artwork/output-index-revision.js";
import { inventory, inventoryFingerprint, copySnapshot, commitSnapshot, recoverTransactions, safeRelative } from "./snapshot.js";
import { executeAgentStage, type AgentStage, type AgentRequest } from "./runtime.js";

export const agentStageSchema = z.enum(["translation", "narration", "qa", "storyBible", "continuity", "scenePlanning", "artwork"]);
const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const idSchema = z.string().uuid();
export const agentPlanInputSchema = z.object({
  story: slugSchema, chapters: z.array(z.number().int().positive()).min(1).max(2000),
  stages: z.array(agentStageSchema).min(1), agent: z.enum(["codex", "antigravity"]),
  model: z.string().trim().min(1).max(200), imageModel: z.string().trim().min(1).max(200).default("unknown"),
  force: z.boolean().default(false), continueOnError: z.boolean().default(true),
}).strict();
const requestSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["text", "structured", "image"]), configuredModel: z.string(),
  instructions: z.string().optional(), input: z.string().optional(), schema: z.unknown().optional(), schemaName: z.string().optional(),
  prompt: z.string().optional(), negativePrompt: z.string().optional(), aspectRatio: z.string().optional(), size: z.string().optional(), quality: z.string().optional(),
  references: z.array(z.object({ path: z.string(), mimeType: z.string(), role: z.string().optional() })),
});
const stepSchema = z.object({
  chapter: z.number().int().positive(), stage: agentStageSchema,
  status: z.enum(["pending", "complete", "reused", "blocked", "failed", "refused"]),
  preview: z.enum(["run", "reuse", "blocked"]), reason: z.string().optional(),
  quality: z.enum(["pass", "warn", "fail"]).optional(), completedAt: z.string().optional(),
});
const runSchema = z.object({
  version: z.literal(1), id: idSchema, input: agentPlanInputSchema, planFingerprint: z.string(),
  storyFingerprint: z.string(), approvedAt: z.string().optional(), createdAt: z.string(), updatedAt: z.string(),
  status: z.enum(["awaiting-confirmation", "running", "needs-input", "complete"]),
  steps: z.array(stepSchema), cursor: z.number().int().nonnegative(),
  responses: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.object({ file: z.string() })),
  request: requestSchema.optional(), contextGaps: z.array(z.number().int().positive()).default([]),
  diagnostic: z.string().optional(),
});
export type AgentRun = z.infer<typeof runSchema>;
function runPaths(root: string, story: string, id: string) {
  const directory = join(storyPaths(root, slugSchema.parse(story), 1).story, "agent-runs", idSchema.parse(id));
  return { directory, manifest: join(directory, "run.json"), snapshotRoot: join(directory, "snapshot") };
}
async function save(root: string, run: AgentRun) {
  run.updatedAt = new Date().toISOString();
  await atomicWriteJson(runPaths(root, run.input.story, run.id).manifest, runSchema.parse(run));
}
async function load(root: string, story: string, id: string) {
  const run = runSchema.parse(await readJsonIfExists(runPaths(root, story, id).manifest));
  if (run.id !== id || run.input.story !== story) throw new Error("Agent run identity mismatch");
  for (const response of Object.values(run.responses)) safeRelative(response.file);
  return run;
}
async function loadStory(root: string, slug: string): Promise<Story> {
  const story = storySchema.parse(await readJsonIfExists(storyPaths(root, slug, 1).storyConfig));
  if (story.slug !== slug) throw new Error("Story configuration slug mismatch");
  return story;
}
async function sourcePath(root: string, slug: string, chapter: number) {
  const paths = storyPaths(root, slug, chapter);
  const raw = await readJsonIfExists(paths.sourceManifest);
  const imported = raw ? sourceManifestSchema.parse(raw).chapters.find((item) => item.chapter === chapter) : undefined;
  const path = imported ? join(paths.source, safeRelative(imported.file)) : paths.original;
  const text = await readFile(path, "utf8");
  if (!text.trim()) throw new Error(`Chapter ${chapter} source is empty`);
  if (imported && importedChapterFingerprint(imported.ref, text) !== imported.fingerprint) throw new Error(`Chapter ${chapter} imported source changed; refresh/import it first`);
  return path;
}
async function sourceMetadata(root: string, slug: string, chapter: number) {
  const raw = await readJsonIfExists(storyPaths(root, slug, chapter).sourceManifest);
  const item = raw ? sourceManifestSchema.parse(raw).chapters.find((candidate) => candidate.chapter === chapter) : undefined;
  if (!item) return undefined;
  return { type: item.ref.sourceType, sourceId: item.ref.sourceId, originalTitle: item.ref.originalTitle, fingerprint: item.contentFingerprint ?? item.fingerprint, metadata: item.ref.metadata };
}
async function prerequisiteProblem(root: string, story: string, chapter: number, stage: AgentStage, simulated = new Set<string>()) {
  for (const dependency of directStagePrerequisites(stage)) {
    if (simulated.has(dependency)) continue;
    if (dependency === "ingestion") { await sourcePath(root, story, chapter); continue; }
    const artifact = await inspectStageArtifact(root, story, chapter, dependency);
    if (artifact.availability !== "available") return `${dependency} prerequisite is ${artifact.availability}. Provide it or include the supported stage in a new request.`;
  }
  if (["storyBible", "continuity", "scenePlanning", "artwork"].includes(stage) && !simulated.has("qa")) {
    const qa = await readJsonIfExists(storyPaths(root, story, chapter).qa);
    if (qa && qaStateSchema.parse(qa).status === "fail") return "QA has critical findings. Resolve or dismiss them before downstream generation.";
  }
  return undefined;
}
async function canReuse(root: string, slug: string, chapter: number, stage: AgentStage) {
  const artifact = await inspectStageArtifact(root, slug, chapter, stage);
  if (artifact.availability !== "available" || artifact.freshness !== "current") return false;
  const paths = storyPaths(root, slug, chapter);
  const metadata = chapterSchema.parse(await readJsonIfExists(paths.chapterMeta));
  const output = { translation: paths.english, narration: paths.narration, qa: paths.qa, storyBible: paths.bibleUpdate, continuity: paths.continuityAnalysis, scenePlanning: paths.scenesManifest, artwork: paths.scenesManifest }[stage];
  return Boolean(metadata.stages[stage].outputFingerprint && metadata.stages[stage].outputFingerprint === await fileFingerprint(output));
}
export async function prepareAgentRun(root: string, raw: unknown): Promise<AgentRun> {
  const input = agentPlanInputSchema.parse(raw);
  input.chapters = [...new Set(input.chapters)].sort((a, b) => a - b);
  input.stages = orderedBatchStages(input.stages) as AgentStage[];
  await loadStory(root, input.story);
  return withStoryLock(root, input.story, "prepare subscription processing", async () => {
    const story = storyPaths(root, input.story, 1).story;
    await recoverTransactions(story);
    const before = await inventory(story);
    const steps: AgentRun["steps"] = [];
    for (const chapter of input.chapters) {
      const simulated = new Set<string>();
      let sourceError: string | undefined;
      try { await sourcePath(root, input.story, chapter); } catch (error) { sourceError = errorMessage(error); }
      for (const stage of input.stages) {
        const reuse = !input.force && await canReuse(root, input.story, chapter, stage);
        const reason = sourceError ?? await prerequisiteProblem(root, input.story, chapter, stage, simulated);
        steps.push({ chapter, stage, status: "pending", preview: reuse ? "reuse" : reason ? "blocked" : "run", reason });
        if (!reason || reuse) { simulated.add(stage); if (stage === "translation") simulated.add("ingestion"); if (stage === "storyBible") simulated.add("context"); }
      }
    }
    const storyFingerprint = inventoryFingerprint(before);
    const now = new Date().toISOString();
    const run: AgentRun = { version: 1, id: randomUUID(), input, planFingerprint: fingerprint({ input, storyFingerprint, steps }), storyFingerprint,
      createdAt: now, updatedAt: now, status: "awaiting-confirmation", steps, cursor: 0, responses: {}, contextGaps: [] };
    await save(root, run);
    return run;
  });
}
export async function confirmAgentRun(root: string, story: string, id: string, planFingerprint: string) {
  return withStoryLock(root, slugSchema.parse(story), "confirm subscription processing", async () => {
    await recoverTransactions(storyPaths(root, story, 1).story);
    const run = await load(root, story, id);
    if (run.planFingerprint !== planFingerprint) throw new Error("Confirmation does not match the preview");
    if (inventoryFingerprint(await inventory(storyPaths(root, story, 1).story)) !== run.storyFingerprint) throw new Error("Story changed since preview. Prepare and confirm a new plan.");
    if (!run.approvedAt) { run.approvedAt = new Date().toISOString(); run.status = "running"; await save(root, run); }
    return run;
  });
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function annotate(root: string, run: AgentRun, stage: AgentStage, chapter: number, story: Story, sourceRoot: string) {
  const paths = storyPaths(root, story.slug, chapter);
  const metadata = chapterSchema.parse(await readJsonIfExists(paths.chapterMeta));
  const state = metadata.stages[stage];
  if (state.status !== "complete") throw new Error(`Stage ${stage} failed: ${state.error?.message ?? "output is incomplete"}`);
  const model = stage === "artwork" ? run.input.imageModel : run.input.model;
  if (stage !== "continuity") { state.provider = run.input.agent; state.model = model; state.usage = undefined; }
  state.execution = { source: "subscription-agent", agent: run.input.agent, runId: run.id, modelReported: model !== "unknown", apiRequests: 0 };
  // Retained subscription results remain reusable through normal pipeline runs.
  if (state.outputFingerprint) state.manualAcceptance = { acceptedAt: new Date().toISOString(), acceptedReason: "Validated subscription agent output", acceptedFingerprint: manualAcceptanceFingerprint(stage, state.outputFingerprint, story) };
  if (stage === "scenePlanning" || stage === "artwork") {
    const manifest = sceneManifestSchema.parse(await readJsonIfExists(paths.scenesManifest));
    if (stage === "scenePlanning") manifest.planner = { ...manifest.planner, provider: run.input.agent, model };
    else {
      const previous = sceneManifestSchema.parse(await readJsonIfExists(storyPaths(sourceRoot, story.slug, chapter).scenesManifest));
      for (const scene of manifest.scenes) {
        if (scene.disabled || scene.artwork.status !== "complete") continue;
        const latest = scene.artwork.versions?.at(-1);
        const previousScene = previous.scenes.find((candidate) => candidate.id === scene.id);
        const previousVersions = previousScene?.artwork.versions ?? [];
        const previousMax = previousVersions.length ? Math.max(...previousVersions.map((version) => version.versionNumber)) : previousScene?.artwork.status === "complete" ? 1 : 0;
        if (!latest || latest.versionNumber <= previousMax) continue;
        scene.artwork.provider = run.input.agent; scene.artwork.model = model;
        if (latest) { latest.provider = run.input.agent; latest.model = model; if (latest.original) { latest.original.provider = run.input.agent; latest.original.model = model; } }
      }
    }
    await writeArtworkOutputManifest(root, story.slug, chapter, manifest);
    state.outputFingerprint = await fileFingerprint(paths.scenesManifest);
    if (state.outputFingerprint) state.manualAcceptance = { acceptedAt: new Date().toISOString(), acceptedFingerprint: manualAcceptanceFingerprint(stage, state.outputFingerprint, story) };
  }
  metadata.updatedAt = new Date().toISOString();
  await atomicWriteJson(paths.chapterMeta, metadata);
}

/** Advance in ascending chapter/stage order. Only completed, validated snapshots reach the story. */
export async function nextAgentRequest(root: string, storySlug: string, id: string): Promise<AgentRun> {
  return withStoryLock(root, slugSchema.parse(storySlug), "subscription processing", async () => {
    const storyDir = storyPaths(root, storySlug, 1).story;
    await recoverTransactions(storyDir);
    const run = await load(root, storySlug, id);
    if (!run.approvedAt) throw new Error("Confirm the preview before execution");
    if (run.status === "complete" || run.status === "needs-input") return run;
    const paths = runPaths(root, storySlug, id);
    const finishStep = async (step: AgentRun["steps"][number]) => {
      if (["failed", "refused", "blocked"].includes(step.status) && run.input.stages.includes("storyBible") && !await canReuse(root, storySlug, step.chapter, "storyBible")) run.contextGaps = [...new Set([...run.contextGaps, step.chapter])];
      if (step.status === "failed" || step.status === "refused") {
        const metadataPath = storyPaths(root, storySlug, step.chapter).chapterMeta;
        const raw = await readJsonIfExists(metadataPath);
        {
          const config = await loadStory(root, storySlug);
          const now = new Date().toISOString();
          const metadata = chapterSchema.parse(raw ?? {
            chapter: step.chapter, sourceLanguage: config.sourceLanguage, outputLanguage: config.outputLanguage,
            counts: { originalCharacters: 0, englishWords: 0, narrationWords: 0 }, createdAt: now, updatedAt: now,
            stages: Object.fromEntries(stageNameSchema.options.map((stage) => [stage, { status: "pending" }])),
          });
          const state = metadata.stages[step.stage];
          const message = step.reason ?? "Agent stage failed";
          state.lastAgentAttempt = { runId: run.id, agent: run.input.agent, model: step.stage === "artwork" ? run.input.imageModel : run.input.model, status: step.status, message, at: now };
          if (state.status !== "complete") { state.status = "failed"; state.error = { message }; }
          metadata.updatedAt = new Date().toISOString();
          await atomicWriteJson(metadataPath, metadata);
          run.storyFingerprint = inventoryFingerprint(await inventory(storyDir));
        }
      }
      step.completedAt ??= new Date().toISOString();
      run.request = undefined; run.responses = {}; run.cursor++;
      await rm(paths.snapshotRoot, { recursive: true, force: true });
      if (!run.input.continueOnError && ["failed", "refused", "blocked"].includes(step.status)) { run.status = "needs-input"; run.diagnostic = step.reason; }
      await save(root, run);
      return run.status === "needs-input";
    };
    while (run.cursor < run.steps.length) {
      const step = run.steps[run.cursor]!;
      if (step.status !== "pending") { if (await finishStep(step)) return run; continue; }
      const before = await inventory(storyDir);
      if (inventoryFingerprint(before) !== run.storyFingerprint) {
        run.status = "needs-input"; run.diagnostic = "Story changed while this run was paused. Prepare and confirm a new run; prior completed outputs are preserved."; await save(root, run); return run;
      }
      let pending: AgentRequest | undefined;
      let committing = false;
      try {
        await sourcePath(root, storySlug, step.chapter);
        const failedDependency = run.steps.slice(0, run.cursor).find((prior) => prior.chapter === step.chapter && ["failed", "refused", "blocked"].includes(prior.status) && directStagePrerequisites(step.stage).includes(prior.stage));
        const contextGap = ["storyBible", "continuity"].includes(step.stage) && run.contextGaps.some((chapter) => chapter < step.chapter);
        const problem = failedDependency ? `${failedDependency.stage} did not complete for this chapter.` : contextGap ? "An earlier selected chapter left a Story Bible context gap. Repair it before canonical updates." : await prerequisiteProblem(root, storySlug, step.chapter, step.stage);
        if (problem) { step.status = "blocked"; step.reason = problem; }
        else if (!run.input.force && await canReuse(root, storySlug, step.chapter, step.stage)) { step.status = "reused"; step.reason = undefined; }
        else {
          await rm(paths.snapshotRoot, { recursive: true, force: true });
          const snapshotStory = storyPaths(paths.snapshotRoot, storySlug, 1).story;
          await copySnapshot(storyDir, snapshotStory, before);
          const config = await loadStory(paths.snapshotRoot, storySlug);
          await executeAgentStage({ root: paths.snapshotRoot, runDir: paths.directory, story: config, chapter: step.chapter, stage: step.stage,
            source: await sourceMetadata(paths.snapshotRoot, storySlug, step.chapter), force: run.input.force,
            inputPath: await sourcePath(paths.snapshotRoot, storySlug, step.chapter), responses: run.responses, onRequest: (request) => { pending ??= request; } });
          // Artwork intentionally catches individual scene failures; a captured
          // request still suspends the entire stage before any live commit.
          if (pending) { run.request = pending; await save(root, run); return run; }
          await annotate(paths.snapshotRoot, run, step.stage, step.chapter, config, root);
          const after = await inventory(snapshotStory);
          run.storyFingerprint = inventoryFingerprint(after);
          step.status = "complete"; step.reason = undefined; step.completedAt = new Date().toISOString();
          if (step.stage === "qa") step.quality = qaStateSchema.parse(await readJsonIfExists(storyPaths(paths.snapshotRoot, storySlug, step.chapter).qa)).status;
          run.updatedAt = new Date().toISOString();
          run.request = undefined; run.responses = {};
          committing = true;
          await commitSnapshot(storyDir, snapshotStory, paths.directory, before, after, {
            path: join("agent-runs", id, "run.json"), data: JSON.stringify(runSchema.parse(run), null, 2),
          });
          committing = false;
      }
      } catch (error) {
        if (committing) throw error; // Persistence failures require recovery; never advance the batch.
        if (pending) { run.request = pending; run.status = "running"; await save(root, run); return run; }
        if (run.request && (error instanceof z.ZodError || error instanceof SyntaxError)) {
          delete run.responses[run.request.id];
          run.status = "needs-input"; run.diagnostic = `Invalid agent response: ${errorMessage(error)}. Correct the response file and submit it again.`;
          await save(root, run); return run;
        }
        step.reason = errorMessage(error);
        step.status = /refused.*summary|returned a summary|offer.*summary/i.test(step.reason) ? "refused" : "failed";
      }
      if (await finishStep(step)) return run;
    }
    run.status = "complete"; run.request = undefined; await save(root, run); return run;
  });
}
export async function submitAgentResponse(root: string, story: string, id: string, requestId: string, file: string) {
  await withStoryLock(root, slugSchema.parse(story), "save subscription response", async () => {
    await recoverTransactions(storyPaths(root, story, 1).story);
    const run = await load(root, story, id);
    if (!run.approvedAt || !["running", "needs-input"].includes(run.status) || run.request?.id !== requestId) throw new Error("Response does not match the current approved request");
    const info = await stat(file);
    if (!info.isFile() || info.size === 0 || info.size > 32 * 1024 * 1024) throw new Error("Response must be a nonempty file of at most 32 MiB");
    const relativeFile = join("responses", `${requestId}.${run.request.kind === "image" ? "png" : "txt"}`);
    await atomicWrite(join(runPaths(root, story, id).directory, relativeFile), await readFile(file));
    run.responses[requestId] = { file: relativeFile }; run.status = "running"; run.diagnostic = undefined;
    await save(root, run);
  });
  return nextAgentRequest(root, story, id);
}
export async function failAgentRequest(root: string, story: string, id: string, requestId: string, outcome: "refused" | "failed" | "needs-input", reason: string) {
  await withStoryLock(root, slugSchema.parse(story), "record subscription failure", async () => {
    await recoverTransactions(storyPaths(root, story, 1).story);
    const run = await load(root, story, id);
    if (!run.approvedAt || run.status !== "running" || run.request?.id !== requestId) throw new Error("Failure does not match the current approved request");
    if (outcome === "needs-input") { run.status = "needs-input"; run.diagnostic = reason; }
    else { const step = run.steps[run.cursor]!; step.status = outcome; step.reason = reason; run.request = undefined; run.responses = {}; }
    await save(root, run);
  });
  return nextAgentRequest(root, story, id);
}
export async function resumeAgentRun(root: string, story: string, id: string) {
  await withStoryLock(root, slugSchema.parse(story), "resume subscription processing", async () => {
    await recoverTransactions(storyPaths(root, story, 1).story);
    const run = await load(root, story, id);
    if (!run.approvedAt) throw new Error("Confirm the preview before execution");
    run.status = "running"; run.diagnostic = undefined; await save(root, run);
  });
  return nextAgentRequest(root, story, id);
}
export async function reportAgentRun(root: string, story: string, id: string) {
  return withStoryLock(root, slugSchema.parse(story), "inspect subscription run", async () => {
    await recoverTransactions(storyPaths(root, story, 1).story);
    return load(root, story, id);
  });
}
