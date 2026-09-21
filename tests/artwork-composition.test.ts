import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artworkCompositionGuidance, resolveArtworkAspectRatio } from "../src/artwork/composition.js";
import { artworkFingerprint, generateStoredArtwork } from "../src/artwork/generator.js";
import { ImageGenerationRequest, ImageProvider } from "../src/artwork/provider.js";
import { createDefaultArtDirection } from "../src/domain/art-direction.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { emptyStoryBible } from "../src/domain/story-bible.js";
import { Story } from "../src/domain/story.js";
import { LLMProvider } from "../src/llm/provider.js";
import { planStoredScenes } from "../src/scenes/manifest.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { resolveVisualCanonPrompt } from "../src/visual-canon/resolver.js";
import { pngWithDims, testStory } from "./helpers.js";

const PNG_SAMPLE = pngWithDims(1536, 1024);

class SceneLLM implements LLMProvider {
  readonly name = "openai" as const;
  async validateConfiguration() {}
  async generateText() { return { text: "" }; }
  async generateStructured<T>(request: any): Promise<any> {
    return {
      value: request.schema.parse({
        scenes: [
          { summary: "Li Chen draws his sword.", startSeconds: 0, endSeconds: 15, characters: ["Li Chen"], location: "Mount Hua", visualPrompt: "Li Chen standing on the cliff", importance: "major" },
        ],
      }) as T,
    };
  }
}

function fakeImages(providerName = "openai", data: Buffer = PNG_SAMPLE) {
  const calls: ImageGenerationRequest[] = [];
  const provider: ImageProvider & { calls: ImageGenerationRequest[] } = {
    name: providerName,
    version: `fake-${providerName}-v1`,
    calls,
    validateConfiguration: async () => {},
    generate: async (request) => {
      calls.push(request);
      return { data, mimeType: "image/png" as const };
    },
  };
  return provider;
}

async function fixture(artwork?: Partial<Story["artwork"]>) {
  const root = await mkdtemp(join(tmpdir(), "artwork-composition-"));
  const story: Story = { ...testStory(), artwork: { ...testStory().artwork, ...artwork } };
  const paths = storyPaths(root, story.slug, 1);
  const now = new Date().toISOString();
  const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
  const chapter = chapterSchema.parse({
    chapter: 1, originalTitle: "Chapter 1", sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
    counts: { originalCharacters: 50, englishWords: 20, narrationWords: 18 }, createdAt: now, updatedAt: now,
    stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: complete, audioMastering: complete, subtitles: { status: "pending" }, scenePlanning: { status: "pending" }, artwork: { status: "pending" }, video: { status: "pending" } },
    audio: { durationSeconds: 30, codec: "mp3", container: "mp3" },
  });
  await atomicWriteJson(paths.chapterMeta, chapter);
  await atomicWriteJson(paths.storyConfig, story);
  await atomicWrite(paths.narration, "Li Chen drew his longsword at the misty peak.");
  await atomicWrite(paths.audio, Buffer.from("mastered audio bytes"));
  await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });
  return { root, story, paths };
}

describe("central aspect-ratio composition guidance", () => {
  it("provides wide landscape framing and edge crop safety for 16:9", () => {
    const guidance = artworkCompositionGuidance("16:9");
    expect(guidance).toContain("16:9 landscape cinematic frame");
    expect(guidance).toContain("wide landscape canvas");
    expect(guidance).toContain("composition-safe area");
    expect(guidance).toContain("extreme left or right edges");
    expect(guidance).toContain("landscape-safe composition");
    // Must NOT contain resolution numbers or false promises of exact pixel targets
    expect(guidance).not.toContain("2560x1440");
    expect(guidance).not.toContain("1920x1080");
    expect(guidance).not.toContain("1440p");
  });

  it("provides tall vertical framing for 9:16", () => {
    const guidance = artworkCompositionGuidance("9:16");
    expect(guidance).toContain("9:16 portrait frame");
    expect(guidance).toContain("tall vertical canvas");
    expect(guidance).toContain("composition-safe area");
    expect(guidance).toContain("extreme top or bottom edges");
    expect(guidance).toContain("portrait-safe composition");
  });

  it("provides balanced square framing for 1:1", () => {
    const guidance = artworkCompositionGuidance("1:1");
    expect(guidance).toContain("1:1 square frame");
    expect(guidance).toContain("square canvas");
    expect(guidance).toContain("composition-safe area");
    expect(guidance).toContain("square-safe composition");
  });

  it("defaults to 16:9 landscape guidance when unspecified", () => {
    const guidance = artworkCompositionGuidance();
    expect(guidance).toContain("16:9 landscape cinematic frame");
  });

  it("resolves aspect ratio with legacy size fallback support", () => {
    expect(resolveArtworkAspectRatio({ artwork: { aspectRatio: "9:16", size: "1536x1024" } as any })).toBe("9:16");
    expect(resolveArtworkAspectRatio({ artwork: { aspectRatio: "1:1", size: "1536x1024" } as any })).toBe("1:1");
    // When aspectRatio is default 16:9, legacy size 1024x1536 resolves to 9:16
    expect(resolveArtworkAspectRatio({ artwork: { aspectRatio: "16:9", size: "1024x1536" } as any })).toBe("9:16");
    expect(resolveArtworkAspectRatio({ artwork: { aspectRatio: "16:9", size: "1024x1024" } as any })).toBe("1:1");
    expect(resolveArtworkAspectRatio({ artwork: { aspectRatio: "16:9", size: "1536x1024" } as any })).toBe("16:9");
  });
});

