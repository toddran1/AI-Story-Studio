import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateStoredArtwork, reviewStoredArtwork, reviewStoredArtworkVersion } from "../src/artwork/generator.js";
import { ImageProvider } from "../src/artwork/provider.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { LLMProvider } from "../src/llm/provider.js";
import { planStoredScenes } from "../src/scenes/manifest.js";
import { SceneManifest, sceneManifestSchema } from "../src/scenes/types.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { sceneImagePath, sceneVersionImagePath, storyPaths } from "../src/storage/paths.js";
import { testStory } from "./helpers.js";

// Valid 1x1 PNG bytes
const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const PNG_B = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEfQHzx5tC9AAAAABJRU5ErkJggg==", "base64");

class SceneLLM implements LLMProvider {
  readonly name = "openai" as const;
  async validateConfiguration() {}
  async generateText() {
    return { text: "" };
  }
  async generateStructured<T>(request: any): Promise<any> {
    return {
      value: request.schema.parse({
        scenes: [
          {
            summary: "Mara enters the observatory.",
            startSeconds: 0,
            endSeconds: 15,
            characters: ["Mara"],
            location: "Old Observatory",
            visualPrompt: "Mara standing beneath the brass telescope",
            importance: "major",
          },
          {
            summary: "The blue star map ignites.",
            startSeconds: 15,
            endSeconds: 30,
            characters: ["Mara"],
            location: "Old Observatory",
            visualPrompt: "Constellations glowing in deep blue",
            importance: "standard",
          },
        ],
      }) as T,
    };
  }
}

class VersionedFakeImages implements ImageProvider {
  readonly name = "openai";
  readonly version = "fake-images-v1";
  calls: any[] = [];
  imageBytes = PNG_A;

  async validateConfiguration() {}
  async generate(request: any) {
    this.calls.push(request);
    return { data: this.imageBytes, mimeType: "image/png" as const };
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "artwork-versions-"));
  const story = testStory();
  const paths = storyPaths(root, story.slug, 1);
  const now = new Date().toISOString();
  const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };

  const chapter = chapterSchema.parse({
    chapter: 1,
    originalTitle: "The Observatory",
    sourceLanguage: story.sourceLanguage,
    outputLanguage: story.outputLanguage,
    counts: { originalCharacters: 50, englishWords: 20, narrationWords: 18 },
    createdAt: now,
    updatedAt: now,
    stages: {
      ingestion: complete,
      translation: complete,
      narration: complete,
      qa: complete,
      storyBible: complete,
      tts: complete,
      audioMastering: complete,
      subtitles: { status: "pending" },
      scenePlanning: { status: "pending" },
      artwork: { status: "pending" },
      video: { status: "complete", fingerprint: "v1-video" },
    },
    audio: { durationSeconds: 30, codec: "mp3", container: "mp3" },
  });

  await atomicWriteJson(paths.chapterMeta, chapter);
  await atomicWrite(paths.narration, "Mara entered the old observatory.");
  await atomicWrite(paths.audio, Buffer.from("mastered"));

  return { root, story, paths };
}

