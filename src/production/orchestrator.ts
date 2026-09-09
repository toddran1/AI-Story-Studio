import { Chapter, StageName, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { LLMProvider } from "../llm/provider.js";
import { PipelineOptions, PipelineStageEvent } from "../pipeline/chapter-pipeline.js";
import { QualityGateError } from "../pipeline/errors.js";
import { selectRepairStage } from "../qa/repair.js";
import { DiscoveredChapter } from "../batch/types.js";
import { retryConfigSchema } from "../batch/types.js";
import { withRetry } from "../batch/retry.js";
import { generateStoredSubtitles } from "../subtitles/chapter-subtitles.js";
import { planStoredScenes } from "../scenes/manifest.js";
import { generateStoredArtwork } from "../artwork/generator.js";
import { ImageProvider } from "../artwork/provider.js";
import { renderStoredChapterVideo } from "../video/chapter-video.js";
import { VideoProcessor } from "../video/renderer.js";
import { assembleVideoExport, VideoExportProcessor } from "../video/video-export.js";
import { assembleAudiobook, AudiobookProcessor } from "../audio/audiobook.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { buildProductionPlan, isProductionStageForced, resolveProductionOptions } from "./planner.js";
import { createProductionManifest, emptySummary, loadLatestProduction, persistProductionManifest } from "./manifest.js";
import { ProductionForce, ProductionManifest, ProductionOutput, ProductionPlan, ProductionStage } from "./types.js";

type Processor = { run(options: PipelineOptions): Promise<unknown> };
export type ProductionDependencies = {
  pipeline: Processor; loadChapters: () => Promise<DiscoveredChapter[]>; refresh?: (from: number, to: number) => Promise<unknown>;
  scenePlanner?: LLMProvider; image?: ImageProvider; video: VideoProcessor; videoExport: VideoExportProcessor; audiobook: AudiobookProcessor;
};
export type ProductionRequest = { root: string; story: Story; from: number; to: number; profile?: string; outputs?: ProductionOutput[]; artwork?: boolean; repairQa?: boolean; refresh?: boolean; dryRun?: boolean; force?: ProductionForce; audiobookFormat?: "mp3" | "m4b"; resume?: boolean; pause?: { readonly isRequested: boolean }; onProgress?: (event: Record<string, unknown>) => void };

export async function planProduction(request: ProductionRequest, dependencies: Pick<ProductionDependencies, "loadChapters" | "refresh">): Promise<{ plan: ProductionPlan; chapters: DiscoveredChapter[]; resolved: ReturnType<typeof resolveProductionOptions> }> {
  validateRange(request.from, request.to); if (request.refresh && !request.dryRun) { if (!dependencies.refresh) throw new Error("Remote refresh is not available"); await dependencies.refresh(request.from, request.to); }
  const all = await dependencies.loadChapters(); const chapters = all.filter((item) => item.chapter >= request.from && item.chapter <= request.to).sort((a, b) => a.chapter - b.chapter);
  if (!chapters.length) throw new Error(`No imported chapters were found in range ${request.from}-${request.to}`);
  const missing = []; const selected = new Set(chapters.map((item) => item.chapter)); for (let number = request.from; number <= request.to; number++) if (!selected.has(number)) missing.push(number);
  if (missing.length) throw new Error(`Production range has missing chapters: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? "…" : ""}`);
  const resolved = resolveProductionOptions(request.story, request); const plan = await buildProductionPlan({ root: request.root, story: request.story, chapters: chapters.map((item) => item.chapter), outputs: resolved.outputs, artwork: resolved.artwork, force: request.force }); if (request.refresh) { plan.stages.unshift("refresh"); plan.counts.refresh = { required: 1, reusable: 0 }; } return { plan, chapters, resolved };
}

export async function runProduction(request: ProductionRequest, dependencies: ProductionDependencies): Promise<{ manifest: ProductionManifest; plan: ProductionPlan }> {
  const started = Date.now(); const { plan, chapters, resolved } = await planProduction(request, dependencies); const manifestOptions: ProductionManifest["options"] = { outputs: resolved.outputs, artwork: resolved.artwork, repairQa: resolved.repairQa, refresh: Boolean(request.refresh), audiobookFormat: resolved.audiobookFormat, force: request.force, profile: request.profile, dryRun: Boolean(request.dryRun) };
  let manifest = await resumableManifest(request, plan, manifestOptions) ?? createProductionManifest(request.story, plan, manifestOptions);
  if (request.dryRun) { manifest.status = "planned"; manifest.summary = summarize(manifest, Date.now() - started); await persistProductionManifest(request.root, manifest); request.onProgress?.({ type: "production.planned", plan }); return { manifest, plan }; }
  manifest.status = "running"; manifest.startedAt ??= new Date().toISOString(); await persistProductionManifest(request.root, manifest); request.onProgress?.({ type: "production.started", runId: manifest.id, total: chapters.length, plan });
  for (let index = 0; index < chapters.length; index++) {
    const source = chapters[index]!; const run = manifest.chapters[String(source.chapter)]!;
    if (request.pause?.isRequested) { manifest.status = "paused"; break; }
    if (!request.force && run.status === "complete" && await canResumeChapter(request.root, request.story, source.chapter, plan.stages)) { request.onProgress?.({ type: "production.chapter.resumed", chapter: source.chapter, index: index + 1, total: chapters.length }); continue; }
    run.status = "running"; run.error = undefined; manifest.current = { chapter: source.chapter }; request.onProgress?.({ type: "production.chapter.started", chapter: source.chapter, index: index + 1, total: chapters.length }); await persistProductionManifest(request.root, manifest);
    let writeChain = Promise.resolve(); const stageEvent = (event: PipelineStageEvent) => { updateOperation(run.operations, event.stage, event.status); manifest.current = { chapter: source.chapter, stage: event.stage }; request.onProgress?.({ type: "production.stage", chapter: source.chapter, stage: event.stage, status: event.status }); writeChain = writeChain.then(() => persistProductionManifest(request.root, manifest)); };
    try {
      let produced: unknown; let repairs = 0; let requestedForce = coreForce(request.force);
      const runCore = (force: PipelineOptions["force"]) => { let attempt = 0; return withRetry(() => dependencies.pipeline.run({ root: request.root, story: request.story, chapter: source.chapter, inputPath: source.path, source: source.source, force: attempt === 1 ? force : undefined, onStageEvent: stageEvent }), retryConfigSchema.parse({ maxAttempts: manifest.retry.maxProviderAttempts }), { shouldStop: () => Boolean(request.pause?.isRequested), onAttempt: (value) => { attempt = value; if (value > 1) request.onProgress?.({ type: "production.chapter.retrying", chapter: source.chapter, attempt: value, maximum: manifest.retry.maxProviderAttempts }); } }); };
      while (true) {
        try { produced = await runCore(requestedForce); break; }
        catch (error) { const gate = findQualityGate(error); if (!gate || !resolved.repairQa || repairs >= manifest.retry.maxQaRepairs) throw error; repairs++; requestedForce = selectRepairStage(gate.result); request.onProgress?.({ type: "production.qa.repair", chapter: source.chapter, stage: requestedForce, attempt: repairs, maximum: manifest.retry.maxQaRepairs }); }
      }
      await writeChain; const chapter = await loadProducedChapter(request.root, request.story.slug, source.chapter, produced); markCoreFallback(run, chapter); run.qa = chapter?.quality?.status;
      if (run.qa === "warn") run.warning = "QA completed with warnings; manual review is recommended";
      if (run.qa === "fail") { run.status = "needs-review"; run.error = `Chapter ${source.chapter} failed QA`; manifest.failures.push({ chapter: source.chapter, stage: "qa", message: run.error, at: new Date().toISOString() }); }
      else {
        if (plan.stages.includes("subtitles")) await execute(run, manifest, source.chapter, "subtitles", request, () => generateStoredSubtitles({ root: request.root, story: request.story, chapter: source.chapter, force: isProductionStageForced(request.force, "subtitles") }));
        if (plan.stages.includes("scenePlanning")) { if (!dependencies.scenePlanner) throw new Error("Scene planner is not configured"); await execute(run, manifest, source.chapter, "scenePlanning", request, () => planStoredScenes({ root: request.root, story: request.story, chapter: source.chapter, provider: dependencies.scenePlanner!, force: isProductionStageForced(request.force, "scenePlanning") })); }
        if (plan.stages.includes("artwork")) { if (!dependencies.image) throw new Error("Image provider is not configured"); await execute(run, manifest, source.chapter, "artwork", request, () => generateStoredArtwork({ root: request.root, story: request.story, chapter: source.chapter, provider: dependencies.image!, force: isProductionStageForced(request.force, "artwork"), onProgress: (event) => request.onProgress?.(event) })); }
        if (plan.stages.includes("video")) await execute(run, manifest, source.chapter, "video", request, () => renderStoredChapterVideo({ root: request.root, story: request.story, chapter: source.chapter, processor: dependencies.video, force: isProductionStageForced(request.force, "video") }));
        run.status = run.qa === "warn" ? "needs-review" : "complete";
      }
      request.onProgress?.({ type: "production.chapter.completed", chapter: source.chapter, index: index + 1, total: chapters.length, qa: run.qa });
    } catch (error) {
      await writeChain; const gate = findQualityGate(error); run.qa = gate?.result.status ?? run.qa; run.status = gate ? "needs-review" : "failed"; run.error = error instanceof Error ? error.message : String(error); const stage = manifest.current.stage ?? "qa"; if (run.operations[stage]) run.operations[stage] = { ...run.operations[stage]!, status: "failed", error: run.error }; manifest.failures.push({ chapter: source.chapter, stage, message: run.error, at: new Date().toISOString() }); request.onProgress?.({ type: "production.chapter.failed", chapter: source.chapter, error: run.error, needsReview: Boolean(gate) });
    }
    manifest.summary = summarize(manifest, Date.now() - started); await persistProductionManifest(request.root, manifest);
    if (request.pause?.isRequested) { manifest.status = "paused"; break; }
  }
  if (manifest.status !== "paused") await buildExports(request, dependencies, manifest, plan, resolved.audiobookFormat);
  manifest.summary = summarize(manifest, Date.now() - started); manifest.current = {}; if (manifest.status !== "paused") { manifest.status = manifest.summary.failed || manifest.summary.needsReview ? "completed_with_errors" : "completed"; manifest.completedAt = new Date().toISOString(); } await persistProductionManifest(request.root, manifest); request.onProgress?.({ type: "production.completed", status: manifest.status, summary: manifest.summary }); return { manifest, plan };
}

async function execute(run: ProductionManifest["chapters"][string], manifest: ProductionManifest, chapter: number, stage: ProductionStage, request: ProductionRequest, action: () => Promise<unknown>) { const operation = run.operations[stage] ??= { status: "pending", reused: false, attempts: 0 }; operation.status = "running"; operation.attempts++; operation.startedAt = new Date().toISOString(); operation.error = undefined; manifest.current = { chapter, stage }; request.onProgress?.({ type: "production.stage", chapter, stage, status: "started" }); await persistProductionManifest(request.root, manifest); try { const result = await action(); const value = typeof result === "object" && result !== null ? result as { reused?: unknown; generated?: unknown } : {}; operation.status = "complete"; operation.reused = typeof value.reused === "boolean" ? value.reused : value.generated === 0; operation.completedAt = new Date().toISOString(); request.onProgress?.({ type: "production.stage", chapter, stage, status: operation.reused ? "reused" : "completed" }); await persistProductionManifest(request.root, manifest); } catch (error) { operation.status = "failed"; operation.error = error instanceof Error ? error.message : String(error); throw error; } }

async function buildExports(request: ProductionRequest, dependencies: ProductionDependencies, manifest: ProductionManifest, plan: ProductionPlan, format: "mp3" | "m4b") {
  const blocked = Object.values(manifest.chapters).some((chapter) => chapter.status === "failed" || chapter.status === "needs-review" && chapter.qa === "fail"); if (blocked) return;
  if (plan.stages.includes("audiobook")) try { manifest.current = { stage: "audiobook" }; request.onProgress?.({ type: "production.export.started", stage: "audiobook" }); const result = await assembleAudiobook({ root: request.root, story: request.story, from: plan.from, to: plan.to, format, processor: dependencies.audiobook, force: isProductionStageForced(request.force, "audiobook") }); manifest.summary.exports.audiobook = result.manifest.output; request.onProgress?.({ type: "production.export.completed", stage: "audiobook", reused: result.reused, output: result.manifest.output }); } catch (error) { addExportFailure(manifest, "audiobook", error); }
  if (plan.stages.includes("videoExport")) try { manifest.current = { stage: "videoExport" }; request.onProgress?.({ type: "production.export.started", stage: "videoExport" }); const result = await assembleVideoExport({ root: request.root, story: request.story, from: plan.from, to: plan.to, processor: dependencies.videoExport, force: isProductionStageForced(request.force, "videoExport") }); manifest.summary.exports.video = result.manifest.output; request.onProgress?.({ type: "production.export.completed", stage: "videoExport", reused: result.reused, output: result.manifest.output }); } catch (error) { addExportFailure(manifest, "videoExport", error); }
}
function addExportFailure(manifest: ProductionManifest, stage: "audiobook" | "videoExport", error: unknown) { const message = error instanceof Error ? error.message : String(error); manifest.failures.push({ stage, message, at: new Date().toISOString() }); }
function updateOperation(operations: ProductionManifest["chapters"][string]["operations"], stage: StageName, status: PipelineStageEvent["status"]) { const operation = operations[stage] ??= { status: "pending", reused: false, attempts: 0 }; if (status === "started") { operation.status = "running"; operation.attempts++; operation.startedAt = new Date().toISOString(); } else { operation.status = "complete"; operation.reused = status === "reused"; operation.completedAt = new Date().toISOString(); } }
function markCoreFallback(run: ProductionManifest["chapters"][string], chapter?: Chapter) { if (!chapter) return; for (const stage of ["ingestion", "translation", "narration", "qa", "storyBible", "tts", "audioMastering"] as const) { const op = run.operations[stage]; if (op && op.status === "pending" && chapter.stages[stage].status === "complete") Object.assign(op, { status: "complete", reused: true, completedAt: new Date().toISOString() }); } }
async function loadProducedChapter(root: string, slug: string, chapter: number, produced: unknown) { const parsed = chapterSchema.safeParse(produced); if (parsed.success) return parsed.data; const raw = await readJsonIfExists<Chapter>(storyPaths(root, slug, chapter).chapterMeta); const stored = raw ? chapterSchema.safeParse(raw) : undefined; return stored?.success ? stored.data : undefined; }
function summarize(manifest: ProductionManifest, elapsedMs: number): ProductionManifest["summary"] { const summary = { ...emptySummary(Object.keys(manifest.chapters).length), exports: manifest.summary.exports, elapsedMs }; for (const chapter of Object.values(manifest.chapters)) { if (chapter.status === "complete") summary.completed++; if (chapter.status === "needs-review") summary.needsReview++; if (chapter.status === "failed") summary.failed++; if (chapter.qa === "warn") summary.qaWarnings++; if (chapter.qa === "fail") summary.qaFailures++; for (const operation of Object.values(chapter.operations)) if (operation.status === "complete") operation.reused ? summary.reusedStages++ : summary.newStages++; } if (manifest.failures.some((item) => item.chapter === undefined)) summary.failed++; return summary; }
async function resumableManifest(request: ProductionRequest, plan: ProductionPlan, options: ProductionManifest["options"]) { if (request.resume === false || request.dryRun || request.force) return undefined; const latest = await loadLatestProduction(request.root, request.story.slug); if (!latest || latest.status === "completed" || latest.storyFingerprint !== fingerprint(request.story) || latest.selection.from !== plan.from || latest.selection.to !== plan.to || fingerprint(resumeSignature(latest.options)) !== fingerprint(resumeSignature(options))) return undefined; for (const chapter of Object.values(latest.chapters)) if (chapter.status !== "complete") chapter.status = "pending"; latest.failures = []; latest.status = "running"; return latest; }
function resumeSignature(options: ProductionManifest["options"]) { return { outputs: [...options.outputs].sort(), artwork: options.artwork, repairQa: options.repairQa, audiobookFormat: options.audiobookFormat, profile: options.profile ?? null }; }
async function canResumeChapter(root: string, story: Story, chapter: number, stages: ProductionStage[]) { const raw = await readJsonIfExists<Chapter>(storyPaths(root, story.slug, chapter).chapterMeta); const parsed = raw ? chapterSchema.safeParse(raw) : undefined; if (!parsed?.success) return false; return stages.filter((stage): stage is StageName => !["audiobook", "videoExport", "refresh"].includes(stage)).every((stage) => parsed.data.stages[stage].status === "complete"); }
function findQualityGate(error: unknown): QualityGateError | undefined { let current = error; for (let depth = 0; current && depth < 8; depth++) { if (current instanceof QualityGateError) return current; current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined; } return undefined; }
function coreForce(force?: ProductionForce): PipelineOptions["force"] { if (!force) return undefined; if (["ingestion", "translation", "narration", "qa", "story-bible", "tts", "audio", "all"].includes(force)) return force as PipelineOptions["force"]; return undefined; }
function validateRange(from: number, to: number) { if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from > 10_000) throw new Error("Production range must contain positive chapter numbers with from <= to and at most 10,001 chapters"); }
