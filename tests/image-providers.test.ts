import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artworkFingerprint, generateStoredArtwork, reviewStoredArtwork, referenceAssignmentPrompt, loadApprovedVisualProfileReferences } from "../src/artwork/generator.js";
import { GeminiImageProvider } from "../src/artwork/gemini-image.provider.js";
import { OpenAIImageProvider } from "../src/artwork/openai-image.provider.js";
import { ImageGenerationRequest, ImageProvider } from "../src/artwork/provider.js";
import {
  assertImageModelCompatible,
  defaultImageModel,
  IMAGE_PROVIDER_CATALOG,
  imageModelCompatible,
  imageNativeTiers,
} from "../src/artwork/providers.js";
import { ImageProviderRouter } from "../src/artwork/router.js";
import { ConfigurationError } from "../src/pipeline/errors.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { emptyStoryBible } from "../src/domain/story-bible.js";
import { Story } from "../src/domain/story.js";
import { LLMProvider } from "../src/llm/provider.js";
import { planStoredScenes } from "../src/scenes/manifest.js";
import { artworkSettingsSchema, sceneDirectionSchema, sceneManifestSchema } from "../src/scenes/types.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths, visualProfileRefPath } from "../src/storage/paths.js";
import { loadVisualProfiles, saveVisualProfiles } from "../src/visual-canon/profiles.js";
import { resolveVisualCanonPrompt } from "../src/visual-canon/resolver.js";
import { loadStoryArtDirection, resolveActiveArtDirection } from "../src/visual-canon/art-direction.js";
import { pricingFor, calculateCost } from "../src/cost/pricing.js";
import { pngWithDims, testStory } from "./helpers.js";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PNG_ALT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ENTITY_ID = "ent_111111111111111111111111";

class SceneLLM implements LLMProvider {
  readonly name = "openai" as const;
  async validateConfiguration() {}
  async generateText() { return { text: "" }; }
  async generateStructured<T>(request: any): Promise<any> {
    return {
      value: request.schema.parse({
        scenes: [
          { summary: "Li Chen enters the observatory.", startSeconds: 0, endSeconds: 15, characters: ["Li Chen"], location: "Old Observatory", visualPrompt: "Li Chen beneath the brass telescope", importance: "major" },
          { summary: "The star map ignites.", startSeconds: 15, endSeconds: 30, characters: ["Li Chen"], location: "Old Observatory", visualPrompt: "Blue constellations flare across the chamber", importance: "standard" },
        ],
      }) as T,
    };
  }
}

function fakeImages(name: string, data: Buffer = PNG_1X1) {
  const calls: ImageGenerationRequest[] = [];
  const provider: ImageProvider & { calls: ImageGenerationRequest[] } = {
    name,
    version: `fake-${name}-v1`,
    calls,
    validateConfiguration: async () => {},
    generate: async (request) => { calls.push(request); return { data, mimeType: "image/png" as const }; },
  };
  return provider;
}

async function fixture(artwork?: Partial<Story["artwork"]>, options?: { withCanon?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), "image-providers-"));
  const story: Story = { ...testStory(), artwork: { ...testStory().artwork, ...artwork } };
  const paths = storyPaths(root, story.slug, 1);
  const now = new Date().toISOString();
  const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
  const chapter = chapterSchema.parse({
    chapter: 1, originalTitle: "The Observatory", sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
    counts: { originalCharacters: 50, englishWords: 20, narrationWords: 18 }, createdAt: now, updatedAt: now,
    stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: complete, subtitles: { status: "pending" }, scenePlanning: { status: "pending" }, artwork: { status: "pending" }, video: { status: "pending" } },
    audio: { durationSeconds: 30, codec: "mp3", container: "mp3" },
  });
  await atomicWriteJson(paths.chapterMeta, chapter);
  await atomicWrite(paths.narration, "Li Chen entered the old observatory. Above him, a map of blue stars awakened.");
  await atomicWrite(paths.audio, Buffer.from("mastered"));
  if (options?.withCanon) {
    await atomicWriteJson(paths.bible, {
      ...emptyStoryBible(),
      canonicalEntities: [{
        id: ENTITY_ID, type: "character", canonicalName: "Li Chen", aliases: [], originalName: "",
        description: "Young swordsman with a ragged cloak.", firstAppearance: 1, lastKnownAppearance: 1,
      }],
    });
    await saveVisualProfiles(root, story.slug, {
      [ENTITY_ID]: {
        id: "vp-1", entityId: ENTITY_ID, visualType: "character", status: "approved", revision: 1,
        createdAt: now, updatedAt: now, appearance: "Tall and lean with raven hair.",
        visualPrompt: "young swordsman, raven hair, charcoal robe", notes: "", negativePrompt: "", variants: [],
        references: [{ id: "ref-1", entityId: ENTITY_ID, role: "face_portrait", imagePath: "ignored/persisted/path.png", source: "uploaded", approved: true, createdAt: now }],
      },
    });
    await atomicWrite(visualProfileRefPath(root, story.slug, ENTITY_ID, "ref-1", "png"), PNG_ALT);
  }
  await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
  return { root, story, paths };
}

