import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleAudiobook, audiobookMetadata, AudiobookChapter, AudiobookMetadata, AudiobookProcessor, buildAudiobookArgs, buildFfmetadata, selectExportChapters } from "../src/audio/audiobook.js";
import { audioMasteringFingerprint, masterStoredChapter } from "../src/audio/chapter-audio.js";
import { AudioSettings } from "../src/audio/config.js";
import { AudioProbe, CommandRunner, FfmpegTools, runCommand } from "../src/audio/ffmpeg.js";
import { AudioMasteringProcessor, buildMasteringPlan, validateMasteredAudio } from "../src/audio/mastering.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { testStory } from "./helpers.js";
import { fingerprint } from "../src/utils/hash.js";

class RecordingMaster implements AudioMasteringProcessor {
  readonly version = "recording-master-v1"; calls = 0;
  async master(inputs: string[], output: string, _settings: AudioSettings) { this.calls++; expect(inputs.length).toBeGreaterThan(0); await atomicWrite(output, Buffer.from(`master-${this.calls}`)); return { durationSeconds: 12, codec: "mp3", container: "mp3" }; }
}
class RecordingBook implements AudiobookProcessor {
  readonly version = "recording-book-v1"; calls = 0; chapters: number[] = []; metadata?: AudiobookMetadata;
  async assemble(chapters: AudiobookChapter[], output: string, format: "mp3" | "m4b", _settings: AudioSettings, metadata: AudiobookMetadata): Promise<AudioProbe> { this.calls++; this.chapters = chapters.map((item) => item.chapter); this.metadata = metadata; await atomicWrite(output, Buffer.from(`book-${format}-${this.calls}`)); return { durationSeconds: 25.5, codec: format === "m4b" ? "aac" : "mp3", container: format === "m4b" ? "mov,mp4,m4a" : "mp3" }; }
}

async function masteredFixture(numbers = [1]) {
  const root = await mkdtemp(join(tmpdir(), "story-audio-")); const story = testStory(); const complete = { status: "complete" as const, fingerprint: "input", outputFingerprint: "output" };
  for (const chapter of numbers) {
    const paths = storyPaths(root, story.slug, chapter); const now = new Date().toISOString();
    const metadata = chapterSchema.parse({ chapter, originalTitle: `Original ${chapter}`, translatedTitle: `Translated ${chapter}`, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
      counts: { originalCharacters: 1, englishWords: 1, narrationWords: 1 }, createdAt: now, updatedAt: now,
      stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: complete, tts: { ...complete, outputFingerprint: `tts-${chapter}` }, audioMastering: { ...complete, fingerprint: `master-in-${chapter}`, outputFingerprint: fingerprint(Buffer.from(`master-${chapter}`).toString("base64")) } },
      audio: { durationSeconds: 10 + chapter, codec: "mp3", container: "mp3" } });
    await atomicWriteJson(paths.chapterMeta, metadata); await atomicWrite(paths.audioRaw, Buffer.from(`raw-${chapter}`)); await atomicWrite(paths.audio, Buffer.from(`master-${chapter}`));
  }
  return { root, story };
}

describe("audio mastering", () => {
  it("fingerprints TTS, settings, processor version, and segment inputs", () => {
    const settings = testStory().audio; const first = audioMasteringFingerprint("tts-a", settings, "ffmpeg-v1", ["segment-a"]);
    expect(audioMasteringFingerprint("tts-a", settings, "ffmpeg-v1", ["segment-a"])).toBe(first);
    expect(audioMasteringFingerprint("tts-a", { ...settings, loudnessTarget: -16 }, "ffmpeg-v1", ["segment-a"])).not.toBe(first);
    expect(audioMasteringFingerprint("tts-b", settings, "ffmpeg-v1", ["segment-a"])).not.toBe(first);
  });

  it("reuses unchanged masters and remasters when settings change", async () => {
    const { root, story } = await masteredFixture(); const paths = storyPaths(root, story.slug, 1); const metadata = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
    metadata.stages.audioMastering = { status: "pending" }; metadata.audio = undefined; await atomicWriteJson(paths.chapterMeta, metadata);
    const processor = new RecordingMaster(); const first = await masterStoredChapter({ root, story, chapter: 1, processor }); const second = await masterStoredChapter({ root, story, chapter: 1, processor });
    expect(first.reused).toBe(false); expect(second.reused).toBe(true); expect(processor.calls).toBe(1);
    await masterStoredChapter({ root, story: { ...story, audio: { ...story.audio, loudnessTarget: -16 } }, chapter: 1, processor }); expect(processor.calls).toBe(2);
  });

  it("generates loudness, peak limiting, pause, and clean MP3 arguments", () => {
    const plan = buildMasteringPlan(["one.mp3", "two.mp3"], "audio.mp3", testStory().audio, [10, 20]); const command = plan.args.join(" ");
    expect(command).toContain("loudnorm=I=-17:TP=-1.5"); expect(command).toContain("alimiter=limit="); expect(command).toContain("anullsrc"); expect(command).toContain("libmp3lame"); expect(plan.expectedDurationSeconds).toBe(30.35);
  });

  it("parses ffprobe output and rejects invalid or implausible results", async () => {
    const runner: CommandRunner = async () => ({ stdout: JSON.stringify({ format: { duration: "12.5", format_name: "mp3", bit_rate: "128000" }, streams: [{ codec_type: "audio", codec_name: "mp3", sample_rate: "44100" }] }), stderr: "" });
    await expect(new FfmpegTools("ffmpeg", "ffprobe", runner).probe("audio.mp3")).resolves.toMatchObject({ durationSeconds: 12.5, codec: "mp3", sampleRate: 44100 });
    await expect(new FfmpegTools("ffmpeg", "ffprobe", async () => ({ stdout: "{}", stderr: "" })).probe("bad.mp3")).rejects.toThrow("Invalid ffprobe output");
    expect(() => validateMasteredAudio({ durationSeconds: 1, codec: "mp3", container: "mp3" }, 20)).toThrow("implausible");
  });

  it("terminates media commands that exceed their deadline", async () => {
    await expect(runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 25)).rejects.toThrow("timed out after 25ms");
  });
});

