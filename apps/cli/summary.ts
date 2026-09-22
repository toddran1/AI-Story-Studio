#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { createPipelineRuntime } from "../../src/pipeline/create-pipeline.js";
import { SummaryService, coverage } from "../../src/summaries/service.js";
import { summaryIdSchema, summarySourceModeSchema, summaryTypeSchema, SUMMARY_WORDS_PER_MINUTE } from "../../src/summaries/types.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { SummaryMediaService, summaryExportTypeSchema, summaryScenesInputSchema } from "../../src/summaries/media.js";
import { SummaryVisualService, summaryVisualInputSchema, summaryProduceInputSchema } from "../../src/summaries/visuals.js";
import { FfmpegVideoProcessor } from "../../src/video/renderer.js";
import { alignmentConfig, createAlignmentEngine } from "../../src/alignment/config.js";

export type SummaryCommand =
  | { action: "list"; story: string }
  | { action: "show" | "delete"; story: string; id: string }
  | { action: "regenerate"; story: string; id: string; overrides: Record<string, unknown> }
  | { action: "generate"; story: string; input: Record<string, unknown> }
  | { action: "narration" | "audio"; story: string; id: string; force: boolean }
  | { action: "scenes" | "artwork" | "video" | "produce"; story: string; id: string; input: Record<string, unknown> }
  | { action: "reupscale"; story: string; id: string; input: Record<string, unknown> }
  | { action: "export"; story: string; id: string; type: "summary" | "narration" | "audio" | "video" };

export function parseSummaryArgs(values: string[]): SummaryCommand {
  const [action, story, positionalId, ...rest] = values;
  if (!action || !story || !["generate", "list", "show", "regenerate", "delete", "narration", "audio", "scenes", "artwork", "video", "produce", "reupscale", "export"].includes(action)) usage();
  validateStory(story);
  if (action === "reupscale") {
    if (!positionalId) usage("Reupscale requires a summary ID");
    const input: Record<string, unknown> = {};
    for (let index = 0; index < rest.length; index++) {
      const key = rest[index];
      const value = rest[++index];
      if (!value) usage(`Missing value for ${key}`);
      if (key === "--scene") input.sceneId = value;
      else if (key === "--version") input.versionNumber = Number(value);
      else usage(`Unknown reupscale option: ${key}`);
    }
    return { action: "reupscale", story, id: summaryIdSchema.parse(positionalId), input };
  }
  if (action === "scenes" || action === "artwork" || action === "video" || action === "produce") {
    if (!positionalId) usage(`${action} requires a summary ID`);
    const input: Record<string, unknown> = {};
    const allowed = action === "scenes"
      ? new Set(["--force", "--pacing", "--scene-count", "--seconds-per-scene"])
      : action === "artwork"
        ? new Set(["--force", "--missing-only", "--dry-run", "--scene", "--allow-unprofiled"])
        : action === "video"
          ? new Set(["--force"])
          : new Set(["--force", "--missing-only", "--dry-run", "--pacing", "--scene-count", "--seconds-per-scene", "--allow-unprofiled"]);
    for (let index = 0; index < rest.length; index++) {
      const key = rest[index];
      if (!allowed.has(key!)) usage(`Unknown ${action} option: ${key}`);
      if (key === "--force") { input.force = true; continue; }
      if (key === "--missing-only") { input.missingOnly = true; continue; }
      if (key === "--dry-run") { input.dryRun = true; continue; }
      const value = rest[++index]; if (!value) usage(`Missing value for ${key}`);
      if (key === "--pacing") input.pacing = value;
      else if (key === "--scene-count") input.sceneCount = Number(value);
      else if (key === "--seconds-per-scene") input.secondsPerScene = Number(value);
      else if (key === "--scene") input.scenes = value.split(",");
      else if (key === "--allow-unprofiled") input.allowUnprofiledEntityIds = value.split(",").filter(Boolean);
      else usage(`Unknown ${action} option: ${key}`);
    }
    return { action, story, id: summaryIdSchema.parse(positionalId), input: action === "scenes" ? summaryScenesInputSchema.parse(input) : action === "produce" ? summaryProduceInputSchema.parse(input) : summaryVisualInputSchema.parse(input) };
  }
  if (action === "narration" || action === "audio") {
    if (!positionalId || (rest.length && (rest.length !== 1 || rest[0] !== "--force"))) usage(`${action} requires an ID and optionally --force`);
    return { action, story, id: summaryIdSchema.parse(positionalId), force: rest[0] === "--force" };
  }
  if (action === "export") {
    if (!positionalId || rest.length !== 2 || rest[0] !== "--type") usage("Export requires an ID and --type summary|narration|audio");
    return { action, story, id: summaryIdSchema.parse(positionalId), type: rest[1] === "video" ? "video" : summaryExportTypeSchema.parse(rest[1]) };
  }
  if (action === "list") { if (positionalId || rest.length) usage("List does not accept additional arguments"); return { action, story }; }
  if (action === "show" || action === "delete") { if (!positionalId || rest.length) usage(`${action} requires one summary ID`); return { action, story, id: summaryIdSchema.parse(positionalId) }; }
  if (action === "regenerate") {
    if (!positionalId) usage("Regenerate requires a summary ID");
    return { action, story, id: summaryIdSchema.parse(positionalId), overrides: parseOptions(rest, false) };
  }
  const valuesAfterStory = positionalId ? [positionalId, ...rest] : rest;
  const input = parseOptions(valuesAfterStory, true);
  const hasRange = input.from !== undefined || input.to !== undefined;
  if (hasRange !== (input.chapters === undefined)) usage("Generate requires either --from and --to, or --chapters");
  if (hasRange && (input.from === undefined || input.to === undefined)) usage("Chapter ranges require both --from and --to");
  const selected = input.chapters as number[] | undefined;
  input.title ??= hasRange ? `Chapters ${input.from}–${input.to} recap` : `Chapters ${coverage(selected!)} recap`;
  return { action: "generate", story, input };
}

