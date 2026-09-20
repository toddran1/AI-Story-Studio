import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultStory } from "../src/config/load-config.js";
import { loadEnvironment } from "../src/config/env.js";
import {
  storyPaths,
  exportPaths,
  videoExportPaths,
  voicePreviewPaths,
  sanitizeFilenamePart,
  padChapterNumber,
  mediaDownloadName,
  rangeMediaDownloadName,
} from "../src/storage/paths.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { StudioOperations } from "../apps/server/operations.js";
import { JobManager } from "../apps/server/job-manager.js";
import { createApiHandler } from "../apps/server/api.js";
import { getOutputsLibrary } from "../apps/server/catalog.js";
import { Readable, PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

const env = loadEnvironment({});

async function createStoryFixture(slug = "sovereign-ashes") {
  const root = await mkdtemp(join(tmpdir(), "story-media-"));
  const story = defaultStory(slug, env);
  story.title = "Sovereign Ashes";
  const paths = storyPaths(root, story.slug, 1);
  await atomicWriteJson(paths.storyConfig, story);
  await atomicWriteJson(paths.pipelineConfig, story.pipeline);
  return { root, story, paths };
}

interface CallApiResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function makeApiCaller(handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void>) {
  return async (urlPath: string, reqHeaders: Record<string, string> = {}): Promise<CallApiResponse> => {
    const req = Object.assign(Readable.from([]), {
      method: "GET",
      url: urlPath,
      headers: { host: "localhost:3000", ...reqHeaders },
    });
    const headers: Record<string, string> = {};
    let status = 200;
    const chunks: Buffer[] = [];
    const res = Object.assign(new PassThrough(), {
      setHeader: (name: string, value: unknown) => {
        headers[name.toLowerCase()] = String(value);
      },
      writeHead: (code: number, values?: Record<string, unknown>) => {
        status = code;
        if (values) {
          for (const [k, v] of Object.entries(values)) {
            headers[k.toLowerCase()] = String(v);
          }
        }
      },
    });
    res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const done = new Promise<void>((resolve) => res.on("finish", resolve));
    await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    await done;
    return { status, headers, body: Buffer.concat(chunks) };
  };
}

describe("Media download naming utilities", () => {
  it("sanitizes filename components defensively", () => {
    expect(sanitizeFilenamePart("normal-slug")).toBe("normal-slug");
    expect(sanitizeFilenamePart("my/evil\\path:name*here?")).toBe("my-evil-path-name-here");
    expect(sanitizeFilenamePart("../traversal/slug")).toBe("traversal-slug");
    expect(sanitizeFilenamePart("  trimmed string  ")).toBe("trimmed string");
    expect(sanitizeFilenamePart("---leading-trailing---")).toBe("leading-trailing");
    expect(sanitizeFilenamePart("")).toBe("media");
    expect(sanitizeFilenamePart("   ")).toBe("media");
  });

  it("pads chapter numbers to at least 4 digits", () => {
    expect(padChapterNumber(1)).toBe("0001");
    expect(padChapterNumber(40)).toBe("0040");
    expect(padChapterNumber(408)).toBe("0408");
    expect(padChapterNumber(1620)).toBe("1620");
    expect(padChapterNumber(10000)).toBe("10000");
  });

  it("builds single-item media download filenames", () => {
    expect(mediaDownloadName("sovereign-ashes", 1, "mp3")).toBe("sovereign-ashes-0001.mp3");
    expect(mediaDownloadName("sovereign-ashes", 408, "mp4")).toBe("sovereign-ashes-0408.mp4");
    expect(mediaDownloadName("sovereign-ashes", 1, "vtt")).toBe("sovereign-ashes-0001.vtt");
    expect(mediaDownloadName("my/story*slug", 25, ".srt")).toBe("my-story-slug-0025.srt");
  });

  it("builds range media download filenames", () => {
    expect(rangeMediaDownloadName("sovereign-ashes", 1, 50, "mp3")).toBe("sovereign-ashes-0001-0050.mp3");
    expect(rangeMediaDownloadName("sovereign-ashes", 1, 100, "m4b")).toBe("sovereign-ashes-0001-0100.m4b");
    expect(rangeMediaDownloadName("sovereign-ashes", 10, 25, "mp4")).toBe("sovereign-ashes-0010-0025.mp4");
  });
});

describe("Media download naming server integration", () => {
  it("serves chapter mastered audio inline by default and as attachment when ?download=1", async () => {
    const { root, story, paths } = await createStoryFixture();
    const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs);
    const handler = createApiHandler(operations);
    const callApi = makeApiCaller(handler);

    // Create a dummy mastered audio file
    await mkdir(paths.chapterDir, { recursive: true });
    await writeFile(paths.audio, Buffer.from("mastered audio bytes for testing"));

    // Default inline playback: NO content-disposition attachment
    const inlineRes = await callApi(`/api/stories/${story.slug}/chapters/1/audio`);
    expect(inlineRes.status).toBe(200);
    expect(inlineRes.headers["content-type"]).toBe("audio/mpeg");
    expect(inlineRes.headers["content-disposition"]).toBeUndefined();
    expect(inlineRes.body.toString()).toBe("mastered audio bytes for testing");

    // Download request: content-disposition attachment with sovereign-ashes-0001.mp3
    const downloadRes = await callApi(`/api/stories/${story.slug}/chapters/1/audio?download=1`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers["content-type"]).toBe("audio/mpeg");
    expect(downloadRes.headers["content-disposition"]).toBe('attachment; filename="sovereign-ashes-0001.mp3"');
    expect(downloadRes.body.toString()).toBe("mastered audio bytes for testing");

    await operations.close();
  });

  it("falls back to raw audio with descriptive filename when mastered audio is absent", async () => {
    const { root, story } = await createStoryFixture();
    const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs);
    const handler = createApiHandler(operations);
    const callApi = makeApiCaller(handler);

    const ch408Paths = storyPaths(root, story.slug, 408);
    await mkdir(ch408Paths.chapterDir, { recursive: true });
    await writeFile(ch408Paths.audioRaw, Buffer.from("raw speech bytes"));

    const res = await callApi(`/api/stories/${story.slug}/chapters/408/audio?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="sovereign-ashes-0408.mp3"');
    expect(res.body.toString()).toBe("raw speech bytes");

    await operations.close();
  });

  it("serves chapter video inline by default and as attachment when ?download=1", async () => {
    const { root, story, paths } = await createStoryFixture();
    const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs);
    const handler = createApiHandler(operations);
    const callApi = makeApiCaller(handler);

    await mkdir(paths.chapterDir, { recursive: true });
    await writeFile(paths.video, Buffer.from("video bytes for testing"));

    // Inline playback
    const inlineRes = await callApi(`/api/stories/${story.slug}/chapters/1/video`);
    expect(inlineRes.status).toBe(200);
    expect(inlineRes.headers["content-type"]).toBe("video/mp4");
    expect(inlineRes.headers["content-disposition"]).toBeUndefined();

    // Download request
    const downloadRes = await callApi(`/api/stories/${story.slug}/chapters/1/video?download=1`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers["content-disposition"]).toBe('attachment; filename="sovereign-ashes-0001.mp4"');

    await operations.close();
  });

  it("serves audiobook range exports (mp3 & m4b) with descriptive filenames", async () => {
    const { root, story } = await createStoryFixture();
    const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs);
    const handler = createApiHandler(operations);
    const callApi = makeApiCaller(handler);

    const mp3Export = exportPaths(root, story.slug, 1, 50, "mp3");
    const m4bExport = exportPaths(root, story.slug, 1, 50, "m4b");
    await mkdir(mp3Export.directory, { recursive: true });
    await writeFile(mp3Export.output, Buffer.from("audiobook mp3"));
    await writeFile(m4bExport.output, Buffer.from("audiobook m4b"));

    const mp3Res = await callApi(`/api/stories/${story.slug}/exports/1-50.mp3`);
    expect(mp3Res.status).toBe(200);
    expect(mp3Res.headers["content-disposition"]).toBe('attachment; filename="sovereign-ashes-0001-0050.mp3"');

    const m4bRes = await callApi(`/api/stories/${story.slug}/exports/1-50.m4b`);
    expect(m4bRes.status).toBe(200);
    expect(m4bRes.headers["content-disposition"]).toBe('attachment; filename="sovereign-ashes-0001-0050.m4b"');

    await operations.close();
  });

  it("serves combined video exports with descriptive range filenames", async () => {
    const { root, story } = await createStoryFixture();
    const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs);
    const handler = createApiHandler(operations);
    const callApi = makeApiCaller(handler);

    const videoExport = videoExportPaths(root, story.slug, 1, 50);
    await mkdir(videoExport.directory, { recursive: true });
    await writeFile(videoExport.output, Buffer.from("video export mp4"));

    const res = await callApi(`/api/stories/${story.slug}/video-exports/1-50.mp4`);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="sovereign-ashes-0001-0050.mp4"');

    await operations.close();
  });

  it("serves voice previews inline and as attachment when ?download=1", async () => {
    const { root, story } = await createStoryFixture();
    const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs);
    const handler = createApiHandler(operations);
    const callApi = makeApiCaller(handler);

    const voicePreviewId = "12345678-1234-4234-8234-123456789abc";
    const voicePreview = voicePreviewPaths(root, story.slug, voicePreviewId);
    await mkdir(voicePreview.directory, { recursive: true });
    await writeFile(voicePreview.audio, Buffer.from("voice sample"));
    await atomicWriteJson(voicePreview.manifest, { id: voicePreviewId, story: story.slug, text: "voice sample" });

    const inlineRes = await callApi(`/api/stories/${story.slug}/voice-previews/${voicePreviewId}.mp3`);
    expect(inlineRes.status).toBe(200);
    expect(inlineRes.headers["content-disposition"]).toBeUndefined();

    const downloadRes = await callApi(`/api/stories/${story.slug}/voice-previews/${voicePreviewId}.mp3?download=1`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers["content-disposition"]).toBe(`attachment; filename="sovereign-ashes-voice-preview-12345678.mp3"`);

    await operations.close();
  });

  it("preserves attachment header during HTTP Range requests (206 Partial Content)", async () => {
    const { root, story, paths } = await createStoryFixture();
    const jobs = new JobManager();
    const operations = new StudioOperations(root, env, jobs);
    const handler = createApiHandler(operations);
    const callApi = makeApiCaller(handler);

    await mkdir(paths.chapterDir, { recursive: true });
    const fileBytes = Buffer.from("0123456789abcdef");
    await writeFile(paths.audio, fileBytes);

    const rangeRes = await callApi(`/api/stories/${story.slug}/chapters/1/audio?download=1`, {
      range: "bytes=0-3",
    });

    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers["content-range"]).toBe(`bytes 0-3/${fileBytes.length}`);
    expect(rangeRes.headers["content-disposition"]).toBe('attachment; filename="sovereign-ashes-0001.mp3"');
    expect(rangeRes.body.toString()).toBe("0123");

    await operations.close();
  });

  it("provides downloadUrl with ?download=1 in getOutputsLibrary", async () => {
    const { root, story, paths } = await createStoryFixture();
    const now = new Date().toISOString();
    const complete = { status: "complete" as const, fingerprint: "x", outputFingerprint: "x" };
    await mkdir(paths.chapterDir, { recursive: true });
    await writeFile(paths.audio, Buffer.from("audio"));
    await writeFile(paths.video, Buffer.from("video"));
    await writeFile(paths.subtitlesVtt, Buffer.from("subtitles"));
    await atomicWriteJson(paths.chapterMeta, {
      chapter: 1,
      sourceLanguage: story.sourceLanguage,
      outputLanguage: story.outputLanguage,
      counts: { originalCharacters: 1, englishWords: 1, narrationWords: 1 },
      audio: { durationSeconds: 4, codec: "mp3", container: "mp3" },
      createdAt: now,
      updatedAt: now,
      stages: {
        ingestion: complete,
        translation: complete,
        narration: complete,
        qa: { status: "pending" as const },
        storyBible: { status: "pending" as const },
        tts: complete,
        audioMastering: complete,
        alignment: complete,
        subtitles: complete,
        scenePlanning: { status: "pending" as const },
        video: complete,
      },
    });

    const library = await getOutputsLibrary(root, story.slug);
    const audioItem = library.items.find((item) => item.group === "chapterAudio");
    expect(audioItem).toBeDefined();
    expect(audioItem?.downloadUrl).toBe(`/api/stories/${story.slug}/chapters/1/audio?download=1`);

    const videoItem = library.items.find((item) => item.group === "chapterVideos");
    expect(videoItem).toBeDefined();
    expect(videoItem?.downloadUrl).toBe(`/api/stories/${story.slug}/chapters/1/video?download=1`);

    const subItem = library.items.find((item) => item.group === "subtitles" && item.format === "vtt");
    expect(subItem).toBeDefined();
    expect(subItem?.downloadUrl).toBe(`/api/stories/${story.slug}/chapters/1/subtitles.vtt?download=1`);
  });
});
