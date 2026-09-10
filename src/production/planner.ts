import { readFile, stat } from "node:fs/promises";
import { Chapter, StageName, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { sceneManifestSchema } from "../scenes/types.js";
import { sceneImagePath, storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { ProductionForce, ProductionOutput, ProductionPlan, ProductionProfile, ProductionStage, defaultProductionProfiles, productionProfileSchema } from "./types.js";

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
  let imageOperations = 0; let imagesPendingPlanning = 0; const requiredChapters: number[] = []; const chapterRequirements: Record<string, ProductionStage[]> = {};
  for (const number of options.chapters) {
    const paths = storyPaths(options.root, options.story.slug, number); const raw = await readJsonIfExists<Chapter>(paths.chapterMeta); const chapter = raw ? chapterSchema.safeParse(raw) : undefined;
    let chapterRequired = false; const requiredStages: ProductionStage[] = [];
    for (const stage of stages.filter((value): value is StageName => !["audiobook", "videoExport", "refresh"].includes(value))) {
      const reusable = !isProductionStageForced(options.force, stage) && chapter?.success === true && await stageLooksReusable(chapter.data, stage, paths);
      counts[stage]![reusable ? "reusable" : "required"]++;
      if (!reusable) { chapterRequired = true; requiredStages.push(stage); }
    }
    if (stages.includes("artwork")) {
      const manifestRaw = await readJsonIfExists(paths.scenesManifest); const manifest = manifestRaw ? sceneManifestSchema.safeParse(manifestRaw) : undefined;
      if (!manifest?.success) { imagesPendingPlanning++; chapterRequired = true; if (!requiredStages.includes("artwork")) requiredStages.push("artwork"); }
      else for (const scene of manifest.data.scenes) { const path = sceneImagePath(options.root, options.story.slug, number, scene.id); const actual = await fileHash(path); if (isProductionStageForced(options.force, "artwork") || scene.artwork.status !== "complete" || !scene.artwork.imageFingerprint || actual !== scene.artwork.imageFingerprint) { imageOperations++; chapterRequired = true; if (!requiredStages.includes("artwork")) requiredStages.push("artwork"); } }
    }
    if (chapterRequired) { requiredChapters.push(number); chapterRequirements[String(number)] = requiredStages; }
  }
  for (const stage of ["audiobook", "videoExport"] as const) if (stages.includes(stage)) counts[stage] = { required: 1, reusable: 0 };
  const llmOperations = ["translation", "narration", "qa", "storyBible", "scenePlanning"].reduce((sum, stage) => sum + (counts[stage]?.required ?? 0), 0);
  return { story: options.story.slug, from: options.chapters[0]!, to: options.chapters.at(-1)!, chapters: options.chapters, requiredChapters, chapterRequirements, outputs: options.outputs, artwork: options.artwork, stages, counts,
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

async function stageLooksReusable(chapter: Chapter, stage: StageName, paths: ReturnType<typeof storyPaths>) {
  const state = chapter.stages[stage]; if (state.status !== "complete") return false;
  const files: Partial<Record<StageName, string[]>> = { ingestion: [paths.original], translation: [paths.english], narration: [paths.narration], qa: [paths.qa], storyBible: [paths.bibleUpdate], continuity: [paths.continuityAnalysis], tts: [paths.audioRaw], audioMastering: [paths.audio], alignment: [paths.alignment], subtitles: [paths.subtitlesSrt, paths.subtitlesVtt, paths.subtitlesDocument], scenePlanning: [paths.scenesManifest], video: [paths.video] };
  if (stage === "artwork") return chapter.scenes?.generated === chapter.scenes?.total;
  const selected = files[stage] ?? []; if (!(await Promise.all(selected.map(nonEmpty))).every(Boolean)) return false;
  if (!state.outputFingerprint) return true;
  const actual = selected.length === 1 ? await fileHash(selected[0]!) : await filesHash(selected); return actual === state.outputFingerprint;
}
async function fileHash(path: string) { try { const data = await readFile(path); return data.length ? fingerprint(data.toString("base64")) : undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function filesHash(paths: string[]) { try { const data = await Promise.all(paths.map((path) => readFile(path))); return data.every((item) => item.length) ? fingerprint(data.map((item) => item.toString("base64"))) : undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function nonEmpty(path: string) { try { return (await stat(path)).size > 0; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function unique<T>(items: readonly T[]) { return [...new Set(items)]; }