describe("Artwork Multi-Version Management", () => {
  it("creates Version 1 on initial generation and writes versioned image file", async () => {
    const { root, story, paths } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });

    const images = new VersionedFakeImages();
    const result = await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });

    expect(result.generated).toBe(1);

    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    const scene = manifest.scenes.find((s) => s.id === "scene-001")!;

    expect(scene.artwork.status).toBe("complete");
    expect(scene.artwork.versions).toHaveLength(1);

    const v1 = scene.artwork.versions[0]!;
    expect(v1.id).toBe("v1");
    expect(v1.versionNumber).toBe(1);
    expect(v1.review).toBe("unreviewed");

    // File scene-001-v1.png exists on disk
    const v1Path = sceneVersionImagePath(root, story.slug, 1, "scene-001", 1);
    const v1Stats = await stat(v1Path);
    expect(v1Stats.size).toBeGreaterThan(0);

    // Standard scene-001.png exists for preview
    const standardPath = sceneImagePath(root, story.slug, 1, "scene-001");
    const stdStats = await stat(standardPath);
    expect(stdStats.size).toBeGreaterThan(0);
  });

  it("creates Version 2 on forced regeneration without overwriting Version 1", async () => {
    const { root, story, paths } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });

    const images = new VersionedFakeImages();
    images.imageBytes = PNG_A;
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });

    // Regenerate with different image bytes
    images.imageBytes = PNG_B;
    const regen = await generateStoredArtwork({
      root,
      story,
      chapter: 1,
      provider: images,
      sceneId: "scene-001",
      force: true,
    });

    expect(regen.generated).toBe(1);

    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    const scene = manifest.scenes.find((s) => s.id === "scene-001")!;

    expect(scene.artwork.versions).toHaveLength(2);
    expect(scene.artwork.versions[0]!.id).toBe("v1");
    expect(scene.artwork.versions[0]!.versionNumber).toBe(1);
    expect(scene.artwork.versions[1]!.id).toBe("v2");
    expect(scene.artwork.versions[1]!.versionNumber).toBe(2);

    // Both files exist on disk with their respective contents
    const v1Path = sceneVersionImagePath(root, story.slug, 1, "scene-001", 1);
    const v2Path = sceneVersionImagePath(root, story.slug, 1, "scene-001", 2);

    const v1Bytes = await readFile(v1Path);
    const v2Bytes = await readFile(v2Path);

    expect(v1Bytes).toEqual(PNG_A);
    expect(v2Bytes).toEqual(PNG_B);
  });

  it("approves a specific version, syncs it to standard scene path, and invalidates downstream video", async () => {
    const { root, story, paths } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });

    const images = new VersionedFakeImages();
    images.imageBytes = PNG_A;
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });

    images.imageBytes = PNG_B;
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001", force: true });

    // Approve version 2
    await reviewStoredArtworkVersion({
      root,
      story,
      chapter: 1,
      sceneId: "scene-001",
      versionId: "v2",
      review: "approved",
    });

    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    const scene = manifest.scenes.find((s) => s.id === "scene-001")!;

    expect(scene.artwork.approvedVersionId).toBe("v2");
    expect(scene.artwork.review).toBe("approved");
    expect(scene.artwork.versions[0]!.review).toBe("unreviewed");
    expect(scene.artwork.versions[1]!.review).toBe("approved");

    // Standard scene-001.png now contains v2 bytes
    const standardPath = sceneImagePath(root, story.slug, 1, "scene-001");
    const stdBytes = await readFile(standardPath);
    expect(stdBytes).toEqual(PNG_B);

    // Downstream video stage was invalidated to pending
    const chapter = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    expect(chapter.stages.video.status).toBe("pending");
  });

  it("switches approved version back to version 1 and updates standard scene image", async () => {
    const { root, story, paths } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });

    const images = new VersionedFakeImages();
    images.imageBytes = PNG_A;
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });

    images.imageBytes = PNG_B;
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001", force: true });

    // Approve v2 first
    await reviewStoredArtworkVersion({
      root,
      story,
      chapter: 1,
      sceneId: "scene-001",
      versionId: "v2",
      review: "approved",
    });

    // Switch approval to v1
    await reviewStoredArtworkVersion({
      root,
      story,
      chapter: 1,
      sceneId: "scene-001",
      versionId: "v1",
      review: "approved",
    });

    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    const scene = manifest.scenes.find((s) => s.id === "scene-001")!;

    expect(scene.artwork.approvedVersionId).toBe("v1");
    expect(scene.artwork.versions[0]!.review).toBe("approved");
    expect(scene.artwork.versions[1]!.review).toBe("unreviewed");

    // Standard scene-001.png now has v1 bytes
    const standardPath = sceneImagePath(root, story.slug, 1, "scene-001");
    const stdBytes = await readFile(standardPath);
    expect(stdBytes).toEqual(PNG_A);
  });

  it("reviewStoredArtwork without explicit version approves the latest version", async () => {
    const { root, story, paths } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });

    const images = new VersionedFakeImages();
    images.imageBytes = PNG_A;
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });

    images.imageBytes = PNG_B;
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001", force: true });

    // Use reviewStoredArtwork (the general API) with review: "approved"
    await reviewStoredArtwork({
      root,
      story,
      chapter: 1,
      sceneId: "scene-001",
      review: "approved",
    });

    const manifest = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    const scene = manifest.scenes.find((s) => s.id === "scene-001")!;

    expect(scene.artwork.approvedVersionId).toBe("v2");
    expect(scene.artwork.review).toBe("approved");
  });

  it("rejects approval if version image file is corrupted or tampered", async () => {
    const { root, story } = await fixture();
    await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM() });

    const images = new VersionedFakeImages();
    await generateStoredArtwork({ root, story, chapter: 1, provider: images, sceneId: "scene-001" });

    // Tamper with the v1 image file
    const v1Path = sceneVersionImagePath(root, story.slug, 1, "scene-001", 1);
    await atomicWrite(v1Path, Buffer.from("corrupted not png"));

    await expect(
      reviewStoredArtworkVersion({
        root,
        story,
        chapter: 1,
        sceneId: "scene-001",
        versionId: "v1",
        review: "approved",
      })
    ).rejects.toThrow("intact");
  });
});