async function main() {
  const command = parseSummaryArgs(process.argv.slice(2));
  const env = loadEnvironment(); const root = resolveStudioRoot(env); const runtime = createPipelineRuntime(env); const service = new SummaryService(root, runtime.router);
  const media = new SummaryMediaService(root, runtime.router, runtime.tts, runtime.censor, runtime.audio);
  const config = alignmentConfig(env, root); const visuals = new SummaryVisualService(root, media, runtime.images, new FfmpegVideoProcessor(), config, createAlignmentEngine(config));
  await runSummaryCommand(command, { root, service, media, visuals, stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) });
}

export async function runSummaryCommand(command: SummaryCommand, dependencies: { root: string; service: SummaryService; media?: SummaryMediaService; visuals?: SummaryVisualService; stdout: (text: string) => unknown; stderr: (text: string) => unknown }) {
  const { root, service, stdout, stderr } = dependencies;
  if (command.action === "list") {
    const records = await service.list(command.story);
    stdout(records.length ? records.map((item) => `${item.id}\t${item.status}\t${coverage(item.chapters)}\t${item.summaryType}\t${item.title}`).join("\n") + "\n" : "No summaries found.\n");
    return;
  }
  if (command.action === "show") { stdout(`${JSON.stringify(await (dependencies.visuals ?? dependencies.media ?? service).get(command.story, command.id), null, 2)}\n`); return; }
  if (command.action === "reupscale") {
    const visuals = dependencies.visuals;
    if (!visuals) throw new Error("Summary visual services are not configured");
    const result = await withStoryLock(root, command.story, "summary reupscale", () =>
      visuals.reupscale(command.story, command.id, command.input)
    );
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command.action === "artwork" || command.action === "video" || command.action === "produce" || (command.action === "export" && command.type === "video")) {
    const visuals = dependencies.visuals; if (!visuals) throw new Error("Summary visual services are not configured");
    const result = await withStoryLock<unknown>(root, command.story, `summary ${command.action}`, () => command.action === "export" ? visuals.export(command.story, command.id, "video") : visuals[command.action](command.story, command.id, command.input, (event) => { stderr(`${event.type}${event.scene ? ` ${event.scene}` : ""}\n`); }));
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    if (command.action === "produce" && result && typeof result === "object" && "status" in result && result.status === "blocked") {
      const blocked = result as { preflight?: { requiresDecision?: Array<{ name: string; entityId: string }> }; beforeUpstream?: boolean };
      const entities = blocked.preflight?.requiresDecision?.map((entity) => `${entity.name} (${entity.entityId})`).join(", ") ?? "unknown entities";
      throw new Error(`Summary Produce is blocked by unresolved Visual Profiles: ${entities}. Review/create profiles or rerun with --allow-unprofiled <entity-id,...>.${blocked.beforeUpstream ? " No production stages were started." : " Completed narration, audio, and scenes were preserved; image generation and video rendering did not run."}`);
    }
    return;
  }
  if (command.action === "scenes") {
    if (!dependencies.media) throw new Error("Summary media services are not configured");
    const result = await withStoryLock(root, command.story, "summary scenes", () => (dependencies.visuals ?? dependencies.media!).scenes(command.story, command.id, command.input));
    stdout(`${JSON.stringify(result, null, 2)}\n`); return;
  }
  if (command.action === "narration" || command.action === "audio" || command.action === "export") {
    const media = dependencies.media; if (!media) throw new Error("Summary media services are not configured");
    const result = await withStoryLock<unknown>(root, command.story, `summary ${command.action}`, () => command.action === "export"
      ? media.export(command.story, command.id, summaryExportTypeSchema.parse(command.type))
      : media[command.action](command.story, command.id, { force: command.force }));
    stdout(`${JSON.stringify(result, null, 2)}\n`); return;
  }
  if (command.action === "delete") {
    await withStoryLock(root, command.story, "summary deletion", () => service.delete(command.story, command.id));
    stdout(`Deleted ${command.id}.\n`); return;
  }
  const progress = (event: { phase: string; completed: number; total: number; chapters?: number[] }) => stderr(`[${event.completed}/${event.total}] ${event.phase}${event.chapters?.length ? ` · chapters ${coverage(event.chapters)}` : ""}\n`);
  if (command.action !== "generate" && command.action !== "regenerate") throw new Error(`Unsupported summary action: ${command.action}`);
  const result = command.action === "generate"
    ? await withStoryLock(root, command.story, "summary generation", () => service.generate(command.story, command.input, progress))
    : await withStoryLock(root, command.story, "summary regeneration", () => service.regenerate(command.story, command.id, command.overrides, progress));
  stdout(`${JSON.stringify(result, null, 2)}\n`);
}