describe("Visual Canon prompt integration with aspect ratio", () => {
  const artDirection = createDefaultArtDirection("cinematic manhwa").presets[0]!;
  const bible = emptyStoryBible();
  const scene = {
    id: "scene-001",
    summary: "Li Chen stands on the summit.",
    startSeconds: 0,
    endSeconds: 10,
    characters: ["Li Chen"],
    entityIds: [],
    location: "Summit",
    visualPrompt: "Swordsman atop a misty mountain summit",
    importance: "major" as const,
    artwork: { status: "pending" as const, review: "unreviewed" as const, versions: [] },
  };

  it("embeds 16:9 composition guidance into the resolved visual canon prompt", () => {
    const story: Story = { ...testStory(), artwork: { ...testStory().artwork, aspectRatio: "16:9" } };
    const resolved = resolveVisualCanonPrompt({ scene, story, bible, artDirection, visualProfiles: {} });
    expect(resolved.prompt).toContain("COMPOSITION: 16:9 landscape cinematic frame.");
    expect(resolved.prompt).toContain("wide landscape canvas");
    expect(resolved.prompt).toContain("composition-safe area");
  });

  it("embeds 9:16 portrait composition guidance into the resolved prompt", () => {
    const story: Story = { ...testStory(), artwork: { ...testStory().artwork, aspectRatio: "9:16" } };
    const resolved = resolveVisualCanonPrompt({ scene, story, bible, artDirection, visualProfiles: {} });
    expect(resolved.prompt).toContain("COMPOSITION: 9:16 portrait frame.");
    expect(resolved.prompt).toContain("tall vertical canvas");
    expect(resolved.prompt).toContain("extreme top or bottom edges");
  });

  it("embeds 1:1 square composition guidance into the resolved prompt", () => {
    const story: Story = { ...testStory(), artwork: { ...testStory().artwork, aspectRatio: "1:1" } };
    const resolved = resolveVisualCanonPrompt({ scene, story, bible, artDirection, visualProfiles: {} });
    expect(resolved.prompt).toContain("COMPOSITION: 1:1 square frame.");
    expect(resolved.prompt).toContain("square canvas");
  });
});

describe("provider-neutral aspect ratio composition delivery", () => {
  it("delivers identical composition guidance to both OpenAI and Gemini providers", async () => {
    const { root, story: openAiStory } = await fixture({ provider: "openai", aspectRatio: "16:9" });
    const openAiProvider = fakeImages("openai");
    await generateStoredArtwork({ root, story: openAiStory, chapter: 1, provider: openAiProvider, sceneId: "scene-001" });
    expect(openAiProvider.calls).toHaveLength(1);
    const openAiPrompt = openAiProvider.calls[0]!.prompt;
    expect(openAiPrompt).toContain("COMPOSITION: 16:9 landscape cinematic frame.");

    const { story: geminiStory } = await fixture({ provider: "gemini", model: "gemini-3.1-flash-image", aspectRatio: "16:9" });
    const geminiProvider = fakeImages("gemini");
    await generateStoredArtwork({ root, story: geminiStory, chapter: 1, provider: geminiProvider, sceneId: "scene-001" });
    expect(geminiProvider.calls).toHaveLength(1);
    const geminiPrompt = geminiProvider.calls[0]!.prompt;
    expect(geminiPrompt).toContain("COMPOSITION: 16:9 landscape cinematic frame.");

    // Both providers receive the identical composition block
    expect(openAiPrompt.includes(artworkCompositionGuidance("16:9"))).toBe(true);
    expect(geminiPrompt.includes(artworkCompositionGuidance("16:9"))).toBe(true);
  });
});

describe("fingerprint staleness and resolution separation", () => {
  const scene = {
    id: "scene-001",
    summary: "Li Chen stands on the summit.",
    startSeconds: 0,
    endSeconds: 10,
    characters: ["Li Chen"],
    entityIds: [],
    location: "Summit",
    visualPrompt: "Swordsman atop a misty mountain summit",
    importance: "major" as const,
    artwork: { status: "pending" as const, review: "unreviewed" as const, versions: [] },
  };

  it("changes generation fingerprint when aspect ratio changes (requires new original)", () => {
    const baseStory = testStory();
    const fp16_9 = artworkFingerprint(scene, [], { ...baseStory, artwork: { ...baseStory.artwork, aspectRatio: "16:9" } }, "v1");
    const fp9_16 = artworkFingerprint(scene, [], { ...baseStory, artwork: { ...baseStory.artwork, aspectRatio: "9:16" } }, "v1");
    const fp1_1 = artworkFingerprint(scene, [], { ...baseStory, artwork: { ...baseStory.artwork, aspectRatio: "1:1" } }, "v1");

    expect(fp16_9).not.toBe(fp9_16);
    expect(fp16_9).not.toBe(fp1_1);
    expect(fp9_16).not.toBe(fp1_1);
  });

  it("does NOT change generation fingerprint when final resolution changes (reuses original)", () => {
    const baseStory = testStory();
    const story1080p: Story = { ...baseStory, artwork: { ...baseStory.artwork, outputResolution: "1080p", aspectRatio: "16:9" } };
    const story1440p: Story = { ...baseStory, artwork: { ...baseStory.artwork, outputResolution: "1440p", aspectRatio: "16:9" } };
    const story4K: Story = { ...baseStory, artwork: { ...baseStory.artwork, outputResolution: "2160p", aspectRatio: "16:9" } };

    const fp1080 = artworkFingerprint(scene, [], story1080p, "v1");
    const fp1440 = artworkFingerprint(scene, [], story1440p, "v1");
    const fp4K = artworkFingerprint(scene, [], story4K, "v1");

    expect(fp1080).toBe(fp1440);
    expect(fp1080).toBe(fp4K);
  });
});
