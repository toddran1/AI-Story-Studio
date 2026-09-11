import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CanonicalEntity, StoryBible, canonicalEntitySchema, storyBibleSchema } from "../domain/story-bible.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { normalizeEntityName } from "./updater.js";

const overrideSchema = z.object({ canonicalName: z.string().min(1).optional(), aliases: z.array(z.string()).optional(), canonicalNameLocked: z.boolean().optional(), notes: z.string().optional(), status: z.string().optional(), updatedAt: z.string() });
const manualMergeSchema = z.object({ id: z.string().uuid(), targetEntityId: z.string(), sourceEntityIds: z.array(z.string()).min(1), reason: z.string().min(1), createdAt: z.string(), undoneAt: z.string().optional() });
export const canonicalOverlaySchema = z.object({ version: z.literal(1), overrides: z.record(z.string(), overrideSchema).default({}), merges: z.array(manualMergeSchema).default([]) });
export type DuplicateSuggestion = { id: string; entityIds: [string, string]; entities: [{ id: string; name: string }, { id: string; name: string }]; confidence: number; reason: string; supportingChapters: number[] };

export async function applyCanonicalOverlay(root: string, slug: string, input: StoryBible) {
  const paths = storyPaths(root, slug, 1); const overlay = canonicalOverlaySchema.parse((await readJsonIfExists(paths.bibleCanonicalManual)) ?? { version: 1, overrides: {}, merges: [] }); const bible = structuredClone(input);
  for (const entity of bible.canonicalEntities) { const value = overlay.overrides[entity.id]; if (!value) continue; if (value.canonicalName) { if (normalizeEntityName(value.canonicalName) !== normalizeEntityName(entity.canonicalName)) entity.aliases = unique([entity.canonicalName, ...entity.aliases]); entity.canonicalName = value.canonicalName; } if (value.aliases) entity.aliases = unique(value.aliases.filter((name) => normalizeEntityName(name) !== normalizeEntityName(entity.canonicalName))); if (value.canonicalNameLocked !== undefined) entity.canonicalNameLocked = value.canonicalNameLocked; if (value.notes !== undefined) entity.notes = value.notes; if (value.status !== undefined) entity.status = value.status; entity.origin = "manual"; }
  const remap = resolveMergeMap(overlay.merges.filter((item) => !item.undoneAt));
  for (const [sourceId, targetId] of remap) {
    const target = bible.canonicalEntities.find((item) => item.id === targetId); const source = bible.canonicalEntities.find((item) => item.id === sourceId);
    if (!target || !source || source.id === target.id) continue;
    target.aliases = unique([...target.aliases, source.canonicalName, ...source.aliases]); target.description = mergeText(target.description, source.description); target.notes = mergeText(target.notes, source.notes); if (target.status === "unknown" && source.status !== "unknown") target.status = source.status; target.canonicalNameLocked ||= source.canonicalNameLocked; target.firstAppearance = Math.min(target.firstAppearance, source.firstAppearance); target.lastKnownAppearance = Math.max(target.lastKnownAppearance, source.lastKnownAppearance); target.provenance = uniqueObjects([...target.provenance, ...source.provenance]); target.mergedFromIds = unique([...target.mergedFromIds, source.id, ...source.mergedFromIds]); target.origin = "manual";
  }
  bible.canonicalEntities = bible.canonicalEntities.filter((item) => !remap.has(item.id));
  for (const relation of bible.canonicalRelationships) { relation.sourceEntityId = remap.get(relation.sourceEntityId) ?? relation.sourceEntityId; relation.targetEntityId = remap.get(relation.targetEntityId) ?? relation.targetEntityId; }
  for (const event of bible.entityTimeline) { event.entityId = remap.get(event.entityId) ?? event.entityId; if (event.relatedEntityId) event.relatedEntityId = remap.get(event.relatedEntityId) ?? event.relatedEntityId; }
  bible.canonicalRelationships = deduplicateRelationships(bible.canonicalRelationships); bible.entityTimeline = uniqueObjects(bible.entityTimeline); bible.merges = overlay.merges;
  return { bible: storyBibleSchema.parse(bible), overlay };
}

export async function updateCanonicalEntity(root: string, slug: string, base: StoryBible, id: string, patch: unknown) { const input = overrideSchema.omit({ updatedAt: true }).partial().strict().parse(patch); if (!base.canonicalEntities.some((item) => item.id === id)) throw new Error("Canonical entity was not found"); const paths = storyPaths(root, slug, 1); const overlay = canonicalOverlaySchema.parse((await readJsonIfExists(paths.bibleCanonicalManual)) ?? { version: 1, overrides: {}, merges: [] }); overlay.overrides[id] = { ...overlay.overrides[id], ...input, updatedAt: new Date().toISOString() }; await atomicWriteJson(paths.bibleCanonicalManual, overlay); return applyCanonicalOverlay(root, slug, base); }
export async function mergeCanonicalEntities(root: string, slug: string, base: StoryBible, targetEntityId: string, sourceEntityIds: string[], reason: string) { const ids = unique(sourceEntityIds).filter((id) => id !== targetEntityId); const known = new Set(base.canonicalEntities.map((item) => item.id)); if (!known.has(targetEntityId) || !ids.length || ids.some((id) => !known.has(id))) throw new Error("Merge must reference existing distinct entities"); const paths = storyPaths(root, slug, 1); const overlay = canonicalOverlaySchema.parse((await readJsonIfExists(paths.bibleCanonicalManual)) ?? { version: 1, overrides: {}, merges: [] }); const merge = manualMergeSchema.parse({ id: randomUUID(), targetEntityId, sourceEntityIds: ids, reason, createdAt: new Date().toISOString() }); resolveMergeMap([...overlay.merges.filter((item) => !item.undoneAt), merge]); overlay.merges.push(merge); await atomicWriteJson(paths.bibleCanonicalManual, overlay); return { merge, ...(await applyCanonicalOverlay(root, slug, base)) }; }
export async function undoCanonicalMerge(root: string, slug: string, base: StoryBible, mergeId: string) { const paths = storyPaths(root, slug, 1); const overlay = canonicalOverlaySchema.parse((await readJsonIfExists(paths.bibleCanonicalManual)) ?? { version: 1, overrides: {}, merges: [] }); const merge = overlay.merges.find((item) => item.id === mergeId); if (!merge || merge.undoneAt) throw new Error("Active merge was not found"); merge.undoneAt = new Date().toISOString(); await atomicWriteJson(paths.bibleCanonicalManual, overlay); return applyCanonicalOverlay(root, slug, base); }

