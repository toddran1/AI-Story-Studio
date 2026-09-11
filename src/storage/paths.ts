import { join } from "node:path";

export function storyPaths(root: string, slug: string, chapter: number) {
  const story = join(root, "stories", slug);
  const source = join(story, "source");
  const chapterDir = join(story, "chapters", String(chapter).padStart(4, "0"));
  return {
    story, source, sourceManifest: join(source, "source.json"), sourceChapters: join(source, "chapters"), chapterDir,
    storyConfig: join(story, "story.json"), pipelineConfig: join(story, "pipeline.json"),
    bible: join(story, "story-bible.json"), bibleManual: join(story, "story-bible-manual.json"), bibleCanonicalManual: join(story, "story-bible-canonical-manual.json"), continuityReview: join(story, "continuity-review.json"), chapterMeta: join(chapterDir, "chapter.json"),
    original: join(chapterDir, "original.txt"), english: join(chapterDir, "english.txt"),
    narration: join(chapterDir, "narration.txt"), narrationTts: join(chapterDir, "narration-tts.txt"), qa: join(chapterDir, "qa.json"), bibleUpdate: join(chapterDir, "story-bible-update.json"), continuityAnalysis: join(chapterDir, "continuity.json"), storyContext: join(chapterDir, "story-context.json"),
    audioRaw: join(chapterDir, "audio-raw.mp3"), audio: join(chapterDir, "audio.mp3"), segments: join(chapterDir, "audio-segments"),
    alignment: join(chapterDir, "alignment.json"), subtitlesDocument: join(chapterDir, "subtitles.json"), subtitlesManual: join(chapterDir, "subtitles.manual.json"),
    subtitlesSrt: join(chapterDir, "subtitles.srt"), subtitlesVtt: join(chapterDir, "subtitles.vtt"), video: join(chapterDir, "video.mp4"),
    scenesManifest: join(chapterDir, "scenes.json"), scenesDirectory: join(chapterDir, "scenes"),
  };
}

export function voicePreviewPaths(root: string, slug: string, id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid voice preview ID");
  const directory = join(root, "stories", slug, "voice-previews");
  return { directory, audio: join(directory, `${id}.mp3`), manifest: join(directory, `${id}.json`) };
}

export function sceneImagePath(root: string, slug: string, chapter: number, sceneId: string) {
  if (!/^scene-\d{3}$/.test(sceneId)) throw new Error("Invalid scene ID");
  return join(storyPaths(root, slug, chapter).scenesDirectory, `${sceneId}.png`);
}

export function videoExportPaths(root: string, slug: string, from: number, to: number) {
  const directory = join(root, "stories", slug, "exports"); const stem = `${slug}-${String(from).padStart(3, "0")}-${String(to).padStart(3, "0")}`;
  return { directory, output: join(directory, `${stem}.mp4`), manifest: join(directory, `${stem}.mp4.json`) };
}

export function exportPaths(root: string, slug: string, from: number, to: number, format: "mp3" | "m4b") {
  const directory = join(root, "stories", slug, "exports"); const stem = `${slug}-${String(from).padStart(3, "0")}-${String(to).padStart(3, "0")}`;
  return { directory, output: join(directory, `${stem}.${format}`), manifest: join(directory, `${stem}.${format}.json`) };
}

export function previewPaths(root: string, slug: string, id: string) {
  const directory = join(root, "stories", slug, "previews", id);
  return {
    directory, manifest: join(directory, "preview.json"),
    translationA: join(directory, "translation-a.txt"), translationB: join(directory, "translation-b.txt"),
    narrationA: join(directory, "narration-a.txt"), narrationB: join(directory, "narration-b.txt"),
    qaA: join(directory, "qa-a.json"), qaB: join(directory, "qa-b.json"),
    audioA: join(directory, "audio-a.mp3"), audioB: join(directory, "audio-b.mp3"),
  };
}

export function batchPaths(root: string, slug: string, id?: string) {
  const story = join(root, "stories", slug); const batches = join(story, "batches");
  return { story, batches, latest: join(batches, "latest.json"), manifest: id ? join(batches, `${id}.json`) : undefined };
}
