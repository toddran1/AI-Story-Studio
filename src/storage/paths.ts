import { join } from "node:path";

export function storyPaths(root: string, slug: string, chapter: number) {
  const story = join(root, "stories", slug);
  const source = join(story, "source");
  const chapterDir = join(story, "chapters", String(chapter).padStart(4, "0"));
  return {
    story, source, sourceManifest: join(source, "source.json"), sourceChapters: join(source, "chapters"), chapterDir,
    storyConfig: join(story, "story.json"), pipelineConfig: join(story, "pipeline.json"),
    bible: join(story, "story-bible.json"), chapterMeta: join(chapterDir, "chapter.json"),
    original: join(chapterDir, "original.txt"), english: join(chapterDir, "english.txt"),
    narration: join(chapterDir, "narration.txt"), qa: join(chapterDir, "qa.json"), bibleUpdate: join(chapterDir, "story-bible-update.json"),
    audio: join(chapterDir, "audio.mp3"), segments: join(chapterDir, "audio-segments"),
  };
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
