import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Story } from "../domain/story.js";
import { QaResult } from "../domain/qa.js";
import { LLMRouter } from "../llm/router.js";
import { polishNarration } from "../narration/narration-editor.js";
import { validateChapterQuality } from "../qa/validator.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { previewPaths } from "../storage/paths.js";
import { rebuildStoryBibleBeforeChapter } from "../story-bible/rebuild.js";
import { retrieveRelevantContext } from "../story-bible/retrieval.js";
import { TTSProvider } from "../tts/provider.js";
import { translate } from "../translation/translator.js";
import { fingerprint } from "../utils/hash.js";
import { PreviewManifest, PreviewPreset, previewManifestSchema } from "./types.js";
import { loadNarrationNamingEntities } from "../story-bible/narration-names.js";

export class PreviewRunner {
  constructor(private readonly llms: LLMRouter, private readonly tts: TTSProvider) {}

  async run(options: { root: string; story: Story; chapter: number; inputPath: string; presets: { a: PreviewPreset; b: PreviewPreset }; audioPreview: boolean; id?: string }): Promise<PreviewManifest> {
    const source = await readFile(options.inputPath, "utf8");
    if (!source.trim()) throw new Error(`Input file is empty: ${options.inputPath}`);
    const bible = await rebuildStoryBibleBeforeChapter(options.root, options.story.slug, options.chapter);
    const translationContext = retrieveRelevantContext(bible, source, options.chapter, { recentSummaryCount: options.story.context.recentChapterSummaries });
    const context = retrieveRelevantContext(bible, source, options.chapter, { recentSummaryCount: options.story.context.recentChapterSummaries, narrationNamingEntities: await loadNarrationNamingEntities(options.root, options.story.slug) });
    const id = options.id ?? `${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${randomUUID().slice(0, 8)}`;
    const paths = previewPaths(options.root, options.story.slug, id);

    const runPreset = async (choice: "a" | "b"): Promise<{ qaStatus: QaResult["status"]; qaScore: number; audioGenerated: boolean }> => {
      const preset = options.presets[choice];
      const translation = sameLanguage(options.story.sourceLanguage, options.story.outputLanguage)
        ? source
        : (await translate(this.llms.forStage(preset.translation), preset.translation, source, translationContext, options.story.sourceLanguage, options.story.outputLanguage)).text;
      const narration = (await polishNarration(this.llms.forStage(preset.narration), preset.narration, translation, options.story.outputLanguage, context)).text;
      const qa = (await validateChapterQuality(this.llms.forStage(preset.qa), preset.qa, {
        chapter: options.chapter, sourceLanguage: options.story.sourceLanguage, outputLanguage: options.story.outputLanguage,
        source, translation, narration, context,
      })).value;
      await atomicWrite(choice === "a" ? paths.translationA : paths.translationB, translation);
      await atomicWrite(choice === "a" ? paths.narrationA : paths.narrationB, narration);
      await atomicWriteJson(choice === "a" ? paths.qaA : paths.qaB, qa);
      let audioGenerated = false;
      if (options.audioPreview && qa.status !== "fail") {
        const sample = audioSample(narration);
        const result = await this.tts.synthesize({ text: sample, model: preset.tts.model, referenceId: preset.tts.referenceId,
          speed: preset.tts.speed, format: preset.tts.format, sampleRate: preset.tts.sampleRate, bitrate: preset.tts.bitrate,
          normalize: preset.tts.normalize, maxCharsPerRequest: preset.tts.maxCharsPerRequest });
        await atomicWrite(choice === "a" ? paths.audioA : paths.audioB, result.audio);
        audioGenerated = true;
      }
      return { qaStatus: qa.status, qaScore: qa.score, audioGenerated };
    };

    const a = await runPreset("a");
    const b = await runPreset("b");
    const manifest = previewManifestSchema.parse({
      id, story: options.story.slug, chapter: options.chapter, createdAt: new Date().toISOString(),
      inputFingerprint: fingerprint({ source, context }), audioPreview: options.audioPreview,
      presets: options.presets, results: { a, b },
    });
    await atomicWriteJson(paths.manifest, manifest);
    return manifest;
  }
}

// Roughly 75 seconds at a typical narration pace of 144 words/minute.
export function audioSample(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 180).join(" ");
}

const sameLanguage = (source: string, output: string) => source.trim().toLowerCase().replaceAll("_", "-") === output.trim().toLowerCase().replaceAll("_", "-");
