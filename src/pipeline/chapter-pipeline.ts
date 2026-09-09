import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Chapter, StageName, StageState, chapterSchema } from "../domain/chapter.js";
import { Story } from "../domain/story.js";
import { StoryBibleUpdate, storyBibleUpdateSchema } from "../domain/story-bible.js";
import { LLMRouter } from "../llm/router.js";
import { TTSProvider } from "../tts/provider.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { exists, readJsonIfExists, readTextIfExists } from "../storage/story-files.js";
import { storyPaths } from "../storage/paths.js";
import { fingerprint } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import { TRANSLATION_PROMPT_VERSION } from "../translation/prompts.js";
import { translate } from "../translation/translator.js";
import { NARRATION_PROMPT_VERSION } from "../narration/prompts.js";
import { polishNarration } from "../narration/narration-editor.js";
import { STORY_BIBLE_PROMPT_VERSION } from "../story-bible/prompts.js";
import { extractStoryBible } from "../story-bible/extractor.js";
import { contextBeforeChapter, mergeStoryBible } from "../story-bible/updater.js";
import { rebuildStoryBibleBeforeChapter } from "../story-bible/rebuild.js";
import { PipelineError } from "./errors.js";

export type ForceStage = "translation" | "narration" | "story-bible" | "tts" | "all";
export type PipelineStageEvent = { stage: StageName; status: "started" | "completed" | "reused"; state: StageState };
export type PipelineOptions = {
  root: string; story: Story; chapter: number; inputPath: string; force?: ForceStage;
  source?: Chapter["source"];
  onStageEvent?: (event: PipelineStageEvent) => void;
};

const pending = (): StageState => ({ status: "pending" });

export class ChapterPipeline {
  constructor(private readonly llms: LLMRouter, private readonly tts: TTSProvider) {}

