#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { loadStory } from "../../src/config/load-config.js";
import { summaryPath } from "../../src/summaries/service.js";
import { summarySchema } from "../../src/summaries/types.js";
import { storyPaths } from "../../src/storage/paths.js";
import { normalizeSpeechText } from "../../src/tts/speech-normalization.js";

export async function runSpeech(values: string[], root: string, stdout: (text: string) => unknown) {
  const [action, storySlug, chapterRaw, ...rest] = values;
  if (action !== "normalize" || !storySlug || !chapterRaw) throw new Error("Usage: story:speech normalize <story> <chapter> [--summary <summary-id>] [--json]");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(storySlug)) throw new Error("Story slug is invalid");
  const chapter = Number(chapterRaw); if (!Number.isInteger(chapter) || chapter < 1) throw new Error("Chapter must be a positive integer");
  let summaryId: string | undefined; let json = false;
  while (rest.length) { const option = rest.shift(); if (option === "--summary") { summaryId = rest.shift(); if (!summaryId) throw new Error("--summary requires a summary ID"); } else if (option === "--json") json = true; else throw new Error(`Unknown option '${option}'`); }
  const story = await loadStory(storyPaths(root, storySlug, chapter).storyConfig);
  let text: string;
  if (summaryId) {
    const summary = summarySchema.parse(JSON.parse(await readFile(summaryPath(root, storySlug, summaryId), "utf8")));
    text = summary.narration?.ttsText ?? summary.narration?.text ?? "";
    if (!text) throw new Error("Summary narration was not found");
  } else {
    const paths = storyPaths(root, storySlug, chapter);
    text = await readFile(paths.narrationTts, "utf8").catch(() => readFile(paths.narration, "utf8"));
  }
  const result = normalizeSpeechText(text, story.outputLanguage, story.narrationSettings);
  const output = { narrationText: text, spokenText: result.text, transformations: result.transformations, warnings: result.warnings };
  stdout(json ? JSON.stringify(output, null, 2) + "\n" : `Original narration\n${output.narrationText}\n\nNormalized spoken text\n${output.spokenText}\n\nDetected transformations\n${output.transformations.map(item => `${item.written} → ${item.spoken}`).join("\n") || "None"}\n`);
}
async function main() { const env = loadEnvironment(); await runSpeech(process.argv.slice(2), resolveStudioRoot(env), text => process.stdout.write(text)); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