describe("image provider registry", () => {
  it("exposes provider defaults and supported models", () => {
    expect(defaultImageModel("openai")).toBe("gpt-image-2.5-flare");
    expect(IMAGE_PROVIDER_CATALOG.openai.models).toContain("gpt-image-2.5-sunburst");
    expect(defaultImageModel("gemini")).toBe("gemini-3.1-flash-image");
    expect(() => defaultImageModel("midjourney")).toThrow("not supported");
  });
  it("routes openai and gemini and rejects unregistered providers", () => {
    const openai = fakeImages("openai"); const gemini = fakeImages("gemini");
    const router = new ImageProviderRouter(new Map([["openai", openai], ["gemini", gemini]]));
    expect(router.forName("openai")).toBe(openai);
    expect(router.forName("gemini")).toBe(gemini);
    expect(router.names().sort()).toEqual(["gemini", "openai"]);
    expect(() => router.forName("missing")).toThrow("not registered");
  });
  it("fails incompatible provider/model combinations before any API call", () => {
    expect(imageModelCompatible("openai", "gpt-image-2.5-flare")).toBe(true);
    expect(imageModelCompatible("openai", "gpt-image-1")).toBe(true);
    expect(imageModelCompatible("openai", "gemini-3.1-flash-image")).toBe(false);
    expect(imageModelCompatible("gemini", "gpt-image-2.5-flare")).toBe(false);
    expect(() => assertImageModelCompatible("openai", "gemini-3.1-flash-image")).toThrow(/not compatible/);
  });
  it("requires credentials with a useful configuration error", async () => {
    await expect(new OpenAIImageProvider().validateConfiguration()).rejects.toBeInstanceOf(ConfigurationError);
    await expect(new OpenAIImageProvider().validateConfiguration()).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(new GeminiImageProvider().validateConfiguration()).rejects.toBeInstanceOf(ConfigurationError);
    await expect(new GeminiImageProvider().validateConfiguration()).rejects.toThrow(/GEMINI_API_KEY/);
  });
  it("defaults new artwork settings to gpt-image-2.5-flare while loading legacy values", () => {
    const parsed = artworkSettingsSchema.parse({});
    expect(parsed).toMatchObject({ provider: "openai", model: "gpt-image-2.5-flare", aspectRatio: "16:9" });
    const legacy = artworkSettingsSchema.parse({ provider: "openai", model: "gpt-image-1" });
    expect(legacy.model).toBe("gpt-image-1");
    expect(artworkSettingsSchema.parse({ provider: "gemini", model: "gemini-3.1-flash-image" }).provider).toBe("gemini");
  });
  it("provides model-aware native tiers reflecting differing model capabilities", () => {
    // gemini-3.1-flash-image has 1K, 2K, 4K tiers
    const flashTiers = imageNativeTiers("gemini", "16:9", "gemini-3.1-flash-image");
    expect(flashTiers).toHaveLength(3);
    expect(flashTiers?.map((t) => t.label)).toEqual(["1K", "2K", "4K"]);

    // gemini-2.5-flash-image has only 1K tier
    const liteTiers = imageNativeTiers("gemini", "16:9", "gemini-2.5-flash-image");
    expect(liteTiers).toHaveLength(1);
    expect(liteTiers?.[0]?.label).toBe("1K");

    // OpenAI models all share legal tiers
    const openaiTiers = imageNativeTiers("openai", "16:9", "gpt-image-2.5-flare");
    expect(openaiTiers).toHaveLength(1);
    expect(openaiTiers?.[0]?.width).toBe(1536);
  });
});

