import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { LLMProvider } from "../llm/provider.js";
import type { LLMRequest, StructuredLLMRequest } from "../llm/types.js";
import { LLMRouter } from "../llm/router.js";
import { ChapterPipeline } from "../pipeline/chapter-pipeline.js";
import { ConfigurationError } from "../pipeline/errors.js";
import type { Story } from "../domain/story.js";
import { recheckChapterQa } from "../qa/review.js";
import { planStoredScenes } from "../scenes/manifest.js";
import { generateStoredArtwork } from "../artwork/generator.js";
import type { ImageGenerationRequest, ImageProvider } from "../artwork/provider.js";
import { imageDimensions } from "../artwork/resolution.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { fingerprint } from "../utils/hash.js";
import { storyPaths } from "../storage/paths.js";
import { assertUsableTranslation } from "../translation/translator.js";
import type { Chapter } from "../domain/chapter.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { sceneManifestSchema } from "../scenes/types.js";
import { inspectSceneArtwork } from "../studio/artifact-state.js";

export type AgentStage = "translation" | "narration" | "qa" | "storyBible" | "continuity" | "scenePlanning" | "artwork";
export type AgentRequest = {
  id: string; kind: "text" | "structured" | "image"; configuredModel: string;
  instructions?: string; input?: string; schema?: unknown; schemaName?: string;
  prompt?: string; negativePrompt?: string; aspectRatio?: string; size?: string; quality?: string;
  references: Array<{ path: string; mimeType: string; role?: string }>;
};
export class AwaitingAgentResponse extends ConfigurationError {}
export type Responses = Record<string, { file: string }>;

/** Uses only local replay adapters. No API adapters, credentials, or runtime factory. */
export async function executeAgentStage(options: {
  root: string; runDir: string; story: Story; chapter: number; stage: AgentStage; inputPath: string;
  source?: Chapter["source"]; force?: boolean;
  responses: Responses; onRequest: (request: AgentRequest) => void;
}) {
  const { root, runDir, story, chapter, stage } = options;
  async function exchange(kind: AgentRequest["kind"], request: LLMRequest | ImageGenerationRequest, schema?: z.ZodType, schemaName?: string) {
    const images = "prompt" in request ? request.referenceImages ?? [] : request.images ?? [];
    const refs = images.map((image) => ({ mimeType: image.mimeType, fingerprint: fingerprint(image.data.toString("base64")), ...("role" in image ? { role: image.role } : {}) }));
    const jsonSchema = schema ? z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) : undefined;
    const payload = "prompt" in request
      ? { configuredModel: request.model, prompt: request.prompt, negativePrompt: request.negativePrompt, aspectRatio: request.aspectRatio, size: request.size, quality: request.quality }
      : { configuredModel: request.model, instructions: request.instructions, input: request.input, schema: jsonSchema, schemaName };
    const id = fingerprint({ kind, ...payload, references: refs });
    const response = options.responses[id];
    if (response) {
      const data = await readFile(join(runDir, response.file));
      if (kind === "image") {
        if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new ConfigurationError("Image response must be a PNG");
        const dimensions = imageDimensions(data);
        if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 8192 || dimensions.height > 8192) throw new ConfigurationError("Image response has invalid dimensions");
        return data;
      }
      const text = data.toString("utf8");
      if (!text.trim()) throw new ConfigurationError("Agent returned empty output");
      if (kind === "text") { assertUsableTranslation(text); return text; }
      return schema!.parse(JSON.parse(text));
    }
    const references: AgentRequest["references"] = [];
    for (const [index, image] of images.entries()) {
      const extension = image.mimeType === "image/png" ? "png" : image.mimeType === "image/jpeg" ? "jpg" : "webp";
      const path = join(runDir, "requests", `${id}-${index}.${extension}`);
      await atomicWrite(path, image.data);
      references.push({ path, mimeType: image.mimeType, ...("role" in image ? { role: image.role } : {}) });
    }
    options.onRequest({ id, kind, ...payload, references });
    throw new AwaitingAgentResponse("Waiting for a subscription agent response");
  }
  const provider = (name: LLMProvider["name"]): LLMProvider => ({
    name, supportsImageInputs: true,
    async validateConfiguration() {},
    async generateText(request) { return { text: await exchange("text", request) as string }; },
    async generateStructured<T>(request: StructuredLLMRequest<T>) { return { value: await exchange("structured", request, request.schema, request.schemaName) as T }; },
  });
  const llm = provider(story.pipeline.translation.provider);
  if (stage === "qa") {
    await recheckChapterQa({ root, story, chapter, provider: llm, mode: "full" });
  } else if (stage === "scenePlanning") {
    await planStoredScenes({ root, story, chapter, provider: llm, force: true });
  } else if (stage === "artwork") {
    const image: ImageProvider = {
      name: story.artwork.provider, version: "subscription-agent-v1",
      async validateConfiguration() {},
      async generate(request) { const data = await exchange("image", request) as Buffer; return { data, mimeType: "image/png", ...imageDimensions(data) }; },
    };
    const manifest = sceneManifestSchema.parse(await readJsonIfExists(storyPaths(root, story.slug, chapter).scenesManifest));
    const sceneIds: string[] = [];
    for (const scene of manifest.scenes) {
      if (scene.disabled) continue;
      const state = await inspectSceneArtwork(root, story.slug, chapter, scene.id, scene.artwork.imageFingerprint);
      if (options.force || scene.artwork.status !== "complete" || state.availability !== "available") sceneIds.push(scene.id);
    }
    await generateStoredArtwork({ root, story, chapter, provider: image, force: true, sceneIds });
  } else {
    const router = new LLMRouter(new Map(["openai", "gemini", "kimi"].map((name) => [name, provider(name as LLMProvider["name"])])));
    const pipeline = new ChapterPipeline(router, {
      name: "fish", async validateConfiguration() { throw new ConfigurationError("Paid TTS is disabled in subscription processing"); },
      async synthesize() { throw new ConfigurationError("Paid TTS is disabled in subscription processing"); },
    });
    await pipeline.run({ root, story, chapter, inputPath: options.inputPath, source: options.source, stopAfter: stage,
      executionStages: stage === "translation" ? ["ingestion", stage] : stage === "storyBible" ? [stage, "context"] : [stage],
      qaRecoveryAttempted: true,
    });
  }
  return storyPaths(root, story.slug, chapter);
}
