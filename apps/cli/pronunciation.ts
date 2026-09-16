#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadStory } from "../../src/config/load-config.js";
import { storyPaths } from "../../src/storage/paths.js";
import { z } from "zod";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { StudioOperations } from "../server/operations.js";
import type { Job } from "../server/job-manager.js";
import { getStoryBible } from "../server/catalog.js";
import { pronunciationSchema } from "../../src/domain/story-bible.js";

export async function runPronunciation(values: string[], root: string, ops: Pick<StudioOperations, "startPronunciationEnrichment" | "startPronunciationTest" | "updateCanonicalEntity" | "jobs">, stdout: (text: string) => unknown) {
  if (values.length === 1 && values[0] === "--help") { stdout("Usage: story:pronunciation list|show|enrich|test|set|clear <story> [entity-id] [pronunciation-json]\nEnrich supports --entity <id>, --missing, --dry-run, and --force. Enrich and test may make paid provider calls. Set accepts provider-neutral JSON.\n"); return; }
  const [action, story, ...arguments_] = values;
  let id: string | undefined, payload: string | undefined, dryRun = false, force = false, missing = false;
  if (action === "enrich") {
    const rest = [...arguments_];
    while (rest.length) {
      const value = rest.shift()!;
      if (value === "--dry-run") { dryRun = true; continue; }
      if (value === "--force") { force = true; continue; }
      if (value === "--missing") { missing = true; continue; }
      if (value === "--entity") { id = rest.shift(); if (!id) throw new Error("--entity requires an entity ID"); continue; }
      if (!id && /^ent_[a-f0-9]{24}$/.test(value)) { id = value; continue; }
      throw new Error(`Unexpected pronunciation enrich argument: ${value}`);
    }
    if (id && missing) throw new Error("Choose either an entity ID or --missing");
  } else [id, payload] = arguments_;
  const extra = action === "enrich" ? [] : arguments_.slice(2);
  if (!action || !["list", "show", "enrich", "test", "set", "clear"].includes(action) || !story || extra.length) throw new Error("Usage: story:pronunciation list|show|enrich|test|set|clear <story> [entity-id] [pronunciation-json]");
  z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).parse(story);
  if (id) z.string().regex(/^ent_[a-f0-9]{24}$/).parse(id);
  if (!["list", "enrich"].includes(action) && !id) throw new Error(`${action} requires an entity ID`);
  if (payload && action !== "set") throw new Error("Unexpected extra argument");
  await loadStory(storyPaths(root, story, 1).storyConfig);
  if (action === "list" && id) throw new Error("List does not accept an entity ID");
  const bible = await getStoryBible(root, story);
  const entity = bible.canonicalEntities.find(item => item.id === id);
  if (id && !entity) throw new Error("Canonical entity was not found");
  if (action === "list" || action === "show") { stdout(JSON.stringify(action === "show" ? entity : bible.canonicalEntities, null, 2) + "\n"); return; }
  if (action === "set" || action === "clear") {
    if (action === "set" && !payload) throw new Error("Set requires pronunciation JSON");
    const pronunciation = action === "clear" ? null : pronunciationSchema.parse({ ...JSON.parse(payload!), source: "manual", updatedAt: new Date().toISOString() });
    stdout(JSON.stringify(await ops.updateCanonicalEntity(story, id!, { pronunciation }), null, 2) + "\n"); return;
  }
  const job = action === "test" ? ops.startPronunciationTest(story, id!) : ops.startPronunciationEnrichment(story, { ...(id ? { entityId: id } : {}), force, dryRun });
  const finished = await new Promise<Job>((resolve, reject) => {
    let stop: (() => void) | undefined;
    stop = ops.jobs.subscribe(job.id, next => { if (["completed", "failed", "paused"].includes(next.status)) { stop?.(); resolve(next); } });
    if (!stop) reject(new Error("Pronunciation job was not found"));
  });
  if (finished.status !== "completed") throw new Error(finished.error ?? "Pronunciation job failed");
  stdout(JSON.stringify(finished.result, null, 2) + "\n");
}
async function main() {
  const env = loadEnvironment(), root = resolveStudioRoot(env), ops = new StudioOperations(root, env);
  try { await runPronunciation(process.argv.slice(2), root, ops, text => process.stdout.write(text)); }
  finally { await ops.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