describe("OpenAI image adapter", () => {
  const okClient = (captured: { generate?: any; edit?: any }) => ({
    images: {
      generate: async (params: any) => { captured.generate = params; return { data: [{ b64_json: PNG_1X1.toString("base64"), revised_prompt: "revised" }] }; },
      edit: async (params: any) => { captured.edit = params; return { data: [{ b64_json: PNG_1X1.toString("base64") }] }; },
    },
  });
  const request: ImageGenerationRequest = {
    model: "gpt-image-2.5-flare", prompt: "A brass observatory", negativePrompt: "text, watermark",
    aspectRatio: "16:9", quality: "medium", size: "1536x1024", outputFormat: "png",
  };
  it("maps the normalized intent onto the images.generate API", async () => {
    const captured: any = {};
    const provider = new OpenAIImageProvider("key", 1000, okClient(captured) as any);
    const result = await provider.generate(request);
    expect(captured.generate).toMatchObject({ model: "gpt-image-2.5-flare", size: "1536x1024", quality: "medium", output_format: "png", n: 1 });
    expect(captured.generate.prompt).toContain("A brass observatory");
    expect(captured.generate.prompt).toContain("AVOID: text, watermark");
    expect(captured.edit).toBeUndefined();
    expect(result.mimeType).toBe("image/png");
    expect(result.revisedPrompt).toBe("revised");
  });
  it("routes reference images through images.edit only for the 2.5 family", async () => {
    const referenceImages = [{ data: PNG_ALT, mimeType: "image/png", role: "face_portrait" }];
    const withRefs: any = {};
    const provider = new OpenAIImageProvider("key", 1000, okClient(withRefs) as any);
    await provider.generate({ ...request, referenceImages });
    expect(withRefs.edit).toBeDefined();
    expect(withRefs.edit.model).toBe("gpt-image-2.5-flare");
    expect(withRefs.edit.image).toHaveLength(1);
    expect(withRefs.generate).toBeUndefined();
    const legacy: any = {};
    const legacyProvider = new OpenAIImageProvider("key", 1000, okClient(legacy) as any);
    await legacyProvider.generate({ ...request, model: "gpt-image-1", referenceImages });
    expect(legacy.generate).toBeDefined();
    expect(legacy.edit).toBeUndefined();
  });
  it("classifies provider errors with the shared OpenAI taxonomy", async () => {
    const failing = { images: { generate: async () => { throw Object.assign(new Error("Incorrect API key"), { status: 401, request_id: "req_123" }); } } };
    const provider = new OpenAIImageProvider("key", 1000, failing as any);
    await expect(provider.generate(request)).rejects.toMatchObject({ category: "authentication_error", requestId: "req_123", provider: "openai" });
  });
});

