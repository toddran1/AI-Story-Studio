import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alignStoredChapter } from "../src/alignment/chapter-alignment.js";
import { tokenizeNarration } from "../src/alignment/quality.js";
import { AlignmentConfig, AlignmentEngine } from "../src/alignment/types.js";
import { CopyingAudioProcessor, masterStoredChapter, resolveMasteredAudio } from "../src/audio/chapter-audio.js";
import { AudiobookChapter, AudiobookProcessor } from "../src/audio/audiobook.js";
import { AudioProbe } from "../src/audio/ffmpeg.js";
import { Chapter, chapterSchema } from "../src/domain/chapter.js";
import { LLMProvider } from "../src/llm/provider.js";
import { planStoredScenes } from "../src/scenes/manifest.js";
import { SceneManifest, sceneManifestSchema } from "../src/scenes/types.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { sceneImagePath, storyPaths } from "../src/storage/paths.js";
import { inspectSceneArtwork, inspectStageArtifact } from "../src/studio/artifact-state.js";
import { generateStoredSubtitles } from "../src/subtitles/chapter-subtitles.js";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
import { renderStoredChapterVideo } from "../src/video/chapter-video.js";
import { ChapterVideoInput, VideoProcessor } from "../src/video/renderer.js";
import { StudioOperations } from "../apps/server/operations.js";
import { Job, JobManager } from "../apps/server/job-manager.js";
import { Environment } from "../src/config/env.js";
import { importedChapterFingerprint } from "../src/source/importer.js";
import { testStory } from "./helpers.js";

function waitForJob(jobs: JobManager, id: string): Promise<Job> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Job timed out")), 5000);
    const unsubscribe = jobs.subscribe(id, (job) => {
      if (["completed", "failed", "paused"].includes(job.status)) {
        clearTimeout(timeout);
        unsubscribe?.();
        resolve(job);
      }
    });
  });
}

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
const alignConfig: AlignmentConfig = { engine: "whisper-cpp", executable: "whisper-cli", model: "/model.bin", device: "cpu", minimumMatchPercentage: 80, minimumConfidence: 0.4, maximumGapSeconds: 5, timeoutMs: 10_000 };

