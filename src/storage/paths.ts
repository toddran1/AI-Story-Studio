import { join } from "node:path";

export function storyPaths(root: string, slug: string, chapter: number) {
  const story = join(root, "stories", slug);
  const chapterDir = join(story, "chapters", String(chapter).padStart(4, "0"));
  return {
    story, chapterDir,
    storyConfig: join(story, "story.json"), pipelineConfig: join(story, "pipeline.json"),
    bible: join(story, "story-bible.json"), chapterMeta: join(chapterDir, "chapter.json"),
    original: join(chapterDir, "original.txt"), english: join(chapterDir, "english.txt"),
    narration: join(chapterDir, "narration.txt"), bibleUpdate: join(chapterDir, "story-bible-update.json"),
    audio: join(chapterDir, "audio.mp3"), segments: join(chapterDir, "audio-segments"),
  };
}
