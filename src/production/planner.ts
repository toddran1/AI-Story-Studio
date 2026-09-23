import { stat } from "node:fs/promises";
import { Chapter, StageName, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { computeStoredQaDependencyFingerprint, DeterministicQaDependencies, loadQaDeterministicDependencies } from "../qa/freshness.js";
import { sceneManifestSchema } from "../scenes/types.js";
import { sceneImagePath, storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { fileFingerprint, filesFingerprint } from "../utils/file-fingerprint.js";
import { ProductionForce, ProductionOutput, ProductionPlan, ProductionProfile, ProductionStage, defaultProductionProfiles, productionProfileSchema } from "./types.js";
import { inspectStageArtifact } from "../studio/artifact-state.js";
import { enabledProductionScenes } from "../scenes/production.js";

const core: StageName[] = ["ingestion", "translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering"];

export function resolveProductionOptions(story: Story, input: { profile?: string; outputs?: ProductionOutput[]; artwork?: boolean; repairQa?: boolean; audiobookFormat?: "mp3" | "m4b"; alignment?: boolean }) {
  const profiles = story.productionProfiles ?? defaultProductionProfiles; const named = input.profile ? profiles[input.profile] : undefined;
  if (input.profile && !named) throw new Error(`Unknown production profile '${input.profile}'`);
  const profile: ProductionProfile = productionProfileSchema.parse(named ?? profiles.audiobook ?? defaultProductionProfiles.audiobook);
  return { outputs: unique(input.outputs ?? profile.outputs), artwork: input.artwork ?? profile.artwork, repairQa: input.repairQa ?? profile.repairQa, audiobookFormat: input.audiobookFormat ?? profile.audiobookFormat, alignment: input.alignment ?? true };
}

export function requiredProductionStages(outputs: ProductionOutput[], artwork: boolean, alignment = true): ProductionStage[] {
  const needed: ProductionStage[] = [...core]; const video = outputs.includes("video");
  if (video) { if (alignment) needed.push("alignment"); needed.push("subtitles"); if (artwork) needed.push("scenePlanning", "artwork"); needed.push("video", "videoExport"); }
  if (outputs.includes("audiobook")) needed.push("audiobook");
  return needed;
}

export async function buildProductionPlan(options: { root: string; story: Story; chapters: number[]; outputs: ProductionOutput[]; artwork: boolean; alignment?: boolean; force?: ProductionForce }): Promise<ProductionPlan> {
  if (!options.chapters.length) throw new Error("Production requires at least one chapter"); const stages = requiredProductionStages(options.outputs, options.artwork, options.alignment); const counts: ProductionPlan["counts"] = {};
  for (const stage of stages) counts[stage] = { required: 0, reusable: 0 };
  let imageOperations = 0; let imagesPendingPlanning = 0; const requiredChapters: number[] = []; const chapterRequirements: Record<string, ProductionStage[]> = {}; const stageStates: ProductionPlan["stageStates"] = {};
  let qaDeterministicDeps: DeterministicQaDependencies | undefined;
  const currentQaFingerprint = async (chapter: number) => {
    qaDeterministicDeps ??= await loadQaDeterministicDependencies(options.root, options.story.slug);
    return computeStoredQaDependencyFingerprint(options.root, options.story, chapter, qaDeterministicDeps);
  };
  for (const number of options.chapters) {
    const paths = storyPaths(options.root, options.story.slug, number); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta); const chapter = raw ? chapterSchema.safeParse(raw) : undefined;
    let chapterRequired = false; const requiredStages: ProductionStage[] = []; const states: NonNullable<ProductionPlan["stageStates"]>[string] = {};
    for (const stage of stages.filter((value): value is StageName => !["audiobook", "videoExport", "refresh"].includes(value))) {
      const reusable = !isProductionStageForced(options.force, stage) && chapter?.success === true && await stageLooksReusable(chapter.data, stage, paths, stage === "qa" ? () => currentQaFingerprint(number) : undefined, options.root, options.story.slug, number);
      counts[stage]![reusable ? "reusable" : "required"]++;
      if (!reusable) { chapterRequired = true; requiredStages.push(stage); }
      const artifact = await inspectStageArtifact(options.root, options.story.slug, number, stage);
      states[stage] = { availability: artifact.availability, freshness: artifact.freshness, reusable };
    }
    stageStates[String(number)] = states;
    if (stages.includes("artwork")) {
      const manifestRaw = await readJsonIfExists(paths.scenesManifest); const manifest = manifestRaw ? sceneManifestSchema.safeParse(manifestRaw) : undefined;
      if (!manifest?.success) { imagesPendingPlanning++; chapterRequired = true; if (!requiredStages.includes("artwork")) requiredStages.push("artwork"); }
      else for (const scene of enabledProductionScenes(manifest.data.scenes)) { const path = sceneImagePath(options.root, options.story.slug, number, scene.id); const actual = await fileFingerprint(path); if (isProductionStageForced(options.force, "artwork") || scene.artwork.status !== "complete" || !scene.artwork.imageFingerprint || actual !== scene.artwork.imageFingerprint) { imageOperations++; chapterRequired = true; if (!requiredStages.includes("artwork")) requiredStages.push("artwork"); } }
    }
    if (chapterRequired) { requiredChapters.push(number); chapterRequirements[String(number)] = requiredStages; }
  }
  for (const stage of ["audiobook", "videoExport"] as const) if (stages.includes(stage)) counts[stage] = { required: 1, reusable: 0 };
  const llmOperations = ["translation", "narration", "qa", "storyBible", "scenePlanning"].reduce((sum, stage) => sum + (counts[stage]?.required ?? 0), 0);
  return { story: options.story.slug, from: options.chapters[0]!, to: options.chapters.at(-1)!, chapters: options.chapters, requiredChapters, chapterRequirements, stageStates, outputs: options.outputs, artwork: options.artwork, stages, counts,
    estimates: { llmOperations, ttsOperations: counts.tts?.required ?? 0, imageOperations, imagesPendingPlanning }, finalOutputs: [options.outputs.includes("audiobook") ? `Audiobook (${options.story.slug})` : "", options.outputs.includes("video") ? `Combined video (${options.story.slug})` : "", options.outputs.includes("audio") ? "Mastered chapter audio" : ""].filter(Boolean) };
}

export function isProductionStageForced(force: ProductionForce | undefined, stage: ProductionStage) {
  if (!force) return false; if (force === "all") return true;
  const aliases: Record<string, ProductionStage> = { "story-bible": "storyBible", audio: "audioMastering", scenes: "scenePlanning", "video-export": "videoExport" }; const normalized = aliases[force] ?? force as ProductionStage;
  if (normalized === "continuity") return stage === "continuity";
  const coreIndex = core.indexOf(normalized as StageName); if (coreIndex >= 0) return core.includes(stage as StageName) ? core.indexOf(stage as StageName) >= coreIndex : stage !== "refresh";
  const dependents: Partial<Record<ProductionStage, ProductionStage[]>> = { alignment: ["alignment", "subtitles", "video", "videoExport"], subtitles: ["subtitles", "video", "videoExport"], scenePlanning: ["scenePlanning", "artwork", "video", "videoExport"], artwork: ["artwork", "video", "videoExport"], video: ["video", "videoExport"], audiobook: ["audiobook"], videoExport: ["videoExport"] };
  return dependents[normalized]?.includes(stage) ?? false;
}

async function stageLooksReusable(chapter: Chapter, stage: StageName, paths: ReturnType<typeof storyPaths>, currentQaFingerprint?: () => Promise<string | undefined>, root?: string, slug?: string, chapterNumber?: number) {
  const state = chapter.stages[stage];
  if (stage === "artwork") {
    const parsed = sceneManifestSchema.safeParse(await readJsonIfExists(paths.scenesManifest));
    if (!parsed.success) return false;
    const enabled = enabledProductionScenes(parsed.data.scenes);
    if (!enabled.length) return false;
    for (const scene of enabled) {
      if (scene.artwork.status !== "complete" || !scene.artwork.imageFingerprint || !root || !slug || chapterNumber === undefined || await fileFingerprint(sceneImagePath(root, slug, chapterNumber, scene.id)) !== scene.artwork.imageFingerprint) return false;
    }
    return true;
  }
  if (state.status !== "complete") return false;
  const files: Partial<Record<StageName, string[]>> = { ingestion: [paths.original], translation: [paths.english], narration: [paths.narration], qa: [paths.qa], storyBible: [paths.bibleUpdate], continuity: [paths.continuityAnalysis], tts: [paths.audioRaw], audioMastering: [paths.audio], alignment: [paths.alignment], subtitles: [paths.subtitlesSrt, paths.subtitlesVtt, paths.subtitlesDocument], scenePlanning: [paths.scenesManifest], video: [paths.video] };
  const selected = files[stage] ?? []; if (!(await Promise.all(selected.map(nonEmpty))).every(Boolean)) return false;
  if (state.outputFingerprint) {
    const actual = selected.length === 1 ? await fileFingerprint(selected[0]!) : await filesFingerprint(selected);
    if (actual !== state.outputFingerprint) return false;
  }
  // QA reuse additionally requires the recorded input dependency fingerprint to
  // match the current effective one: a byte-identical qa.json is still stale
  // when the text, context, naming, pronunciation, exceptions, or settings it
  // was evaluated against have changed.
  if (stage === "qa" && currentQaFingerprint) {
    const current = await currentQaFingerprint();
    if (!current || state.fingerprint !== current) return false;
  }
  return true;
}
async function nonEmpty(path: string) { try { return (await stat(path)).size > 0; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function unique<T>(items: readonly T[]) { return [...new Set(items)]; }