  async run(options: PipelineOptions): Promise<Chapter> {
    const paths = storyPaths(options.root, options.story.slug, options.chapter);
    await mkdir(paths.chapterDir, { recursive: true });
    const now = new Date().toISOString();
    let chapter = chapterSchema.parse((await readJsonIfExists<Chapter>(paths.chapterMeta)) ?? {
      chapter: options.chapter, sourceLanguage: options.story.sourceLanguage, outputLanguage: options.story.outputLanguage,
      counts: { originalCharacters: 0, englishWords: 0, narrationWords: 0 }, createdAt: now, updatedAt: now,
      stages: { ingestion: pending(), translation: pending(), narration: pending(), storyBible: pending(), tts: pending() },
    });
    if (options.source) {
      chapter.source = options.source;
      chapter.originalTitle = options.source.originalTitle;
    }
    let bible = await rebuildStoryBibleBeforeChapter(options.root, options.story.slug, options.chapter);
    const priorContext = contextBeforeChapter(bible, options.chapter, options.story.context.recentChapterSummaries);

    const source = await readFile(options.inputPath, "utf8");
    if (!source.trim()) throw new PipelineError(`Input file is empty: ${options.inputPath}`);

    const persist = async () => { chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(paths.chapterMeta, chapter); };
    if (options.source) await persist();
    const runStage = async <T>(stage: StageName, fp: string, outputExists: boolean, details: Partial<StageState>, action: () => Promise<T>): Promise<T | undefined> => {
      const state = chapter.stages[stage];
      const forced = isForced(options.force, stage);
      if (!forced && state.status === "complete" && state.fingerprint === fp && outputExists) {
        logger.info({ event: "pipeline.stage.reused", story: options.story.slug, chapter: options.chapter, stage });
        options.onStageEvent?.({ stage, status: "reused", state });
        return undefined;
      }
      const started = Date.now();
      chapter.stages[stage] = { ...details, status: "running", fingerprint: fp, startedAt: new Date().toISOString() };
      await persist();
      options.onStageEvent?.({ stage, status: "started", state: chapter.stages[stage] });
      logger.info({ event: "pipeline.stage.started", story: options.story.slug, chapter: options.chapter, stage, provider: details.provider, model: details.model });
      try {
        const value = await action();
        chapter.stages[stage] = { ...chapter.stages[stage], status: "complete", completedAt: new Date().toISOString(), durationMs: Date.now() - started, error: undefined };
        await persist();
        options.onStageEvent?.({ stage, status: "completed", state: chapter.stages[stage] });
        logger.info({ event: "pipeline.stage.completed", story: options.story.slug, chapter: options.chapter, stage, provider: details.provider, model: details.model, durationMs: Date.now() - started });
        return value;
      } catch (error) {
        chapter.stages[stage] = { ...chapter.stages[stage], status: "failed", durationMs: Date.now() - started,
          error: { message: error instanceof Error ? error.message : String(error), cause: error instanceof Error && error.cause ? String(error.cause) : undefined } };
        await persist();
        throw new PipelineError(`Story=${options.story.slug} Chapter=${options.chapter} Stage=${stage} Provider=${details.provider ?? "local"} Model=${details.model ?? "n/a"}: ${chapter.stages[stage].error?.message}`, { cause: error });
      }
    };

    const ingestionFp = fingerprint({ source, sourceLanguage: options.story.sourceLanguage, outputLanguage: options.story.outputLanguage });
    await runStage("ingestion", ingestionFp, await exists(paths.original), {}, async () => {
      await atomicWrite(paths.original, source);
      chapter.counts.originalCharacters = [...source].length;
    });

    const translationConfig = options.story.pipeline.translation;
    const passthroughTranslation = sameLanguage(options.story.sourceLanguage, options.story.outputLanguage);
    const translationFp = fingerprint({ source: ingestionFp, config: passthroughTranslation ? "passthrough" : translationConfig, prompt: passthroughTranslation ? "passthrough-v1" : TRANSLATION_PROMPT_VERSION, context: priorContext });
    const translationResult = await runStage("translation", translationFp, await exists(paths.english), {
      provider: passthroughTranslation ? "passthrough" : translationConfig.provider,
      model: passthroughTranslation ? undefined : translationConfig.model,
      promptVersion: passthroughTranslation ? "passthrough-v1" : TRANSLATION_PROMPT_VERSION,
    }, async () => {
      if (passthroughTranslation) {
        await atomicWrite(paths.english, source);
        chapter.counts.englishWords = wordCount(source);
        return source;
      }
      const provider = this.llms.forStage(translationConfig);
      const result = await translate(provider, translationConfig, source, priorContext);
      await atomicWrite(paths.english, result.text);
      chapter.counts.englishWords = wordCount(result.text);
      chapter.stages.translation.usage = result.usage;
      return result.text;
    });
    const english = translationResult ?? await requireText(paths.english, "translation");

    const narrationConfig = options.story.pipeline.narration;
    const narrationFp = fingerprint({ english: translationFp, config: narrationConfig, prompt: NARRATION_PROMPT_VERSION });
    const narrationResult = await runStage("narration", narrationFp, await exists(paths.narration), {
      provider: narrationConfig.provider, model: narrationConfig.model, promptVersion: NARRATION_PROMPT_VERSION,
    }, async () => {
      const result = await polishNarration(this.llms.forStage(narrationConfig), narrationConfig, english);
      await atomicWrite(paths.narration, result.text);
      chapter.counts.narrationWords = wordCount(result.text);
      chapter.stages.narration.usage = result.usage;
      return result.text;
    });
    const narration = narrationResult ?? await requireText(paths.narration, "narration");

    const bibleConfig = options.story.pipeline.storyBible;
    const bibleFp = fingerprint({ narration: narrationFp, config: bibleConfig, prompt: STORY_BIBLE_PROMPT_VERSION, context: priorContext });
    const bibleResult = await runStage("storyBible", bibleFp, await exists(paths.bibleUpdate) && await exists(paths.bible), {
      provider: bibleConfig.provider, model: bibleConfig.model, promptVersion: STORY_BIBLE_PROMPT_VERSION,
    }, async () => {
      const result = await extractStoryBible(this.llms.forStage(bibleConfig), bibleConfig, options.chapter, narration, priorContext);
      const update = storyBibleUpdateSchema.parse(result.value);
      await atomicWriteJson(paths.bibleUpdate, update);
      bible = mergeStoryBible(bible, update, options.chapter);
      await atomicWriteJson(paths.bible, bible);
      chapter.stages.storyBible.usage = result.usage;
      return bible;
    });
    if (bibleResult) bible = bibleResult;
    else {
      const cachedUpdate = storyBibleUpdateSchema.parse(await readJsonIfExists<StoryBibleUpdate>(paths.bibleUpdate));
      bible = mergeStoryBible(bible, cachedUpdate, options.chapter);
      await atomicWriteJson(paths.bible, bible);
    }

    const ttsConfig = options.story.pipeline.tts;
    const ttsFp = fingerprint({ narration: narrationFp, config: ttsConfig });
    await runStage("tts", ttsFp, await exists(paths.audio), { provider: ttsConfig.provider, model: ttsConfig.model }, async () => {
      const result = await this.tts.synthesize({ text: narration, model: ttsConfig.model, referenceId: ttsConfig.referenceId,
        speed: ttsConfig.speed, format: ttsConfig.format, sampleRate: ttsConfig.sampleRate, bitrate: ttsConfig.bitrate,
        normalize: ttsConfig.normalize, maxCharsPerRequest: ttsConfig.maxCharsPerRequest });
      await atomicWrite(paths.audio, result.audio);
      if (result.segments.length > 1) {
        await mkdir(paths.segments, { recursive: true });
        await Promise.all(result.segments.map((segment, index) => atomicWrite(join(paths.segments, `${String(index + 1).padStart(4, "0")}.mp3`), segment)));
      }
      chapter.stages.tts.usage = {
        requestId: result.requestIds?.join(","), requests: result.segments.length,
        characters: [...narration].length, bytes: result.audio.byteLength,
      };
    });

    return chapter;
  }
}

function isForced(force: ForceStage | undefined, stage: StageName): boolean {
  if (force === "all") return true;
  const order: StageName[] = ["ingestion", "translation", "narration", "storyBible", "tts"];
  const normalized = force === "story-bible" ? "storyBible" : force;
  if (!normalized) return false;
  // Forcing an upstream transform also invalidates all dependent downstream stages.
  return order.indexOf(stage) >= order.indexOf(normalized as StageName);
}

async function requireText(path: string, stage: string): Promise<string> {
  const text = await readTextIfExists(path);
  if (text === undefined) throw new PipelineError(`${stage} metadata is complete but output is missing: ${path}`);
  return text;
}

const wordCount = (text: string) => text.trim() ? text.trim().split(/\s+/).length : 0;
const sameLanguage = (source: string, output: string) => source.trim().toLowerCase().replaceAll("_", "-") === output.trim().toLowerCase().replaceAll("_", "-");
