#!/usr/bin/env node
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { loadImportedChapters } from "../../src/source/importer.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { analyzeAndPersistContinuity } from "../../src/story-bible/continuity.js";
import { rebuildStoryBibleBeforeChapter } from "../../src/story-bible/rebuild.js";

async function main() {
  const story = parse(process.argv.slice(2)); const root = resolveStudioRoot(loadEnvironment());
  await withStoryLock(root, story, "continuity analysis", async () => {
    const chapters = (await loadImportedChapters(root, story)).chapters.map((item) => item.chapter).sort((a, b) => a - b); const last = chapters.at(-1);
    if (!last) throw new Error(`Story '${story}' has no imported chapters`);
    const bible = await rebuildStoryBibleBeforeChapter(root, story, last + 1); const result = await analyzeAndPersistContinuity(root, story, bible, last);
    process.stdout.write(`Analyzed through Chapter ${result.document.analyzedThroughChapter}: ${result.document.findings.filter((item) => item.status === "open").length} open finding(s), ${result.document.findings.length} recorded.\n`);
  });
}
function parse(values: string[]) { const index = values.indexOf("--story"); const story = index >= 0 ? values[index + 1] : undefined; if (!story || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(story) || values.length !== 2) throw new Error("Usage: npm run story:continuity -- --story <slug>"); return story; }
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
