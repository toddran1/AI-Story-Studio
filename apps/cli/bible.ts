#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { getCanonicalEntitiesPage, getCanonicalEntityDetail, getMinorReferencesPage, getStoryBible } from "../server/catalog.js";
import { StudioOperations } from "../server/operations.js";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { loadImportedChapters } from "../../src/source/importer.js";
import { rebuildStoryBibleBeforeChapter } from "../../src/story-bible/rebuild.js";
import { withStoryLock } from "../../src/storage/story-lock.js";

type Command =
  | { action: "list"; story: string; type?: string; query?: string }
  | { action: "show"; story: string; id: string }
  | { action: "edit"; story: string; id: string; patch: Record<string, unknown> }
  | { action: "merge"; story: string; target: string; sources: string[]; reason: string }
  | { action: "undo"; story: string; mergeId: string }
  | { action: "rebuild"; story: string; through?: number }
  | { action: "analyze"; story: string; json?: boolean }
  | { action: "cleanup"; story: string; highConfidence?: boolean; apply?: boolean; json?: boolean }
  | { action: "demote"; story: string; entityId: string; parent?: string; reason?: string; force?: boolean }
  | { action: "promote"; story: string; referenceId: string; reason?: string }
  | { action: "references"; story: string; parent?: string; type?: string; query?: string };

const slug = (value: string) => { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error("Story must be a valid slug"); return value; };
const json = (value: string) => { try { const parsed = JSON.parse(value); if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(); return parsed as Record<string, unknown>; } catch { throw new Error("--json must be a JSON object"); } };
export function parseBibleArgs(v: string[]): Command {
  const [action, storyRaw, id, ...rest] = v;
  const story = storyRaw && slug(storyRaw);
  if (!action || !story) throw new Error("Usage: story:bible <list|show|edit|merge|undo|rebuild|analyze|cleanup|demote|promote|references> <story> ...");
  if (action === "list") return { action, story, ...options(id ? [id, ...rest] : []) };
  if (action === "show") { if (!id || rest.length) throw new Error("Show requires an entity ID"); return { action, story, id }; }
  if (action === "edit") { if (!id || rest[0] !== "--json" || !rest[1] || rest.length !== 2) throw new Error("Edit requires <entity-id> --json '{...}'"); return { action, story, id, patch: json(rest[1]) }; }
  if (action === "merge") { const o = options(rest); if (!id || !o.target || !o.sources || !o.reason) throw new Error("Merge requires --target <entity-id> --sources id,id --reason text"); return { action, story, target: o.target, sources: o.sources.split(",").filter(Boolean), reason: o.reason }; }
  if (action === "undo") { if (!id || rest.length) throw new Error("Undo requires a merge ID"); return { action, story, mergeId: id }; }
  if (action === "rebuild") { const o = options(id ? [id, ...rest] : []); return { action, story, through: o.through ? integer(o.through, "--through") : undefined }; }
  if (action === "analyze") {
    const rawOpts = id ? [id, ...rest] : [];
    return { action, story, json: rawOpts.includes("--json") };
  }
  if (action === "cleanup") {
    const rawOpts = id ? [id, ...rest] : [];
    return {
      action,
      story,
      highConfidence: rawOpts.includes("--high-confidence"),
      apply: rawOpts.includes("--apply"),
      json: rawOpts.includes("--json"),
    };
  }
  if (action === "demote") {
    if (!id) throw new Error("Demote requires an entity ID: story:bible demote <story> <entity-id> [--parent <parent-id>] [--reason text] [--force]");
    const o = options(rest);
    return { action, story, entityId: id, parent: o.parent, reason: o.reason, force: rest.includes("--force") };
  }
  if (action === "promote") {
    if (!id) throw new Error("Promote requires a reference ID: story:bible promote <story> <ref-id> [--reason text]");
    const o = options(rest);
    return { action, story, referenceId: id, reason: o.reason };
  }
  if (action === "references") {
    const o = options(id ? [id, ...rest] : []);
    return { action, story, parent: o.parent, type: o.type, query: o.query };
  }
  throw new Error(`Unknown Story Bible action: ${action}`);
}

function options(v: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < v.length; i++) {
    const key = v[i];
    if (key?.startsWith("--")) {
      const next = v[i + 1];
      if (next && !next.startsWith("--")) {
        out[key.slice(2)] = next;
        i++;
      } else {
        out[key.slice(2)] = "true";
      }
    }
  }
  return out;
}

