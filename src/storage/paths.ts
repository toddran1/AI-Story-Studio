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
    narration: join(chapterDir, "narration.txt"), bibleUpdate: join(chapterDir, "story-bible-update.json"),
    audio: join(chapterDir, "audio.mp3"), segments: join(chapterDir, "audio-segments"),
  };
}

export function batchPaths(root: string, slug: string, id?: string) {
  const story = join(root, "stories", slug); const batches = join(story, "batches");
  return { story, batches, latest: join(batches, "latest.json"), manifest: id ? join(batches, `${id}.json`) : undefined };
}