export function findDuplicateSuggestions(entities: CanonicalEntity[]): DuplicateSuggestion[] {
  const positions = new Map(entities.map((entity, index) => [entity.id, index]));
  const records = entities.flatMap((entity) => [entity.canonicalName, entity.originalName, ...entity.aliases].map(normalizeEntityName).filter(Boolean).map((name) => ({ name, entity }))).sort((a, b) => a.name.localeCompare(b.name));
  const pairs = new Map<string, [CanonicalEntity, CanonicalEntity]>();
  // Equal names are adjacent, and prefix/suffix candidates occur near each other in
  // lexical order. A small window avoids the previous all-pairs O(n²) browser cost.
  for (let left = 0; left < records.length; left++) for (let right = left + 1; right < Math.min(records.length, left + 9); right++) {
    const a = records[left]!.entity, b = records[right]!.entity; if (a.id === b.id || a.type !== b.type) continue;
    const ids = [a.id, b.id].sort(); pairs.set(`${ids[0]}:${ids[1]}`, (positions.get(a.id) ?? 0) <= (positions.get(b.id) ?? 0) ? [a, b] : [b, a]);
  }
  const output: DuplicateSuggestion[] = [];
  for (const [id, [a, b]] of pairs) { const score = duplicateScore(a, b); if (score.confidence < .72) continue; output.push({ id, entityIds: [a.id, b.id], entities: [{ id: a.id, name: a.canonicalName }, { id: b.id, name: b.canonicalName }], confidence: score.confidence, reason: score.reason, supportingChapters: unique([...a.provenance, ...b.provenance].map((item) => String(item.chapter))).map(Number).sort((x, y) => x - y).slice(0, 20) }); }
  return output.sort((a, b) => b.confidence - a.confidence);
}
function resolveMergeMap(merges: Array<z.infer<typeof manualMergeSchema>>) {
  const direct = new Map<string, string>();
  for (const merge of merges) for (const sourceId of merge.sourceEntityIds) {
    if (sourceId === merge.targetEntityId) throw new Error("Entity merge would create a cycle");
    const existing = direct.get(sourceId);
    if (existing && existing !== merge.targetEntityId) throw new Error(`Entity ${sourceId} is already merged into another target`);
    direct.set(sourceId, merge.targetEntityId);
  }
  const resolved = new Map<string, string>();
  for (const sourceId of direct.keys()) {
    const seen = new Set<string>([sourceId]); let targetId = direct.get(sourceId)!;
    while (direct.has(targetId)) {
      if (seen.has(targetId)) throw new Error("Entity merge would create a cycle");
      seen.add(targetId); targetId = direct.get(targetId)!;
    }
    if (seen.has(targetId)) throw new Error("Entity merge would create a cycle");
    resolved.set(sourceId, targetId);
  }
  return resolved;
}
function duplicateScore(a: CanonicalEntity, b: CanonicalEntity) { const left = [a.canonicalName, a.originalName, ...a.aliases].map(normalizeEntityName).filter(Boolean); const right = [b.canonicalName, b.originalName, ...b.aliases].map(normalizeEntityName).filter(Boolean); if (left.some((value) => right.includes(value))) return { confidence: .99, reason: "Exact normalized canonical name or alias" }; if (left.some((x) => right.some((y) => Math.min(x.length, y.length) >= 2 && (x.endsWith(y) || y.endsWith(x) || x.startsWith(y) || y.startsWith(x))))) return { confidence: .82, reason: "Names share a normalized core after titles and punctuation are removed" }; return { confidence: 0, reason: "" }; }
function deduplicateRelationships(values: StoryBible["canonicalRelationships"]) { const output: typeof values = []; for (const value of values) { const match = output.find((item) => item.sourceEntityId === value.sourceEntityId && item.targetEntityId === value.targetEntityId && normalizeEntityName(item.type) === normalizeEntityName(value.type)); if (!match) output.push(value); else { match.startChapter = Math.min(match.startChapter, value.startChapter); match.endChapter = match.endChapter === undefined || value.endChapter === undefined ? undefined : Math.max(match.endChapter, value.endChapter); match.state = match.state === "current" || value.state === "current" ? "current" : "historical"; match.confidence = Math.max(match.confidence ?? 0, value.confidence ?? 0) || undefined; match.locked ||= value.locked; if (value.origin === "manual") match.origin = "manual"; match.provenance = uniqueObjects([...match.provenance, ...value.provenance]); } } return output; }
function unique(values: string[]) { const seen = new Set<string>(); return values.filter((value) => { const key = value.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); if (!key || seen.has(key)) return false; seen.add(key); return true; }); }
function uniqueObjects<T>(values: T[]) { return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()]; }
function mergeText(left: string, right: string) { if (!right || left.includes(right)) return left; return [left, right].filter(Boolean).join(" ").slice(0, 8000); }
