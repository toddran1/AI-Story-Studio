#!/usr/bin/env node
import { resolve } from "node:path";
import { loadEnvironment, resolveStudioRoot, Environment } from "../../src/config/env.js";
import { loadStory } from "../../src/config/load-config.js";
import { StageModelConfig } from "../../src/domain/provider.js";
import { createPipelineRuntime } from "../../src/pipeline/create-pipeline.js";
import { PreviewRunner } from "../../src/preview/preview-runner.js";
import { PreviewPreset } from "../../src/preview/types.js";
import { loadImportedChapters } from "../../src/source/importer.js";
import { storyPaths } from "../../src/storage/paths.js";
import { withStoryLock } from "../../src/storage/story-lock.js";

type Args = { story: string; chapter: number; input?: string; audioPreview: boolean; values: Partial<Record<"translationA" | "translationB" | "narrationA" | "narrationB" | "qaA" | "qaB", string>> };

async function main() {
  const args = parseArgs(process.argv.slice(2)); const env = loadEnvironment(); const root = resolveStudioRoot(env);
  await withStoryLock(root, args.story, `preview chapter ${args.chapter}`, async () => {
    const story = await loadStory(storyPaths(root, args.story, args.chapter).storyConfig);
    let inputPath = args.input ? resolve(args.input) : undefined;
    if (!inputPath) {
      const imported = await loadImportedChapters(root, args.story);
      inputPath = imported.chapters.find((item) => item.chapter === args.chapter)?.path;
    }
    if (!inputPath) throw new Error(`Imported source does not contain Chapter ${args.chapter}`);
    const current: PreviewPreset = { translation: story.pipeline.translation, narration: story.pipeline.narration, qa: story.pipeline.qa, tts: story.pipeline.tts };
    const alternateProvider = current.translation.provider === "gemini" ? "openai" : "gemini";
    const alternate: PreviewPreset = { ...current, translation: { provider: alternateProvider, model: defaultModel(alternateProvider, env) } };
    const presets = {
      a: applyOverrides(current, args.values.translationA, args.values.narrationA, args.values.qaA, env),
      b: applyOverrides(alternate, args.values.translationB, args.values.narrationB, args.values.qaB, env),
    };
    const runtime = createPipelineRuntime(env);
    const preview = await new PreviewRunner(runtime.router, runtime.tts).run({ root, story, chapter: args.chapter, inputPath, presets, audioPreview: args.audioPreview });
    process.stdout.write(`${JSON.stringify({ status: "complete", preview: preview.id, directory: `stories/${story.slug}/previews/${preview.id}`, results: preview.results }, null, 2)}\n`);
  });
}

function applyOverrides(base: PreviewPreset, translation: string | undefined, narration: string | undefined, qa: string | undefined, env: Environment): PreviewPreset {
  return { ...base, translation: parseModel(translation, base.translation, env), narration: parseModel(narration, base.narration, env), qa: parseModel(qa, base.qa, env) };
}
function parseModel(value: string | undefined, fallback: StageModelConfig, env: Environment): StageModelConfig {
  if (!value) return fallback;
  const [provider, ...modelParts] = value.split(":");
  if (provider !== "openai" && provider !== "gemini") throw new Error(`Invalid provider '${provider}'. Expected openai or gemini.`);
  const model = modelParts.join(":") || (provider === fallback.provider ? fallback.model : defaultModel(provider, env));
  return { provider, model };
}
function defaultModel(provider: "openai" | "gemini", env: Environment) { return provider === "openai" ? env.OPENAI_DEFAULT_MODEL : env.GEMINI_DEFAULT_MODEL; }
function parseArgs(values: string[]): Args {
  const result: Args = { story: "", chapter: 0, audioPreview: false, values: {} };
  const mapping: Record<string, keyof Args["values"]> = { "--translation-a": "translationA", "--translation-b": "translationB", "--narration-a": "narrationA", "--narration-b": "narrationB", "--qa-a": "qaA", "--qa-b": "qaB" };
  for (let index = 0; index < values.length; index++) {
    const key = values[index]!;
    if (key === "--audio-preview") { result.audioPreview = true; continue; }
    const value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`);
    if (key === "--story") result.story = value; else if (key === "--chapter") result.chapter = Number(value); else if (key === "--input") result.input = value;
    else if (mapping[key]) result.values[mapping[key]!] = value; else usage(`Unknown argument: ${key}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.story)) usage("--story must be a lowercase kebab-case slug");
  if (!Number.isInteger(result.chapter) || result.chapter < 1) usage("--chapter must be a positive integer");
  return result;
}
function usage(message: string): never { throw new Error(`${message}\nUsage: npm run story:preview -- --story <slug> --chapter <number> [--input <file>] [--translation-a provider[:model]] [--translation-b provider[:model]] [--narration-a provider[:model]] [--narration-b provider[:model]] [--qa-a provider[:model]] [--qa-b provider[:model]] [--audio-preview]`); }
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