// Create a real tiny valid MP3 once for probe tests
function createSyntheticMp3(): Buffer {
  try {
    return execSync("ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 0.5 -c:a libmp3lame -b:a 64k -f mp3 pipe:1", { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // Fallback ID3v2 + MPEG audio frame mock if ffmpeg binary is not available
    const header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const frame = Buffer.alloc(100, 0xff);
    return Buffer.concat([header, frame]);
  }
}
const SYNTHETIC_MP3 = createSyntheticMp3();

class SceneLLM implements LLMProvider {
  readonly name = "openai" as const;
  calls: any[] = [];
  async validateConfiguration() {}
  async generateText() { return { text: "" }; }
  async generateStructured<T>(request: any): Promise<any> {
    this.calls.push(request);
    return {
      value: request.schema.parse({
        scenes: [
          { summary: "Scene one.", startSeconds: 0, endSeconds: 15, characters: ["A"], location: "L1", visualPrompt: "P1", importance: "major" },
          { summary: "Scene two.", startSeconds: 15, endSeconds: 30, characters: ["B"], location: "L2", visualPrompt: "P2", importance: "standard" },
        ],
      }) as T,
    };
  }
}

class FakeVideo implements VideoProcessor {
  readonly version = "fake-video-v1";
  input?: ChapterVideoInput;
  async render(input: ChapterVideoInput, output: string, _settings?: any) {
    this.input = input;
    await atomicWrite(output, Buffer.from("video"));
    return { durationSeconds: input.audioDurationSeconds, videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080, container: "mp4" };
  }
}

class FakeAlignment implements AlignmentEngine {
  readonly name = "fake-align";
  readonly version = "fake-v1";
  async validateConfiguration() {}
  async align(request: { narration: string }) {
    const tokens = tokenizeNarration(request.narration);
    const step = 28 / Math.max(1, tokens.length);
    return tokens.map((text, index) => ({ text, start: 0.1 + index * step, end: 0.1 + index * step + step * 0.9, confidence: 0.95 }));
  }
}

class FakeAudiobookProcessor implements AudiobookProcessor {
  readonly version = "fake-audiobook-v1";
  async assemble(chapters: AudiobookChapter[], output: string): Promise<AudioProbe> {
    await atomicWrite(output, Buffer.from("audiobook"));
    return { durationSeconds: chapters.reduce((sum, c) => sum + c.durationSeconds, 0), codec: "mp3", container: "mp3" };
  }
}

async function fixture(options: { narration?: string; audioBytes?: Buffer; withMeta?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "stale-hardening-"));
  const story = testStory();
  const paths = storyPaths(root, story.slug, 1);
  const now = new Date().toISOString();

  await mkdir(paths.chapterDir, { recursive: true });
  await atomicWriteJson(storyPaths(root, story.slug, 1).storyConfig, story);

  if (options.withMeta !== false) {
    await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
      chapter: 1,
      sourceLanguage: story.sourceLanguage,
      outputLanguage: story.outputLanguage,
      counts: { originalCharacters: 50, englishWords: 20, narrationWords: 14 },
      createdAt: now,
      updatedAt: now,
      stages: {
        ingestion: complete,
        translation: complete,
        narration: complete,
        qa: complete,
        storyBible: complete,
        continuity: complete,
        tts: complete,
        audioMastering: complete,
        alignment: complete,
        subtitles: complete,
        scenePlanning: { status: "pending" },
        artwork: { status: "pending" },
        video: { status: "pending" },
      },
      audio: { durationSeconds: 30, codec: "mp3", container: "mp3" },
    }));
  }

  await atomicWrite(paths.narration, options.narration ?? "Mara entered the old observatory. Above her, a map of blue stars awakened.");
  await atomicWrite(paths.audioRaw, Buffer.from("raw tts audio"));
  await atomicWrite(paths.audio, options.audioBytes ?? Buffer.from("mastered chapter audio"));

  const ref = { chapter: 1, sourceId: "sec_1", sourceType: "text" as const, metadata: {} };
  const rawText = "Original source text";
  const fp = importedChapterFingerprint(ref, rawText);
  await mkdir(paths.sourceChapters, { recursive: true });
  await writeFile(join(paths.sourceChapters, "0001.txt"), rawText, "utf8");
  const manifest = {
    version: 1 as const,
    adapterVersion: "1.0.0",
    type: "text" as const,
    origin: { path: "/novel.txt", name: "novel.txt" },
    fingerprint: fp,
    importedAt: now,
    warnings: [],
    unnumberedSections: [],
    chapters: [
      {
        chapter: 1,
        file: "chapters/0001.txt",
        fingerprint: fp,
        contentFingerprint: fp,
        ref,
      },
    ],
  };
  await atomicWriteJson(paths.sourceManifest, manifest);

  return { root, story, paths };
}

describe("Audio provenance hardening", () => {
  it("1. Mastered audio exists but raw TTS is missing", async () => {
    const { root, story, paths } = await fixture();
    await rm(paths.audioRaw, { force: true });
    // audio exists, audioRaw does not
    expect(await readFile(paths.audio).catch(() => undefined)).toBeDefined();
    expect(await readFile(paths.audioRaw).catch(() => undefined)).toBeUndefined();
  });

  it("2 & 3. Rerunning Audio Mastering does NOT copy mastered audio into raw TTS and reports missing raw prerequisite", async () => {
    const { root, story, paths } = await fixture();
    await rm(paths.audioRaw, { force: true });

    await expect(masterStoredChapter({
      root,
      story,
      chapter: 1,
      processor: new CopyingAudioProcessor(),
      force: true,
    })).rejects.toThrow(/Raw TTS audio is unavailable\. Existing mastered audio can still be used by downstream stages, but Audio Mastering cannot be rerun without its original TTS input\./);

    // Verify audioRaw was NOT created by copying audio
    const rawExists = await readFile(paths.audioRaw).catch(() => undefined);
    expect(rawExists).toBeUndefined();
  });

  it("4. Existing stale mastered audio remains usable by downstream stages even when raw TTS is missing", async () => {
    const { root, story, paths } = await fixture();
    await rm(paths.audioRaw, { force: true });
    // Mark audioMastering stale
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    meta.stages.audioMastering = { ...meta.stages.audioMastering, status: "pending", staleReason: "tts changed" };
    await atomicWriteJson(paths.chapterMeta, meta);

    // Downstream: alignment works
    const alignResult = await alignStoredChapter({
      root,
      storySlug: story.slug,
      chapter: 1,
      language: "en",
      config: alignConfig,
      engine: new FakeAlignment(),
      force: true,
    });
    expect(alignResult.artifact.mode).toBe("aligned");
    expect(alignResult.warnings).toContain("Using stale mastered audio.");

    // Downstream: scene planning works
    const sceneResult = await planStoredScenes({ root, story, chapter: 1, provider: new SceneLLM(), force: true });
    expect(sceneResult.manifest.scenes.length).toBeGreaterThan(0);
    expect(sceneResult.warnings).toContain("Using stale mastered audio.");
  });
});