function parseOptions(values: string[], selectionAllowed: boolean) {
  const result: Record<string, unknown> = {};
  for (let index = 0; index < values.length; index++) {
    const key = values[index]!;
    if (key === "--context") { result.contextEligible = true; continue; }
    const value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`);
    if (key === "--title") result.title = value;
    else if (key === "--type") result.summaryType = summaryTypeSchema.parse(value);
    else if (key === "--source") result.sourceMode = summarySourceModeSchema.parse(value);
    else if (key === "--target-length") result.targetWords = integer(value, 50, 20_000, "Target length");
    else if (key === "--target-minutes") { const minutes = Number(value); if (!Number.isFinite(minutes) || minutes < 50/SUMMARY_WORDS_PER_MINUTE || minutes > 20_000/SUMMARY_WORDS_PER_MINUTE) usage("Target minutes must be between 0.34 and 133.33"); result.targetWords = Math.round(minutes * SUMMARY_WORDS_PER_MINUTE); }
    else if (key === "--chunk-size") result.chunkSize = integer(value, 1, 100, "Chunk size");
    else if (key === "--focus") result.focus = value;
    else if (key === "--instructions") result.instructions = value;
    else if (key === "--model") { const separator = value.indexOf(":"); if (separator < 1 || separator === value.length - 1) usage("--model must use provider:model format"); result.model = { provider: value.slice(0, separator), model: value.slice(separator + 1) }; }
    else if (selectionAllowed && key === "--from") result.from = integer(value, 1, Number.MAX_SAFE_INTEGER, "Chapter");
    else if (selectionAllowed && key === "--to") result.to = integer(value, 1, Number.MAX_SAFE_INTEGER, "Chapter");
    else if (selectionAllowed && key === "--chapters") { const chapters = [...new Set(value.split(",").map((item) => integer(item.trim(), 1, Number.MAX_SAFE_INTEGER, "Chapter")))].sort((a, b) => a - b); if (!chapters.length) usage("--chapters cannot be empty"); result.chapters = chapters; }
    else usage(`Unknown argument: ${key}`);
  }
  return result;
}

function integer(value: string, min: number, max: number, label: string) { const number = Number(value); if (!Number.isSafeInteger(number) || number < min || number > max) usage(`${label} must be an integer from ${min} to ${max}`); return number; }
function validateStory(story: string) { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(story)) usage("Invalid story slug"); }
function usage(message = "Invalid summary command"): never { throw new Error(`${message}\nUsage:\n  npm run story:summary -- generate <story> (--from N --to N | --chapters N,N) [--title text] [--type brief|detailed|mini-chapter|arc|character-focused|custom] [--source original|translated|chapter-summaries] [--target-length words] [--model provider:model] [--context]\n  npm run story:summary -- list <story>\n  npm run story:summary -- show <story> <summary-id>\n  npm run story:summary -- regenerate <story> <summary-id> [generation options]\n  npm run story:summary -- delete <story> <summary-id>\n  npm run story:summary -- narration <story> <summary-id> [--force]\n  npm run story:summary -- audio <story> <summary-id> [--force]\n  npm run story:summary -- export <story> <summary-id> --type summary|narration|audio|video\n  npm run story:summary -- scenes <story> <summary-id> [--pacing automatic|slow|balanced|fast|custom] [--scene-count N | --seconds-per-scene N] [--force]\n  npm run story:summary -- artwork <story> <summary-id> [--missing-only] [--scene scene-001,scene-002] [--allow-unprofiled entity-id,...] [--force] [--dry-run]\n  npm run story:summary -- reupscale <story> <summary-id> [--scene scene-NNN] [--version N]\n  npm run story:summary -- video <story> <summary-id> [--force]\n  npm run story:summary -- produce <story> <summary-id> [pacing options] [--missing-only] [--allow-unprofiled entity-id,...] [--dry-run]\n  --allow-unprofiled explicitly permits Story Bible fallback for listed entities in this request only.\n  Generation also accepts --target-minutes N (150 words/minute).`); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