describe("audiobook assembly", () => {
  it("selects chapters in numeric order, supports gaps, and prefers translated titles", async () => {
    const { root, story } = await masteredFixture([3, 1]); const chapters = await selectExportChapters(root, story, 1, 3);
    expect(chapters.map((item) => item.chapter)).toEqual([1, 3]); expect(chapters.map((item) => item.title)).toEqual(["Translated 1", "Translated 3"]);
  });

  it("generates M4B chapter metadata and maps it into the container", () => {
    const story = testStory(); story.author = "R. Writer"; const chapters: AudiobookChapter[] = [{ chapter: 1, title: "A=Start", path: "one.mp3", durationSeconds: 10, fingerprint: "a" }, { chapter: 2, title: "Return", path: "two.mp3", durationSeconds: 20, fingerprint: "b" }];
    const metadata = audiobookMetadata(story, chapters); expect(metadata.chapters).toEqual([{ chapter: 1, title: "A=Start", startMs: 0, endMs: 10000 }, { chapter: 2, title: "Return", startMs: 11500, endMs: 31500 }]);
    expect(buildFfmetadata(metadata)).toContain("title=A\\=Start"); const args = buildAudiobookArgs(chapters, "book.m4b", "m4b", story.audio, "chapters.ffmeta"); expect(args).toContain("-map_chapters"); expect(args).toContain("aac"); expect(args.at(-1)).toBe("book.m4b");
  });

  it("caches unchanged exports and invalidates them when a chapter master changes", async () => {
    const { root, story } = await masteredFixture([1, 2]); const processor = new RecordingBook();
    const first = await assembleAudiobook({ root, story, from: 1, to: 2, format: "m4b", processor }); const second = await assembleAudiobook({ root, story, from: 1, to: 2, format: "m4b", processor });
    expect(first.reused).toBe(false); expect(second.reused).toBe(true); expect(processor.calls).toBe(1); expect(processor.chapters).toEqual([1, 2]); expect(processor.metadata?.chapters.map((item) => item.title)).toEqual(["Translated 1", "Translated 2"]);
    const paths = storyPaths(root, story.slug, 2); await atomicWrite(paths.audio, Buffer.from("changed-master")); const metadata = JSON.parse(await readFile(paths.chapterMeta, "utf8")); metadata.stages.audioMastering.outputFingerprint = fingerprint(Buffer.from("changed-master").toString("base64")); await atomicWriteJson(paths.chapterMeta, metadata);
    await assembleAudiobook({ root, story, from: 1, to: 2, format: "m4b", processor }); expect(processor.calls).toBe(2);
  });

  it("invalidates an audiobook export when its cover changes", async () => {
    const { root, story } = await masteredFixture(); const processor = new RecordingBook(); const cover = join(storyPaths(root, story.slug, 1).story, "cover.png");
    await atomicWrite(cover, Buffer.from("cover-one")); await assembleAudiobook({ root, story, from: 1, to: 1, format: "m4b", processor }); await assembleAudiobook({ root, story, from: 1, to: 1, format: "m4b", processor }); expect(processor.calls).toBe(1);
    await atomicWrite(cover, Buffer.from("cover-two")); await assembleAudiobook({ root, story, from: 1, to: 1, format: "m4b", processor }); expect(processor.calls).toBe(2);
  });
});