describe("Gemini image adapter", () => {
  function geminiClient(captured: { request?: any }, response: unknown) {
    return { models: { generateContent: async (req: any) => { captured.request = req; return response; } } };
  }
  const okResponse = {
    responseId: "resp-1",
    candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_1X1.toString("base64") } }] } }],
  };
  const request: ImageGenerationRequest = {
    model: "gemini-3.1-flash-image", prompt: "A brass observatory", aspectRatio: "16:9",
    quality: "medium", size: "1536x1024", outputFormat: "png",
    referenceImages: [{ data: PNG_ALT, mimeType: "image/png", role: "face_portrait" }],
  };
  it("maps the normalized intent onto generateContent with image parts", async () => {
    const captured: any = {};
    const provider = new GeminiImageProvider("key", 1000, geminiClient(captured, okResponse) as any);
    const result = await provider.generate(request);
    expect(captured.request.model).toBe("gemini-3.1-flash-image");
    expect(captured.request.config.responseModalities).toEqual(["IMAGE"]);
    expect(captured.request.config.imageConfig).toEqual({ aspectRatio: "16:9", imageSize: "2K" });
    const parts = captured.request.contents[0].parts;
    expect(parts[0].text).toContain("A brass observatory");
    expect(parts[1].inlineData.mimeType).toBe("image/png");
    expect(Buffer.from(parts[1].inlineData.data, "base64").equals(PNG_ALT)).toBe(true);
    expect(result).toMatchObject({ mimeType: "image/png", requestId: "resp-1" });
  });
  it("maps quality intent to image size", async () => {
    for (const [quality, imageSize] of [["low", "1K"], ["high", "4K"]] as const) {
      const captured: any = {};
      const provider = new GeminiImageProvider("key", 1000, geminiClient(captured, okResponse) as any);
      await provider.generate({ ...request, quality, referenceImages: undefined });
      expect(captured.request.config.imageConfig.imageSize).toBe(imageSize);
    }
  });
  it("sends supported image sizes and clamps unsupported sizes for 1K-only models", async () => {
    // gemini-3.1-flash-image supports 1K, 2K, 4K
    const captured4K: any = {};
    const provider = new GeminiImageProvider("key", 1000, geminiClient(captured4K, okResponse) as any);
    await provider.generate({ ...request, model: "gemini-3.1-flash-image", quality: "high", referenceImages: undefined });
    expect(captured4K.request.config.imageConfig.imageSize).toBe("4K");

    // gemini-2.5-flash-image only supports 1K - requesting high must NOT send 4K, it clamps to 1K
    const captured1K: any = {};
    const provider1K = new GeminiImageProvider("key", 1000, geminiClient(captured1K, okResponse) as any);
    await provider1K.generate({ ...request, model: "gemini-2.5-flash-image", quality: "high", referenceImages: undefined });
    expect(captured1K.request.config.imageConfig.imageSize).toBe("1K");
  });
  it("fails safely on malformed, empty, or blocked responses", async () => {
    const textOnly = { candidates: [{ content: { parts: [{ text: "no image" }] } }] };
    await expect(new GeminiImageProvider("key", 1000, geminiClient({}, textOnly) as any).generate(request)).rejects.toThrow(/no image data/);
    const empty = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "" } }] } }] };
    await expect(new GeminiImageProvider("key", 1000, geminiClient({}, empty) as any).generate(request)).rejects.toThrow(/no image data|empty image/);
    const blocked = { promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "blocked" } };
    await expect(new GeminiImageProvider("key", 1000, geminiClient({}, blocked) as any).generate(request)).rejects.toThrow(/blocked/i);
  });
  it("classifies rate-limit errors", async () => {
    const failing = { models: { generateContent: async () => { throw Object.assign(new Error("Resource exhausted"), { status: 429 }); } } };
    await expect(new GeminiImageProvider("key", 1000, failing as any).generate(request)).rejects.toMatchObject({ category: "rate_limited", provider: "gemini", retryable: true });
  });
});

