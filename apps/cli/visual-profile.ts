#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { StudioOperations } from "../server/operations.js";

type Action = "inspect" | "generate-missing" | "reference" | "approve-reference";

function usage(message?: string): never {
  throw new Error(`${message ? `${message}\n` : ""}Usage: story:visual-profile inspect|generate-missing|reference|approve-reference <story> --entity <entity-id> [--fields field,field] [--regenerate] [--dry-run] [--ref <reference-id>] [--primary]`);
}

function parse(values: string[]) {
  const [action, story, ...rest] = values as [Action | undefined, string | undefined, ...string[]];
  if (!action || !["inspect", "generate-missing", "reference", "approve-reference"].includes(action) || !story) usage();
  let entity = "", fields: string[] | undefined, regenerate = false, dryRun = false, ref = "", primary = false;
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]!;
    if (value === "--regenerate") { regenerate = true; continue; }
    if (value === "--dry-run") { dryRun = true; continue; }
    if (value === "--primary") { primary = true; continue; }
    const next = rest[++index];
    if (!next) usage(`Missing value for ${value}`);
    if (value === "--entity") entity = next;
    else if (value === "--fields") fields = next.split(",").map((field) => field.trim()).filter(Boolean);
    else if (value === "--ref") ref = next;
    else usage(`Unknown argument: ${value}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(story)) usage("Story must be a lowercase kebab-case slug");
  if (!/^ent_[a-f0-9]{24}$/.test(entity)) usage("--entity must be a canonical entity ID");
  if (action === "approve-reference" && !/^[A-Za-z0-9_-]+$/.test(ref)) usage("approve-reference requires --ref <reference-id>");
  return { action, story, entity, fields, regenerate, dryRun, ref, primary };
}

async function main() {
  const args = parse(process.argv.slice(2));
  const env = loadEnvironment();
  const operations = new StudioOperations(resolveStudioRoot(env), env);
  try {
    if (args.action === "inspect") {
      process.stdout.write(`${JSON.stringify(await operations.inspectVisualProfile(args.story, args.entity), null, 2)}\n`);
      return;
    }
    if (args.action === "generate-missing") {
      if (args.dryRun) {
        const inspected = await operations.inspectVisualProfile(args.story, args.entity);
        process.stdout.write(`${JSON.stringify({ dryRun: true, eligibleFields: args.fields ?? inspected.eligibleFields, protectedFields: inspected.protectedFields, coreComplete: inspected.coreComplete, coreTotal: inspected.coreTotal }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify(await operations.proposeVisualProfile(args.story, args.entity, { fields: args.fields, regenerate: args.regenerate }), null, 2)}\n`);
      return;
    }
    if (args.action === "reference") {
      if (args.dryRun) {
        const inspected = await operations.inspectVisualProfile(args.story, args.entity);
        process.stdout.write(`${JSON.stringify({ dryRun: true, entityId: args.entity, visualType: inspected.profile.visualType, referenceCount: inspected.profile.references.length, note: "Would generate a review-required provider-neutral reference from the stored profile and active art direction." }, null, 2)}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify(await operations.generateStyleSheet(args.story, args.entity), null, 2)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(await operations.approveVisualReference(args.story, args.entity, args.ref, { primary: args.primary }), null, 2)}\n`);
  } finally {
    await operations.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