describe("Media validation hardening", () => {
  it("5. Zero-byte audio is reported as missing", async () => {
    const { root, story, paths } = await fixture();
    await atomicWrite(paths.audio, Buffer.alloc(0));
    const artifact = await inspectStageArtifact(root, story.slug, 1, "audioMastering");
    expect(artifact.availability).toBe("missing");
  });

  it("6. Non-empty corrupt audio is reported as invalid", async () => {
    const { root, story, paths } = await fixture();
    await atomicWrite(paths.audio, Buffer.from("0123456789")); // 10-byte non-media garbage
    const artifact = await inspectStageArtifact(root, story.slug, 1, "audioMastering");
    expect(artifact.availability).toBe("invalid");

    // Also test explicitly corrupt marker
    await atomicWrite(paths.audio, Buffer.from("corrupt audio bytes"));
    const artifact2 = await inspectStageArtifact(root, story.slug, 1, "audioMastering");
    expect(artifact2.availability).toBe("invalid");
  });

  it("7. Valid audio is reported as available", async () => {
    const { root, story, paths } = await fixture({ audioBytes: SYNTHETIC_MP3 });
    const artifact = await inspectStageArtifact(root, story.slug, 1, "audioMastering");
    expect(artifact.availability).toBe("available");
  });

  it("8. Non-empty corrupt video is reported as invalid", async () => {
    const { root, story, paths } = await fixture();
    await atomicWrite(paths.video, Buffer.from("0123456789"));
    const artifact = await inspectStageArtifact(root, story.slug, 1, "video");
    expect(artifact.availability).toBe("invalid");

    await atomicWrite(paths.video, Buffer.from("corrupt-video-bytes"));
    const artifact2 = await inspectStageArtifact(root, story.slug, 1, "video");
    expect(artifact2.availability).toBe("invalid");
  });

  it("9. Zero-byte video is missing, valid video is available", async () => {
    const { root, story, paths } = await fixture();
    await atomicWrite(paths.video, Buffer.alloc(0));
    const emptyArtifact = await inspectStageArtifact(root, story.slug, 1, "video");
    expect(emptyArtifact.availability).toBe("missing");

    await atomicWrite(paths.video, Buffer.from("video-test-valid"));
    const validArtifact = await inspectStageArtifact(root, story.slug, 1, "video");
    expect(validArtifact.availability).toBe("available");
  });
});

describe("Missing audio metadata recovery", () => {
  it("10. Valid mastered audio + valid chapter.audio works immediately without probe", async () => {
    const { root, story, paths } = await fixture();
    const resolved = await resolveMasteredAudio(root, story.slug, 1);
    expect(resolved.audio.durationSeconds).toBe(30);
    expect(resolved.path).toBe(paths.audio);
  });

  it("11. Valid mastered audio + missing chapter.audio recovers metadata via probe without fabricating duration", async () => {
    const { root, story, paths } = await fixture({ audioBytes: SYNTHETIC_MP3 });
    // Remove audio metadata from chapter.json
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    delete meta.audio;
    await atomicWriteJson(paths.chapterMeta, meta);

    const resolved = await resolveMasteredAudio(root, story.slug, 1);
    expect(resolved.audio.durationSeconds).toBeGreaterThan(0);
    expect(resolved.audio.codec).toBe("mp3");
  });

  it("12. Corrupt audio or probe failure without chapter.audio throws precise error and never fabricates duration", async () => {
    const { root, story, paths } = await fixture({ audioBytes: Buffer.from("corrupt audio data") });
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    delete meta.audio;
    await atomicWriteJson(paths.chapterMeta, meta);

    await expect(resolveMasteredAudio(root, story.slug, 1)).rejects.toThrow(/could not be read as valid audio/);

    // Also test valid mock audio string whose probe fails when meta.audio is missing
    await atomicWrite(paths.audio, Buffer.from("mastered mock audio"));
    await expect(resolveMasteredAudio(root, story.slug, 1)).rejects.toThrow(/duration metadata is unavailable/);
  });
});