describe("artwork routing and provenance", () => {
  it("scopes mixed-grounding character references to their owner in provider order", async () => {
    const { root, story, paths } = await fixture({ provider: "gemini", model: "gemini-3.1-flash-image" }, { withCanon: true });
    const fallbackId = "ent_222222222222222222222222";
    const bible = JSON.parse(await readFile(paths.bible, "utf8"));
    bible.canonicalEntities.push({ id: fallbackId, type: "character", canonicalName: "Zhang Yongxing", aliases: [], description: "A young rival with a guarded manner.", firstAppearance: 1, lastKnownAppearance: 1 });
    await atomicWriteJson(paths.bible, bible);
    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    manifest.scenes[0]!.characters = ["Li Chen", "Zhang Yongxing"];
    manifest.scenes[0]!.summary = "Zhang betrays Li Chen.";
    await atomicWriteJson(paths.scenesManifest, manifest);
    const profiles = await loadVisualProfiles(root, story.slug);
    profiles[ENTITY_ID]!.references.push({ id: "ref-2", entityId: ENTITY_ID, role: "front", imagePath: "ignored/path.png", source: "uploaded", approved: true, createdAt: new Date().toISOString() });
    await saveVisualProfiles(root, story.slug, profiles);
    await atomicWrite(visualProfileRefPath(root, story.slug, ENTITY_ID, "ref-2", "png"), PNG_ALT);
    const artDirection = resolveActiveArtDirection(await loadStoryArtDirection(root, story.slug));
    const resolved = resolveVisualCanonPrompt({ scene: manifest.scenes[0]!, story, bible, artDirection, visualProfiles: profiles });
    const loaded = await loadApprovedVisualProfileReferences(root, story, resolved);
    expect(loaded.images.map((image) => ({ entityId: image.entityId, entityName: image.entityName, referenceId: image.referenceId, role: image.role }))).toEqual([
      { entityId: ENTITY_ID, entityName: "Li Chen", referenceId: "ref-1", role: "face_portrait" },
      { entityId: ENTITY_ID, entityName: "Li Chen", referenceId: "ref-2", role: "front" },
    ]);
    expect(referenceAssignmentPrompt(resolved, [...loaded.images, { data: PNG_ALT, mimeType: "image/png", sourceKind: "continuity" }])).toContain("Reference image 3 is scene continuity");
    const images = fakeImages("gemini");
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: manifest.scenes[0]!.id, allowUnprofiledEntityIds: [fallbackId] });
    const request = images.calls[0]!;
    expect(request.referenceImages?.map((image) => image.referenceId)).toEqual(["ref-1", "ref-2"]);
    expect(request.prompt).toContain("Reference image 1 depicts Li Chen only");
    expect(request.prompt).toContain("Zhang Yongxing: no character reference image");
    expect(request.prompt).toContain("Li Chen and Zhang Yongxing are different people");
    const after = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    expect(after.scenes[0]!.artwork.versions[0]!.provenance).toMatchObject({ characterReferences: [{ entityId: ENTITY_ID, referenceId: "ref-1" }, { entityId: ENTITY_ID, referenceId: "ref-2" }], visualGrounding: [{ mode: "approved_profile" }, { mode: "story_bible_fallback" }] });
    expect(JSON.parse(await readFile(paths.bible, "utf8")).canonicalEntities[1].visualProfilePolicy).toBeUndefined();
    bible.canonicalEntities[1].visualProfilePolicy = { mode: "skip" };
    await atomicWriteJson(paths.bible, bible);
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: manifest.scenes[0]!.id, force: true });
    expect(images.calls[1]!.prompt).toContain("Zhang Yongxing: no character reference image");
    expect(images.calls[1]!.referenceImages?.every((image) => image.entityId === ENTITY_ID)).toBe(true);
  });
  it("mentions only supplied references after budget truncation and omits pairwise guidance for one character", async () => {
    const { root, story, paths } = await fixture({ provider: "gemini", model: "gemini-3.1-flash-image" }, { withCanon: true });
    const profiles = await loadVisualProfiles(root, story.slug);
    for (let index = 2; index <= 5; index++) {
      profiles[ENTITY_ID]!.references.push({ id: `ref-${index}`, entityId: ENTITY_ID, role: "front", imagePath: "ignored/path.png", source: "uploaded", approved: true, createdAt: new Date().toISOString() });
      await atomicWrite(visualProfileRefPath(root, story.slug, ENTITY_ID, `ref-${index}`, "png"), PNG_ALT);
    }
    await saveVisualProfiles(root, story.slug, profiles);
    const bible = JSON.parse(await readFile(paths.bible, "utf8"));
    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    const artDirection = resolveActiveArtDirection(await loadStoryArtDirection(root, story.slug));
    const resolved = resolveVisualCanonPrompt({ scene: manifest.scenes[0]!, story, bible, artDirection, visualProfiles: profiles });
    const loaded = await loadApprovedVisualProfileReferences(root, story, resolved);
    expect(loaded.images).toHaveLength(4);
    expect(loaded.loadedReferenceIds).not.toContain("ref-5");
    const assignment = referenceAssignmentPrompt(resolved, loaded.images);
    expect(assignment).toContain("Reference image 4 depicts Li Chen only");
    expect(assignment).not.toContain("Reference image 5");
    expect(resolved.prompt).not.toContain("CHARACTER IDENTITY SEPARATION:");
  });
  it("passes Visual Canon reference bytes when the provider supports them", async () => {
    const { root, story, paths } = await fixture({ provider: "gemini", model: "gemini-3.1-flash-image" }, { withCanon: true });
    const images = fakeImages("gemini");
    const result = await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });
    expect(result.generated).toBe(1);
    expect(images.calls).toHaveLength(1);
    expect(images.calls[0]!.referenceImages).toHaveLength(1);
    expect(images.calls[0]!.referenceImages![0]!.data.equals(PNG_ALT)).toBe(true);
    expect(images.calls[0]!.prompt).toContain("REFERENCE USAGE:");
    expect(images.calls[0]!.prompt).toContain("Do not copy conflicting clothing");
    expect(images.calls[0]!.aspectRatio).toBe("16:9");
    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    const version = manifest.scenes[0]!.artwork.versions[0]!;
    expect(version.provider).toBe("gemini");
    expect(version.model).toBe("gemini-3.1-flash-image");
    expect(version.provenance).toMatchObject({ referencesUsed: "images", referenceImageCount: 1, availableReferenceCount: 1 });
  });
  it("records the text-only fallback when the provider cannot consume references", async () => {
    const { root, story, paths } = await fixture({ provider: "openai", model: "gpt-image-1" }, { withCanon: true });
    const images = fakeImages("openai");
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });
    expect(images.calls[0]!.referenceImages ?? []).toHaveLength(0);
    expect(images.calls[0]!.prompt).not.toContain("REFERENCE USAGE:");
    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    expect(manifest.scenes[0]!.artwork.versions[0]!.provenance).toMatchObject({ referencesUsed: "text-only", referenceImageCount: 0, availableReferenceCount: 1 });
  });
  it("passes reference images for the gpt-image-2.5 family", async () => {
    const { root, story } = await fixture({ provider: "openai", model: "gpt-image-2.5-sunburst" }, { withCanon: true });
    const images = fakeImages("openai");
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });
    expect(images.calls[0]!.referenceImages).toHaveLength(1);
  });
  it("does not attach character profile references when the scene disables them", async () => {
    const { root, story, paths } = await fixture({ provider: "gemini", model: "gemini-3.1-flash-image" }, { withCanon: true });
    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    manifest.scenes[0]!.direction = { ...sceneDirectionSchema.parse(manifest.scenes[0]!.direction ?? {}), useCharacterReferences: false };
    await atomicWriteJson(paths.scenesManifest, manifest);
    const images = fakeImages("gemini");
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });
    expect(images.calls[0]!.referenceImages ?? []).toHaveLength(0);
    expect(images.calls[0]!.prompt).toContain("Young swordsman with a ragged cloak");
    expect(images.calls[0]!.prompt).not.toContain("young swordsman, raven hair, charcoal robe");
  });
  it("rejects an incompatible provider/model before any provider call", async () => {
    const { root, story } = await fixture({ provider: "openai", model: "gemini-3.1-flash-image" });
    const images = fakeImages("openai");
    await expect(generateStoredArtwork({ root, story, chapter: 1, provider: images })).rejects.toThrow(/not compatible/);
    expect(images.calls).toHaveLength(0);
  });
  it("rejects a resolved provider that does not match the story configuration", async () => {
    const { root, story } = await fixture({ provider: "openai", model: "gpt-image-1" });
    await expect(generateStoredArtwork({ root, story, chapter: 1, provider: fakeImages("gemini") })).rejects.toThrow(/provider mismatch/i);
  });
  it("includes the effective provider and model in dry-run estimates without provider calls", async () => {
    const { root, story } = await fixture({ provider: "gemini", model: "gemini-3.1-flash-image" });
    const images = fakeImages("gemini");
    const estimate = await generateStoredArtwork({ root, story, chapter: 1, provider: images, dryRun: true });
    expect(estimate).toMatchObject({ dryRun: true, provider: "gemini", model: "gemini-3.1-flash-image", imagesToGenerate: 2 });
    expect(images.calls).toHaveLength(0);
  });
  it("makes artwork stale on provider/model change, versions regens, and protects approved art", async () => {
    const { root, story, paths } = await fixture({ provider: "openai", model: "gpt-image-1" });
    const first = fakeImages("openai", PNG_1X1);
    await generateStoredArtwork({ root, story, chapter: 1, provider: first, sceneId: "scene-001" });
    await reviewStoredArtwork({ root, story, chapter: 1, sceneId: "scene-001", review: "approved" });
    const beforeBytes = await readFile(join(paths.scenesDirectory, "scene-001.png"));
    const upgraded: Story = { ...story, artwork: { ...story.artwork, model: "gpt-image-2.5-flare" } };
    const second = fakeImages("openai", PNG_ALT);
    const rerun = await generateStoredArtwork({ root, story: upgraded, chapter: 1, provider: second, sceneId: "scene-001" });
    expect(rerun.generated).toBe(1);
    expect(artworkFingerprint((sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")))).scenes[0]!, [], upgraded, second.version))
      .not.toBe(artworkFingerprint(sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8"))).scenes[0]!, [], story, first.version));
    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    const artwork = manifest.scenes[0]!.artwork;
    expect(artwork.versions).toHaveLength(2);
    expect(artwork.approvedVersionId).toBe("v1");
    expect(artwork.versions[0]!.review).toBe("approved");
    expect((await readFile(join(paths.scenesDirectory, "scene-001.png"))).equals(beforeBytes)).toBe(true);
    const providerSwitched: Story = { ...story, artwork: { ...story.artwork, provider: "gemini", model: "gemini-3.1-flash-image" } };
    expect(artworkFingerprint(manifest.scenes[0]!, [], providerSwitched, "gemini-images-v1")).not.toBe(artwork.versions[0]!.promptFingerprint);
  });
  it("requests final 4K output on a 1K-native Gemini model and falls through to production upscaling", async () => {
    const { root, story, paths } = await fixture({ provider: "gemini", model: "gemini-2.5-flash-image", outputResolution: "2160p", quality: "high" });
    const images = fakeImages("gemini", pngWithDims(1376, 768));
    class RecordingUpscaler {
      readonly name = "local-realesrgan" as const;
      readonly version = "fake-upscaler-v1";
      upscaleCalls: any[] = [];
      normalizeCalls: any[] = [];
      async validateConfiguration() {}
      async upscale(req: any) {
        this.upscaleCalls.push(req);
        await atomicWrite(req.outputPath, pngWithDims(req.targetWidth, req.targetHeight));
        return {
          outputPath: req.outputPath,
          sourceDimensions: { width: req.sourceWidth, height: req.sourceHeight },
          finalDimensions: { width: req.targetWidth, height: req.targetHeight },
          engine: this.name,
          model: "realesrgan-x4plus",
          scaleFactor: 4,
          fit: "crop" as const,
        };
      }
      async normalize(req: any) {
        this.normalizeCalls.push(req);
        return req;
      }
    }
    const upscaler = new RecordingUpscaler();
    const result = await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001", upscaler });
    expect(result.generated).toBe(1);
    expect(upscaler.upscaleCalls).toHaveLength(1);
    expect(upscaler.upscaleCalls[0]).toMatchObject({ sourceWidth: 1376, sourceHeight: 768, targetWidth: 3840, targetHeight: 2160 });
    const version = (await sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")))).scenes[0]!.artwork.versions[0]!;
    expect(version.original).toMatchObject({ width: 1376, height: 768 });
    expect(version.upscale).toMatchObject({ status: "applied", finalDimensions: { width: 3840, height: 2160 } });
  });
});

describe("image pricing", () => {
  it("prices the new image models and keeps legacy pricing intact", () => {
    expect(calculateCost(pricingFor("openai", "gpt-image-1", { quality: "medium", size: "1536x1024" }), { imageCount: 2 })).toBe(.126);
    expect(calculateCost(pricingFor("openai", "gpt-image-2.5-flare", { quality: "medium", size: "1536x1024" }), { imageCount: 1 })).toBeCloseTo(.0315, 9);
    expect(calculateCost(pricingFor("openai", "gpt-image-2.5-sunburst", { quality: "high", size: "1024x1024" }), { imageCount: 1 })).toBeCloseTo(.2505, 9);
    expect(calculateCost(pricingFor("gemini", "gemini-3.1-flash-image", { quality: "medium", size: "1536x1024" }), { imageCount: 3 })).toBeCloseTo(.135, 9);
    expect(calculateCost(pricingFor("gemini", "gemini-2.5-flash-image", { quality: "high", size: "1536x1024" }), { imageCount: 1 })).toBeCloseTo(.02, 9);
    expect(pricingFor("openai", "unknown-image-model", { quality: "low", size: "1024x1024" })).toBeUndefined();
  });
});
