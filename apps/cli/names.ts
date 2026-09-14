#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getStoryBible } from "../server/catalog.js";
import { StudioOperations } from "../server/operations.js";
import { Job, JobManager } from "../server/job-manager.js";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { entityTypeSchema, localizedNamingSchema } from "../../src/domain/story-bible.js";

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const entityIdSchema = z.string().regex(/^ent_[a-f0-9]{24}$/);
const usageModeSchema = z.enum(["ai_contextual", "always_full", "always_short", "manual"]);

export type NamesCommand =
  | { action: "list"; story: string; type?: z.infer<typeof entityTypeSchema>; query?: string }
  | { action: "show"; story: string; id: string }
  | { action: "suggest"; story: string; id: string; locale?: string; count?: number }
  | { action: "set"; story: string; id: string; localizedNaming: z.infer<typeof localizedNamingSchema> }
  | { action: "clear"; story: string; id: string };

export function parseNamesArgs(values: string[]): NamesCommand {
  const [action, story, positionalId, ...rest] = values;
  if (!action || !story || !["list", "show", "suggest", "set", "clear"].includes(action)) usage();
  const parsedStory = slugSchema.safeParse(story); if (!parsedStory.success) usage("Story must be a valid slug");
  if (action === "list") {
    if (positionalId?.startsWith("--")) rest.unshift(positionalId); else if (positionalId) usage("List does not accept an entity ID");
    const options = parseListOptions(rest); return { action, story, ...options };
  }
  if (!positionalId) usage(`${capitalize(action)} requires a canonical entity ID`);
  const id = entityIdSchema.parse(positionalId);
  if (action === "show" || action === "clear") { if (rest.length) usage(`${capitalize(action)} does not accept additional options`); return { action, story, id }; }
  if (action === "suggest") return { action, story, id, ...parseSuggestOptions(rest) };
  return { action: "set", story, id, localizedNaming: parseLocalizedNaming(rest) };
}

async function main() {
  const command = parseNamesArgs(process.argv.slice(2)); const env = loadEnvironment(); const root = resolveStudioRoot(env); const operations = new StudioOperations(root, env);
  try { await runNamesCommand(command, { root, operations, stdout: (text) => process.stdout.write(text) }); }
  finally { await operations.close(); }
}

export async function runNamesCommand(command: NamesCommand, dependencies: { root: string; operations: Pick<StudioOperations, "updateCanonicalEntity" | "startLocalizationSuggestions" | "jobs">; stdout: (text: string) => unknown }) {
  const { root, operations, stdout } = dependencies;
  if (command.action === "list") {
    let entities = (await getStoryBible(root, command.story)).canonicalEntities;
    if (command.type) entities = entities.filter((entity) => entity.type === command.type);
    const query = command.query?.toLocaleLowerCase();
    if (query) entities = entities.filter((entity) => [entity.canonicalName, entity.originalName, entity.localizedNaming?.fullName ?? "", entity.localizedNaming?.shortName ?? "", ...entity.aliases].some((name) => name.toLocaleLowerCase().includes(query)));
    stdout(entities.length ? [...entities].sort((left, right) => left.canonicalName.localeCompare(right.canonicalName)).map((entity) => `${entity.id}\t${entity.type}\t${entity.canonicalName}\t${entity.localizedNaming?.fullName ?? ""}\t${entity.localizedNaming?.shortName ?? ""}`).join("\n") + "\n" : "No canonical entities found.\n"); return;
  }
  if (command.action === "show") { stdout(`${JSON.stringify(await entity(root, command.story, command.id), null, 2)}\n`); return; }
  if (command.action === "set" || command.action === "clear") {
    const result = await operations.updateCanonicalEntity(command.story, command.id, { localizedNaming: command.action === "set" ? command.localizedNaming : null });
    stdout(`${JSON.stringify({ entity: result.entity, invalidation: result.invalidation }, null, 2)}\n`); return;
  }
  const job = operations.startLocalizationSuggestions(command.story, command.id, { locale: command.locale, count: command.count });
  const completed = await waitForJob(operations.jobs, job.id);
  if (completed.status !== "completed") throw new Error(completed.error ?? "Localized name suggestions did not finish");
  stdout(`${JSON.stringify(completed.result, null, 2)}\n`);
}

async function entity(root: string, story: string, id: string) {
  const result = (await getStoryBible(root, story)).canonicalEntities.find((item) => item.id === id);
  if (!result) throw new Error("Canonical entity was not found");
  return result;
}

function waitForJob(jobs: JobManager, id: string): Promise<Job> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const finish = (job: Job) => {
      if (!["completed", "failed", "paused"].includes(job.status)) return;
      unsubscribe?.(); resolve(job);
    };
    unsubscribe = jobs.subscribe(id, finish);
    if (!unsubscribe) reject(new Error("Localized name suggestion job was not found"));
  });
}

function parseListOptions(values: string[]) {
  let type: z.infer<typeof entityTypeSchema> | undefined; let query: string | undefined;
  for (let index = 0; index < values.length; index++) { const key = values[index]!; const value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`); if (key === "--type") type = entityTypeSchema.parse(value); else if (key === "--query") query = value; else usage(`Unknown argument: ${key}`); }
  return { type, query };
}

function parseSuggestOptions(values: string[]) {
  let locale: string | undefined; let count: number | undefined;
  for (let index = 0; index < values.length; index++) { const key = values[index]!; const value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`); if (key === "--locale") locale = value; else if (key === "--count") { count = Number(value); if (!Number.isSafeInteger(count) || count < 3 || count > 8) usage("--count must be an integer from 3 to 8"); } else usage(`Unknown argument: ${key}`); }
  return { locale, count };
}

function parseLocalizedNaming(values: string[]) {
  let locale: string | undefined; let fullName: string | undefined; let shortName: string | undefined; let usageMode: z.infer<typeof usageModeSchema> = "ai_contextual"; let notes: string | undefined;
  for (let index = 0; index < values.length; index++) { const key = values[index]!; const value = values[++index]; if (!value || value.startsWith("--")) usage(`Missing value for ${key}`); if (key === "--locale") locale = value; else if (key === "--full") fullName = value; else if (key === "--short") shortName = value; else if (key === "--mode") usageMode = usageModeSchema.parse(value); else if (key === "--notes") notes = value; else usage(`Unknown argument: ${key}`); }
  if (!locale) usage("Set requires --locale");
  return localizedNamingSchema.parse({ locale, fullName, shortName, usageMode, notes });
}

function capitalize(value: string) { return value[0]!.toUpperCase() + value.slice(1); }
function usage(message = "Invalid names command"): never { throw new Error(`${message}\nUsage:\n  npm run story:names -- list <story> [--type character|location|organization|ability|item|concept] [--query text]\n  npm run story:names -- show <story> <entity-id>\n  npm run story:names -- suggest <story> <entity-id> [--locale en-US] [--count 3-8]\n  npm run story:names -- set <story> <entity-id> --locale en-US [--full \"Full Name\"] [--short \"Short Name\"] [--mode ai_contextual|always_full|always_short|manual] [--notes text]\n  npm run story:names -- clear <story> <entity-id>`); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