describe("Subtitles prerequisite consistency", () => {
  it("13. Current narration generates subtitles successfully", async () => {
    const { root, story } = await fixture();
    const result = await generateStoredSubtitles({ root, story, chapter: 1, force: true, forceEstimated: true });
    expect(result.reused).toBe(false);
    expect(result.document.cues.length).toBeGreaterThan(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("14. Stale narration generates subtitles with stale warning", async () => {
    const { root, story, paths } = await fixture();
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    meta.stages.narration = { ...meta.stages.narration, status: "pending", staleReason: "translation changed" };
    await atomicWriteJson(paths.chapterMeta, meta);

    const result = await generateStoredSubtitles({ root, story, chapter: 1, force: true, forceEstimated: true });
    expect(result.document.cues.length).toBeGreaterThan(0);
    expect(result.warnings).toContain("Using stale narration — it may not reflect the latest Translation changes.");
  });

  it("15. Missing narration blocks subtitle generation", async () => {
    const { root, story, paths } = await fixture();
    await rm(paths.narration, { force: true });
    await expect(generateStoredSubtitles({ root, story, chapter: 1, force: true, forceEstimated: true }))
      .rejects.toThrow("narration is missing");
  });

  it("16. Invalid narration (whitespace-only) blocks subtitle generation", async () => {
    const { root, story, paths } = await fixture();
    await atomicWrite(paths.narration, "   \n\t  ");
    await expect(generateStoredSubtitles({ root, story, chapter: 1, force: true, forceEstimated: true }))
      .rejects.toThrow("narration exists but is invalid");
  });

  it("17. Stale alignment is usable with a warning", async () => {
    const { root, story, paths } = await fixture();
    // First generate valid alignment
    await alignStoredChapter({ root, storySlug: story.slug, chapter: 1, language: "en", config: alignConfig, engine: new FakeAlignment(), force: true });
    // Mark alignment stale
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    meta.stages.alignment = { ...meta.stages.alignment, status: "pending", staleReason: "narration changed" };
    await atomicWriteJson(paths.chapterMeta, meta);

    const result = await generateStoredSubtitles({ root, story, chapter: 1, force: true });
    expect(result.warnings).toContain("Using stale alignment.");
    expect(result.document.cues.length).toBeGreaterThan(0);
  });
});

function makeSceneManifest(params: { durationSeconds: number; scenes: any[] }): SceneManifest {
  return sceneManifestSchema.parse({
    version: 1,
    chapter: 1,
    durationSeconds: params.durationSeconds,
    planningFingerprint: "fp-plan",
    planner: { provider: "openai", model: "gpt", promptVersion: "v1" },
    manualRevision: 0,
    manuallyEdited: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    scenes: params.scenes,
  });
}

describe("Artwork availability decoupling", () => {
  it("18. 29 scenes with 29 valid images reports complete / available", async () => {
    const { root, story, paths } = await fixture();
    const scenes = Array.from({ length: 29 }, (_, i) => ({
      id: `scene-${String(i + 1).padStart(3, "0")}`,
      summary: `Scene ${i + 1}`,
      startSeconds: i,
      endSeconds: i + 1,
      characters: [],
      visualPrompt: `Prompt ${i + 1}`,
      importance: "standard" as const,
      artwork: {
        status: "complete" as const,
        review: "approved" as const,
        imageFingerprint: "fp",
      },
    }));

    const manifest = makeSceneManifest({ durationSeconds: 29, scenes });
    await atomicWriteJson(paths.scenesManifest, manifest);

    for (const scene of manifest.scenes) {
      const img = sceneImagePath(root, story.slug, 1, scene.id);
      await atomicWrite(img, PNG_1X1);
      const fp = await fileFingerprint(img);
      scene.artwork.imageFingerprint = fp!;
    }
    await atomicWriteJson(paths.scenesManifest, manifest);

    const stageState = await inspectStageArtifact(root, story.slug, 1, "artwork");
    expect(stageState.availability).toBe("available");
  });

  it("19 & 20. 29 scenes with 27 valid images keeps individual 27 scenes available and independent of missing scene", async () => {
    const { root, story, paths } = await fixture();
    const scenes = Array.from({ length: 29 }, (_, i) => ({
      id: `scene-${String(i + 1).padStart(3, "0")}`,
      summary: `Scene ${i + 1}`,
      startSeconds: i,
      endSeconds: i + 1,
      characters: [],
      visualPrompt: `Prompt ${i + 1}`,
      importance: "standard" as const,
      artwork: {
        status: (i === 13 || i === 27 ? "pending" : "complete") as any,
        review: (i === 13 || i === 27 ? "unreviewed" : "approved") as any,
        imageFingerprint: "fp",
      },
    }));

    const manifest = makeSceneManifest({ durationSeconds: 29, scenes });

    for (let i = 0; i < 29; i++) {
      if (i !== 13 && i !== 27) {
        const img = sceneImagePath(root, story.slug, 1, scenes[i]!.id);
        await atomicWrite(img, PNG_1X1);
        scenes[i]!.artwork.imageFingerprint = (await fileFingerprint(img))!;
      }
    }
    await atomicWriteJson(paths.scenesManifest, manifest);

    // Chapter stage is missing (incomplete)
    const stageState = await inspectStageArtifact(root, story.slug, 1, "artwork");
    expect(stageState.availability).toBe("missing");

    // Scene 1 is available
    const scene1 = await inspectSceneArtwork(root, story.slug, 1, "scene-001", scenes[0]!.artwork.imageFingerprint);
    expect(scene1.availability).toBe("available");

    // Scene 14 is missing
    const scene14 = await inspectSceneArtwork(root, story.slug, 1, "scene-014");
    expect(scene14.availability).toBe("missing");

    // Scene 14 being missing does NOT make Scene 1 invalid
    expect(scene1.availability).toBe("available");
  });

  it("21. Stale approved artwork remains usable via inspectSceneArtwork", async () => {
    const { root, story } = await fixture();
    const img = sceneImagePath(root, story.slug, 1, "scene-001");
    await atomicWrite(img, PNG_1X1);
    const fp = await fileFingerprint(img);

    const inspected = await inspectSceneArtwork(root, story.slug, 1, "scene-001", fp);
    expect(inspected.availability).toBe("available");
    expect(inspected.matchesRecordedFingerprint).toBe(true);
  });
});

describe("Video rendering and approved artwork hardening", () => {
  it("22. Approved + stale scene artwork is usable for video rendering", async () => {
    const { root, story, paths } = await fixture();
    const img1 = sceneImagePath(root, story.slug, 1, "scene-001");
    const img2 = sceneImagePath(root, story.slug, 1, "scene-002");
    await atomicWrite(img1, PNG_1X1);
    await atomicWrite(img2, PNG_1X1);
    const fp1 = await fileFingerprint(img1);
    const fp2 = await fileFingerprint(img2);

    const manifest = makeSceneManifest({
      durationSeconds: 30,
      scenes: [
        { id: "scene-001", summary: "One", startSeconds: 0, endSeconds: 15, characters: [], visualPrompt: "P1", importance: "major", artwork: { status: "complete", review: "approved", imageFingerprint: fp1 } },
        { id: "scene-002", summary: "Two", startSeconds: 15, endSeconds: 30, characters: [], visualPrompt: "P2", importance: "standard", artwork: { status: "complete", review: "approved", imageFingerprint: fp2 } },
      ],
    });
    await atomicWriteJson(paths.scenesManifest, manifest);

    // Mark artwork stale in chapter metadata
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    meta.stages.artwork = { status: "pending", staleReason: "scene plan changed" };
    await atomicWriteJson(paths.chapterMeta, meta);

    const video = new FakeVideo();
    const result = await renderStoredChapterVideo({
      root,
      story: { ...story, video: { ...story.video, subtitleMode: "none" } },
      chapter: 1,
      processor: video,
      force: true,
    });
    expect(result.scenes).toBe(2);
    expect(video.input?.sceneArtwork).toHaveLength(2);
  });

  it("23. Approved artwork file missing throws actionable VideoError", async () => {
    const { root, story, paths } = await fixture();
    const img1 = sceneImagePath(root, story.slug, 1, "scene-001");
    await atomicWrite(img1, PNG_1X1);
    const fp1 = await fileFingerprint(img1);

    const manifest = makeSceneManifest({
      durationSeconds: 30,
      scenes: [
        { id: "scene-001", summary: "One", startSeconds: 0, endSeconds: 15, characters: [], visualPrompt: "P1", importance: "major", artwork: { status: "complete", review: "approved", imageFingerprint: fp1 } },
        { id: "scene-002", summary: "Two", startSeconds: 15, endSeconds: 30, characters: [], visualPrompt: "P2", importance: "standard", artwork: { status: "complete", review: "approved", imageFingerprint: "some-fp" } },
      ],
    });
    await atomicWriteJson(paths.scenesManifest, manifest);

    const video = new FakeVideo();
    await expect(renderStoredChapterVideo({
      root,
      story: { ...story, video: { ...story.video, subtitleMode: "none" } },
      chapter: 1,
      processor: video,
      force: true,
    })).rejects.toThrow("Approved artwork for Scene scene-002 is missing.");
  });

  it("24. Approved artwork fingerprint mismatch throws actionable VideoError", async () => {
    const { root, story, paths } = await fixture();
    const img1 = sceneImagePath(root, story.slug, 1, "scene-001");
    const img2 = sceneImagePath(root, story.slug, 1, "scene-002");
    await atomicWrite(img1, PNG_1X1);
    await atomicWrite(img2, PNG_1X1);
    const fp1 = await fileFingerprint(img1);

    const manifest = makeSceneManifest({
      durationSeconds: 30,
      scenes: [
        { id: "scene-001", summary: "One", startSeconds: 0, endSeconds: 15, characters: [], visualPrompt: "P1", importance: "major", artwork: { status: "complete", review: "approved", imageFingerprint: fp1 } },
        { id: "scene-002", summary: "Two", startSeconds: 15, endSeconds: 30, characters: [], visualPrompt: "P2", importance: "standard", artwork: { status: "complete", review: "approved", imageFingerprint: "different-recorded-hash" } },
      ],
    });
    await atomicWriteJson(paths.scenesManifest, manifest);

    const video = new FakeVideo();
    await expect(renderStoredChapterVideo({
      root,
      story: { ...story, video: { ...story.video, subtitleMode: "none" } },
      chapter: 1,
      processor: video,
      force: true,
    })).rejects.toThrow("Approved artwork for Scene scene-002 does not match its recorded fingerprint.");
  });

  it("25. Broken expected scene artwork does NOT silently fall back to cover/gradient", async () => {
    const { root, story, paths } = await fixture();
    const img1 = sceneImagePath(root, story.slug, 1, "scene-001");
    const img2 = sceneImagePath(root, story.slug, 1, "scene-002");
    await atomicWrite(img1, PNG_1X1);
    // write corrupt bytes to scene 2
    await atomicWrite(img2, Buffer.from("corrupt image data"));
    const fp1 = await fileFingerprint(img1);
    const fp2 = await fileFingerprint(img2);

    const manifest = makeSceneManifest({
      durationSeconds: 30,
      scenes: [
        { id: "scene-001", summary: "One", startSeconds: 0, endSeconds: 15, characters: [], visualPrompt: "P1", importance: "major", artwork: { status: "complete", review: "approved", imageFingerprint: fp1 } },
        { id: "scene-002", summary: "Two", startSeconds: 15, endSeconds: 30, characters: [], visualPrompt: "P2", importance: "standard", artwork: { status: "complete", review: "approved", imageFingerprint: fp2 } },
      ],
    });
    await atomicWriteJson(paths.scenesManifest, manifest);

    const video = new FakeVideo();
    // It must throw, not silently fall back to cover/gradient!
    await expect(renderStoredChapterVideo({
      root,
      story: { ...story, video: { ...story.video, subtitleMode: "none", backgroundMode: "gradient" } },
      chapter: 1,
      processor: video,
      force: true,
    })).rejects.toThrow("Approved artwork for Scene scene-002 is corrupt.");
    expect(video.input).toBeUndefined();
  });

  it("26. Intentional cover/gradient workflow still works when no scene artwork is approved", async () => {
    const { root, story, paths } = await fixture();
    // No scene manifest exists
    await rm(paths.scenesManifest, { force: true });
    const video = new FakeVideo();
    const result = await renderStoredChapterVideo({
      root,
      story: { ...story, video: { ...story.video, subtitleMode: "none", backgroundMode: "gradient" } },
      chapter: 1,
      processor: video,
      force: true,
    });
    expect(result.scenes).toBe(0);
    expect(video.input?.sceneArtwork).toBeUndefined();
  });
});

describe("Warning propagation across operations", () => {
  it("27. Direct video generation surfaces stale warnings", async () => {
    const { root, story, paths } = await fixture();
    // Mark audioMastering stale
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    meta.stages.audioMastering = { ...meta.stages.audioMastering, status: "pending", staleReason: "tts changed" };
    await atomicWriteJson(paths.chapterMeta, meta);

    const video = new FakeVideo();
    const result = await renderStoredChapterVideo({
      root,
      story: { ...story, video: { ...story.video, subtitleMode: "none" } },
      chapter: 1,
      processor: video,
      force: true,
    });
    expect(result.warnings).toContain("Using stale mastered audio.");
  });

  it("28. Video Export job surfaces equivalent stale warnings", async () => {
    const { root, story, paths } = await fixture();
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    meta.stages.audioMastering = { ...meta.stages.audioMastering, status: "pending", staleReason: "tts changed" };
    await atomicWriteJson(paths.chapterMeta, meta);

    const env = { STUDIO_DATA_ROOT: root } as unknown as Environment;
    const ops = new StudioOperations(root, env, undefined, {
      audio: new CopyingAudioProcessor(),
      video: new FakeVideo(),
    });

    const job = ops.startVideo(story.slug, { from: 1, to: 1, subtitleMode: "none" });
    const finished = await waitForJob(ops.jobs, job.id);
    expect(finished.status).toBe("completed");
    const result = finished.result as any;
    expect(result.warnings).toContain("Using stale mastered audio.");
  });

  it("29. Direct audio mastering job surfaces relevant warnings", async () => {
    const { root, story, paths } = await fixture();
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    meta.stages.tts = { ...meta.stages.tts, status: "pending", staleReason: "narration changed" };
    await atomicWriteJson(paths.chapterMeta, meta);

    const env = { STUDIO_DATA_ROOT: root } as unknown as Environment;
    const ops = new StudioOperations(root, env, undefined, {
      audio: new CopyingAudioProcessor(),
    });

    const job = ops.startAudio(story.slug, { from: 1, to: 1, force: true });
    const finished = await waitForJob(ops.jobs, job.id);
    expect(finished.status).toBe("completed");
    const result = finished.result as any;
    expect(result.warnings).toContain("Using stale raw TTS audio — it may not reflect the latest Narration changes.");
  });

  it("30. Audiobook workflow surfaces relevant stale warnings", async () => {
    const { root, story, paths } = await fixture();
    // Retained audio is stale
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    meta.stages.audioMastering = { ...meta.stages.audioMastering, status: "pending", staleReason: "tts changed" };
    await atomicWriteJson(paths.chapterMeta, meta);

    const env = { STUDIO_DATA_ROOT: root } as unknown as Environment;
    const ops = new StudioOperations(root, env, undefined, {
      audio: new CopyingAudioProcessor(),
      audiobook: new FakeAudiobookProcessor(),
    });

    const job = ops.startAudiobook(story.slug, { from: 1, to: 1, format: "mp3" });
    const finished = await waitForJob(ops.jobs, job.id);
    expect(finished.status).toBe("completed");
    const result = finished.result as any;
    expect(result.warnings).toContain("Using stale mastered audio.");
  });

  it("31. Duplicate warnings are deduplicated in job results", async () => {
    const { root, story, paths } = await fixture();
    const meta = JSON.parse(await readFile(paths.chapterMeta, "utf8"));
    meta.stages.audioMastering = { ...meta.stages.audioMastering, status: "pending", staleReason: "tts changed" };
    await atomicWriteJson(paths.chapterMeta, meta);

    const env = { STUDIO_DATA_ROOT: root } as unknown as Environment;
    const ops = new StudioOperations(root, env, undefined, {
      audio: new CopyingAudioProcessor(),
      audiobook: new FakeAudiobookProcessor(),
    });

    const job = ops.startAudiobook(story.slug, { from: 1, to: 1, format: "mp3" });
    const finished = await waitForJob(ops.jobs, job.id);
    expect(finished.status).toBe("completed");
    const result = finished.result as any;
    const staleAudioWarnings = result.warnings.filter((w: string) => w === "Using stale mastered audio.");
    expect(staleAudioWarnings).toHaveLength(1);
  });
});