function integer(value: string, label: string) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`); return n; }

async function main() {
  const command = parseBibleArgs(process.argv.slice(2));
  const env = loadEnvironment(), root = resolveStudioRoot(env), operations = new StudioOperations(root, env);
  try {
    await runBibleCommand(command, { root, operations, stdout: (t) => process.stdout.write(t) });
  } finally {
    await operations.close();
  }
}

export async function runBibleCommand(
  command: Command,
  d: {
    root: string;
    operations: Pick<StudioOperations, "updateCanonicalEntity" | "mergeCanonicalEntities" | "undoCanonicalMerge" | "analyzeStoryBible" | "applyCleanupRecommendations" | "demoteCanonicalEntity" | "promoteMinorReference">;
    stdout: (text: string) => unknown;
  },
) {
  if (command.action === "list") {
    const page = await getCanonicalEntitiesPage(d.root, command.story, { page: 1, pageSize: 100, type: command.type, query: command.query });
    d.stdout(page.items.length ? page.items.map((x) => `${x.id}\t${x.type}\t${x.canonicalName}`).join("\n") + "\n" : "No canonical entities found.\n");
    return;
  }
  if (command.action === "show") return void d.stdout(JSON.stringify(await getCanonicalEntityDetail(d.root, command.story, command.id), null, 2) + "\n");
  if (command.action === "edit") return void d.stdout(JSON.stringify(await d.operations.updateCanonicalEntity(command.story, command.id, command.patch), null, 2) + "\n");
  if (command.action === "merge") return void d.stdout(JSON.stringify(await d.operations.mergeCanonicalEntities(command.story, { targetEntityId: command.target, sourceEntityIds: command.sources, reason: command.reason }), null, 2) + "\n");
  if (command.action === "undo") return void d.stdout(JSON.stringify(await d.operations.undoCanonicalMerge(command.story, command.mergeId), null, 2) + "\n");
  if (command.action === "analyze") {
    const report = await d.operations.analyzeStoryBible(command.story);
    if (command.json) {
      d.stdout(JSON.stringify(report, null, 2) + "\n");
      return;
    }
    const lines = [
      "Story Bible Analysis",
      "",
      `Canonical entities:         ${report.totalCanonical}`,
      "",
      `Keep canonical:             ${report.keepCanonicalCount}`,
      `Convert to minor reference: ${report.convertMinorCount}`,
      `Merge existing:             ${report.mergeExistingCount}`,
      `Possible duplicates:        ${report.possibleDuplicatesCount}`,
      `Needs review:               ${report.needsReviewCount}`,
      "",
      `Protected manual entities:  ${report.protectedCount}`,
      "",
      "No changes made.",
    ];
    d.stdout(lines.join("\n") + "\n");
    return;
  }
  if (command.action === "cleanup") {
    if (!command.apply) {
      const report = await d.operations.analyzeStoryBible(command.story);
      const safeCount = report.recommendations.filter((r) => r.safeToAutoApply).length;
      if (command.json) {
        d.stdout(JSON.stringify({ dryRun: true, report, safeRecommendationsCount: safeCount }, null, 2) + "\n");
        return;
      }
      d.stdout(`Story Bible Cleanup (Dry Run)\n\nEligible safe recommendations: ${safeCount}\nTo apply, re-run with --apply (and optionally --high-confidence).\n`);
      return;
    }
    const result = await d.operations.applyCleanupRecommendations(command.story, {
      highConfidenceOnly: command.highConfidence,
    });
    if (command.json) {
      d.stdout(JSON.stringify(result, null, 2) + "\n");
      return;
    }
    d.stdout(`Story Bible Cleanup Applied\n\nDemoted to minor references: ${result.appliedDemotionsCount}\nMerged duplicates:           ${result.appliedMergesCount}\nSkipped protected records:   ${result.skippedProtectedCount}\n`);
    d.stdout(`Story Bible Cleanup Applied\n\nDemoted to minor references: ${result.appliedDemotionsCount}\nMerged duplicates:           ${result.appliedMergesCount}\nSkipped protected records:   ${result.skippedProtectedCount}\nFailed actions:              ${result.failedCount}\n`);
    return;
  }
  if (command.action === "demote") {
    const result = await d.operations.demoteCanonicalEntity(command.story, command.entityId, {
      parentEntityId: command.parent,
      reason: command.reason,
      force: command.force,
    });
    d.stdout(`Demoted canonical entity ${command.entityId} to minor reference ${result.referenceId}.\n`);
    return;
  }
  if (command.action === "promote") {
    const result = await d.operations.promoteMinorReference(command.story, command.referenceId, {
      reason: command.reason,
    });
    d.stdout(`Promoted minor reference ${command.referenceId} to canonical entity ${result.entity.id} (${result.entity.canonicalName}).\n`);
    return;
  }
  if (command.action === "references") {
    const page = await getMinorReferencesPage(d.root, command.story, { page: 1, pageSize: 100, parentEntityId: command.parent, type: command.type, query: command.query });
    d.stdout(page.items.length ? page.items.map((x) => `${x.id}\t${x.type ?? "other"}\t${x.name}${x.parentEntityName ? ` (parent: ${x.parentEntityName})` : ""}`).join("\n") + "\n" : "No minor references found.\n");
    return;
  }
  await withStoryLock(d.root, command.story, "Story Bible rebuild", async () => {
    const chapters = (await loadImportedChapters(d.root, command.story)).chapters.map((x) => x.chapter);
    const last = command.through ?? Math.max(...chapters);
    if (!last) throw new Error("Story has no imported chapters");
    const bible = await rebuildStoryBibleBeforeChapter(d.root, command.story, last + 1);
    d.stdout(JSON.stringify({ rebuiltThroughChapter: last, entities: bible.canonicalEntities.length, minorReferences: bible.minorReferences?.length ?? 0 }, null, 2) + "\n");
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{process.stderr.write(`${e instanceof Error?e.message:String(e)}\n`);process.exitCode=1;});
