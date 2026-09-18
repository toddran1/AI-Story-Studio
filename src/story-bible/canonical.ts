import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CanonicalEntity, EntityType, StoryBible, canonicalEntitySchema, localizedNamingSchema, storyBibleSchema } from "../domain/story-bible.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { normalizeEntityStatus, statusKey } from "./entity-status.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { normalizeEntityName } from "./updater.js";
import { rebuildStoryBibleBeforeChapter } from "./rebuild.js";

const overrideSchema = z.object({ canonicalName: z.string().trim().min(1).max(300).optional(), aliases: z.array(z.string().trim().min(1).max(300)).max(100).optional(), canonicalNameLocked: z.boolean().optional(), notes: z.string().max(10_000).optional(), status: z.string().max(500).optional(), preferredNarrationName: z.string().trim().min(1).max(300).nullable().optional(), aliasNarrationRules: canonicalEntitySchema.shape.aliasNarrationRules.optional(), localizedNaming: localizedNamingSchema.nullable().optional(), pronunciation: canonicalEntitySchema.shape.pronunciation.unwrap().nullable().optional(), snapshot: canonicalEntitySchema.optional(), updatedAt: z.string() });
const manualMergeSchema = z.object({ id: z.string().uuid(), targetEntityId: z.string(), sourceEntityIds: z.array(z.string()).min(1), reason: z.string().min(1), createdAt: z.string(), undoneAt: z.string().optional() });
export const manualDemotionSchema = z.object({
  entityId: z.string(),
  name: z.string(),
  originalName: z.string().optional(),
  type: canonicalEntitySchema.shape.type.optional(),
  parentEntityId: z.string().optional(),
  reason: z.string(),
  demotedAt: z.string(),
  source: z.enum(["manual", "analyzer", "ai"]).default("manual"),
});
export type ManualDemotion = z.infer<typeof manualDemotionSchema>;

export const manualPromotionSchema = z.object({
  referenceId: z.string(),
  name: z.string(),
  promotedAt: z.string(),
  reason: z.string(),
  source: z.enum(["manual", "analyzer", "ai"]).default("manual"),
});
export type ManualPromotion = z.infer<typeof manualPromotionSchema>;

export const canonicalOverlaySchema = z.object({
  version: z.literal(1),
  overrides: z.record(z.string(), overrideSchema).default({}),
  merges: z.array(manualMergeSchema).default([]),
  demotions: z.array(manualDemotionSchema).default([]),
  promotions: z.array(manualPromotionSchema).default([]),
  parentAssignments: z.record(z.string(), z.string()).default({}),
});
export type CanonicalOverlay = z.infer<typeof canonicalOverlaySchema>;
export { type DuplicateSuggestion, findDuplicateSuggestions, duplicateScore } from "./duplicate-detection.js";

export async function applyCanonicalOverlay(root: string, slug: string, input: StoryBible) {
  const paths = storyPaths(root, slug, 1);
  const overlay = canonicalOverlaySchema.parse(
    (await readJsonIfExists(paths.bibleCanonicalManual)) ?? {
      version: 1,
      overrides: {},
      merges: [],
      demotions: [],
      promotions: [],
      parentAssignments: {},
    },
  );
  const bible = structuredClone(input);
  const demotedIds = new Set(overlay.demotions.map((item) => item.entityId));
  const demotedNames = new Set(overlay.demotions.map((item) => normalizeEntityName(item.name)).filter(Boolean));

  const present = new Set(bible.canonicalEntities.map((entity) => entity.id));
  for (const entity of bible.canonicalEntities) {
    const value = overlay.overrides[entity.id];
    if (value) applyOverride(entity, value);
  }

  // Automatic extraction can be rebuilt from a shorter chapter range. A protected
  // record must not silently disappear in that case: its last validated snapshot
  // remains visible until a later extraction recognizes the identity again.
  // Demoted entities must never be resurrected by orphan snapshot recovery.
  for (const [id, value] of Object.entries(overlay.overrides)) {
    const snapshotName = value.snapshot ? normalizeEntityName(value.snapshot.canonicalName) : "";
    if (!present.has(id) && !demotedIds.has(id) && !demotedNames.has(snapshotName) && value.snapshot) {
      bible.canonicalEntities.push(applyOverride(structuredClone(value.snapshot), value));
    }
  }

  // Apply demotions: remove from canonicalEntities and ensure recorded as minor reference
  for (const demotion of overlay.demotions) {
    const normDemoName = normalizeEntityName(demotion.name);
    const existingIndex = bible.canonicalEntities.findIndex(
      (item) => item.id === demotion.entityId || normalizeEntityName(item.canonicalName) === normDemoName,
    );
    if (existingIndex >= 0) {
      const entity = bible.canonicalEntities[existingIndex]!;
      bible.canonicalEntities.splice(existingIndex, 1);
      const refId = `ref_${entity.id.startsWith("ent_") ? entity.id.slice(4) : entity.id}`;
      const existingRef = bible.minorReferences.find(
        (item) =>
          item.id === refId ||
          item.demotedFromEntityId === entity.id ||
          normalizeEntityName(item.name) === normalizeEntityName(entity.canonicalName),
      );
      const parentId = demotion.parentEntityId ?? overlay.parentAssignments[refId] ?? overlay.parentAssignments[entity.id];
      if (!existingRef) {
        bible.minorReferences.push({
          id: refId,
          name: entity.canonicalName,
          originalName: entity.originalName || undefined,
          type: entity.type as any,
          parentEntityId: parentId || undefined,
          aliases: entity.aliases,
          firstSeenChapter: entity.firstAppearance,
          lastSeenChapter: entity.lastKnownAppearance,
          occurrenceCount: Math.max(1, entity.provenance.length),
          sourceEvidence: entity.provenance.map((p) => ({ chapter: p.chapter })),
          disposition: "minor_reference",
          source: "manual_demotion",
          status: "minor",
          demotedFromEntityId: entity.id,
          createdAt: demotion.demotedAt,
          updatedAt: demotion.demotedAt,
        });
      } else {
        existingRef.status = "minor";
        existingRef.demotedFromEntityId = entity.id;
        if (parentId && !existingRef.parentEntityId) {
          existingRef.parentEntityId = parentId;
        }
      }
    } else {
      const refId = `ref_${demotion.entityId.startsWith("ent_") ? demotion.entityId.slice(4) : demotion.entityId}`;
      const existingRef = bible.minorReferences.find(
        (item) =>
          item.id === refId ||
          item.demotedFromEntityId === demotion.entityId ||
          normalizeEntityName(item.name) === normDemoName,
      );
      const parentId = demotion.parentEntityId ?? overlay.parentAssignments[refId] ?? overlay.parentAssignments[demotion.entityId];
      if (!existingRef) {
        bible.minorReferences.push({
          id: refId,
          name: demotion.name,
          originalName: demotion.originalName || undefined,
          type: (demotion.type as any) ?? "concept",
          parentEntityId: parentId || undefined,
          aliases: overlay.overrides[demotion.entityId]?.aliases ?? [],
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          sourceEvidence: [{ chapter: 1 }],
          disposition: "minor_reference",
          source: "manual_demotion",
          status: "minor",
          demotedFromEntityId: demotion.entityId,
          createdAt: demotion.demotedAt,
          updatedAt: demotion.demotedAt,
        });
      } else {
        existingRef.status = "minor";
        existingRef.demotedFromEntityId = demotion.entityId;
        if (parentId && !existingRef.parentEntityId) {
          existingRef.parentEntityId = parentId;
        }
      }
    }
  }

  // Apply promotions: if a minor reference was promoted in overlay, promote it to canonicalEntities
  for (const promo of overlay.promotions) {
    const promoNorm = normalizeEntityName(promo.name);
    const refIndex = bible.minorReferences.findIndex(
      (r) => r.id === promo.referenceId || normalizeEntityName(r.name) === promoNorm,
    );
    const entityExists = bible.canonicalEntities.some(
      (e) => normalizeEntityName(e.canonicalName) === promoNorm || (promo.referenceId.startsWith("ref_") && e.id === `ent_${promo.referenceId.slice(4)}`),
    );
    if (refIndex >= 0) {
      const ref = bible.minorReferences[refIndex]!;
      bible.minorReferences.splice(refIndex, 1);
      if (!entityExists) {
        const entityId = ref.demotedFromEntityId || (promo.referenceId.startsWith("ref_") ? `ent_${promo.referenceId.slice(4)}` : `ent_${ref.id.slice(4)}`);
        bible.canonicalEntities.push({
          id: entityId,
          type: (ref.type && ref.type !== "other" ? ref.type : "concept") as EntityType,
          canonicalName: ref.name,
          originalName: ref.originalName || "",
          description: ref.contextNotes || "",
          aliases: ref.aliases,
          firstAppearance: ref.firstSeenChapter || 1,
          lastKnownAppearance: ref.lastSeenChapter || ref.firstSeenChapter || 1,
          status: "unknown",
          notes: "",
          canonicalNameLocked: false,
          origin: promo.source === "manual" ? "manual" : "automatic",
          provenance: ref.sourceEvidence.map((e) => ({
            chapter: e.chapter,
            kind: "extraction" as const,
            origin: promo.source === "manual" ? "manual" : "automatic",
          })),
          aliasNarrationRules: [],
          mergedFromIds: [],
        });
      }
    }
  }

  // Apply parent assignments to minor references
  for (const ref of bible.minorReferences) {
    const parentId =
      overlay.parentAssignments[ref.id] ??
      (ref.demotedFromEntityId ? overlay.parentAssignments[ref.demotedFromEntityId] : undefined);
    if (parentId !== undefined) {
      ref.parentEntityId = parentId || undefined;
    }
  }

  const available = new Set(bible.canonicalEntities.map((entity) => entity.id));
  const remap = new Map(
    [...resolveMergeMap(overlay.merges.filter((item) => !item.undoneAt))].filter(([, target]) => available.has(target)),
  );
  for (const [sourceId, targetId] of remap) {
    const target = bible.canonicalEntities.find((item) => item.id === targetId);
    const source = bible.canonicalEntities.find((item) => item.id === sourceId);
    if (!target || !source || source.id === target.id) continue;
    target.aliases = unique([...target.aliases, source.canonicalName, ...source.aliases]);
    target.description = mergeText(target.description, source.description);
    target.notes = mergeText(target.notes, source.notes);
    if (target.status === "unknown" && source.status !== "unknown") target.status = source.status;
    target.canonicalNameLocked ||= source.canonicalNameLocked;
    target.preferredNarrationName ??= source.preferredNarrationName;
    target.localizedNaming ??= source.localizedNaming;
    target.aliasNarrationRules = uniqueRules([...source.aliasNarrationRules, ...target.aliasNarrationRules]);
    target.firstAppearance = Math.min(target.firstAppearance, source.firstAppearance);
    target.lastKnownAppearance = Math.max(target.lastKnownAppearance, source.lastKnownAppearance);
    target.provenance = uniqueObjects([...target.provenance, ...source.provenance]);
    target.mergedFromIds = unique([...target.mergedFromIds, source.id, ...source.mergedFromIds]);
    target.origin = "manual";
  }
  bible.canonicalEntities = bible.canonicalEntities.filter((item) => !remap.has(item.id));
  for (const relation of bible.canonicalRelationships) {
    relation.sourceEntityId = remap.get(relation.sourceEntityId) ?? relation.sourceEntityId;
    relation.targetEntityId = remap.get(relation.targetEntityId) ?? relation.targetEntityId;
  }
  for (const event of bible.entityTimeline) {
    event.entityId = remap.get(event.entityId) ?? event.entityId;
    if (event.relatedEntityId) event.relatedEntityId = remap.get(event.relatedEntityId) ?? event.relatedEntityId;
  }
  bible.canonicalRelationships = deduplicateRelationships(bible.canonicalRelationships);
  bible.entityTimeline = uniqueObjects(bible.entityTimeline);
  bible.merges = overlay.merges;
  const canonicalNames = new Set(
    bible.canonicalEntities.flatMap((e) => [e.canonicalName, e.originalName, ...e.aliases].map(normalizeEntityName)).filter(Boolean)
  );
  bible.minorReferences = bible.minorReferences.filter((ref) => !canonicalNames.has(normalizeEntityName(ref.name)));
  return { bible: storyBibleSchema.parse(bible), overlay };
}

export async function loadStoryBibleWithCanonicalOverlay(
  root: string,
  slug: string,
  options: { includeCanonicalOverlay?: boolean } = {},
): Promise<StoryBible> {
  const paths = storyPaths(root, slug, 1);
  const raw = await readJsonIfExists<StoryBible>(paths.bible);
  const bible = raw
    ? storyBibleSchema.parse(raw)
    : await rebuildStoryBibleBeforeChapter(root, slug, Number.MAX_SAFE_INTEGER, { includeCanonicalOverlay: false });
  return options.includeCanonicalOverlay === false ? bible : (await applyCanonicalOverlay(root, slug, bible)).bible;
}

export async function requireCanonicalStoryBibleEntity(
  root: string,
  slug: string,
  entityId: string,
): Promise<CanonicalEntity> {
  canonicalEntitySchema.shape.id.parse(entityId);
  const bible = await loadStoryBibleWithCanonicalOverlay(root, slug);
  const entity = bible.canonicalEntities.find((e) => e.id === entityId);
  if (!entity) {
    throw new Error(`Canonical entity '${entityId}' was not found in Story Bible`);
  }
  return entity;
}

export async function updateCanonicalEntity(root: string, slug: string, base: StoryBible, id: string, patch: unknown) { const input = overrideSchema.omit({ updatedAt: true, snapshot: true }).partial().strict().parse(patch); const effective = await applyCanonicalOverlay(root, slug, base); const entity = effective.bible.canonicalEntities.find((item) => item.id === id); if (!entity) throw new Error("Canonical entity was not found"); if (input.status !== undefined) { const status = input.status; input.status = normalizeEntityStatus(entity.type, status); if (!input.status || statusKey(status) === "custom") throw new Error("Custom status requires a non-empty story-specific value"); } const paths = storyPaths(root, slug, 1); const overlay = canonicalOverlaySchema.parse((await readJsonIfExists(paths.bibleCanonicalManual)) ?? { version: 1, overrides: {}, merges: [] }); const value = { ...overlay.overrides[id], ...input, updatedAt: new Date().toISOString() }; overlay.overrides[id] = { ...value, snapshot: applyOverride(structuredClone(entity), value) }; await atomicWriteJson(paths.bibleCanonicalManual, overlay); return applyCanonicalOverlay(root, slug, base); }
export async function mergeCanonicalEntities(root: string, slug: string, base: StoryBible, targetEntityId: string, sourceEntityIds: string[], reason: string) { const ids = unique(sourceEntityIds).filter((id) => id !== targetEntityId); const known = new Set(base.canonicalEntities.map((item) => item.id)); if (!known.has(targetEntityId) || !ids.length || ids.some((id) => !known.has(id))) throw new Error("Merge must reference existing distinct entities"); const paths = storyPaths(root, slug, 1); const overlay = canonicalOverlaySchema.parse((await readJsonIfExists(paths.bibleCanonicalManual)) ?? { version: 1, overrides: {}, merges: [] }); const merge = manualMergeSchema.parse({ id: randomUUID(), targetEntityId, sourceEntityIds: ids, reason, createdAt: new Date().toISOString() }); resolveMergeMap([...overlay.merges.filter((item) => !item.undoneAt), merge]); overlay.merges.push(merge); await atomicWriteJson(paths.bibleCanonicalManual, overlay); return { merge, ...(await applyCanonicalOverlay(root, slug, base)) }; }
export async function undoCanonicalMerge(root: string, slug: string, base: StoryBible, mergeId: string) { const paths = storyPaths(root, slug, 1); const overlay = canonicalOverlaySchema.parse((await readJsonIfExists(paths.bibleCanonicalManual)) ?? { version: 1, overrides: {}, merges: [] }); const merge = overlay.merges.find((item) => item.id === mergeId); if (!merge || merge.undoneAt) throw new Error("Active merge was not found"); merge.undoneAt = new Date().toISOString(); await atomicWriteJson(paths.bibleCanonicalManual, overlay); return applyCanonicalOverlay(root, slug, base); }

function applyOverride(entity: CanonicalEntity, value: z.infer<typeof overrideSchema>) {
  if (value.canonicalName) { if (normalizeEntityName(value.canonicalName) !== normalizeEntityName(entity.canonicalName)) entity.aliases = unique([entity.canonicalName, ...entity.aliases]); entity.canonicalName = value.canonicalName; }
  if (value.aliases) entity.aliases = unique(value.aliases.filter((name) => normalizeEntityName(name) !== normalizeEntityName(entity.canonicalName)));
  if (value.canonicalNameLocked !== undefined) entity.canonicalNameLocked = value.canonicalNameLocked;
  if (value.notes !== undefined) entity.notes = value.notes;
  if (value.status !== undefined) entity.status = value.status;
  if (value.preferredNarrationName !== undefined) entity.preferredNarrationName = value.preferredNarrationName ?? undefined;
  if (value.localizedNaming !== undefined) entity.localizedNaming = value.localizedNaming ?? undefined;
  if (value.pronunciation !== undefined) entity.pronunciation = value.pronunciation ?? undefined;
  if (value.aliasNarrationRules) { const aliases = new Set(entity.aliases.map(normalizeEntityName)); entity.aliasNarrationRules = uniqueRules(value.aliasNarrationRules.filter((rule) => aliases.has(normalizeEntityName(rule.alias)))); }
  entity.origin = "manual";
  return entity;
}

/** Caller holds the story lock. Upgrade older overlays without changing their preferences. */
export async function backfillCanonicalSnapshots(root: string, slug: string, base: StoryBible) {
  const path = storyPaths(root, slug, 1).bibleCanonicalManual;
  const raw = await readJsonIfExists(path);
  if (!raw) return 0;
  const overlay = canonicalOverlaySchema.parse(raw);
  let count = 0;
  for (const [id, value] of Object.entries(overlay.overrides)) {
    const entity = base.canonicalEntities.find((item) => item.id === id);
    if (!value.snapshot && entity) { value.snapshot = applyOverride(structuredClone(entity), value); count++; }
  }
  if (count) await atomicWriteJson(path, overlay);
  return count;
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
function deduplicateRelationships(values: StoryBible["canonicalRelationships"]) { const output: typeof values = []; for (const value of values) { const match = output.find((item) => item.sourceEntityId === value.sourceEntityId && item.targetEntityId === value.targetEntityId && normalizeEntityName(item.type) === normalizeEntityName(value.type)); if (!match) output.push(value); else { match.startChapter = Math.min(match.startChapter, value.startChapter); match.endChapter = match.endChapter === undefined || value.endChapter === undefined ? undefined : Math.max(match.endChapter, value.endChapter); match.state = match.state === "current" || value.state === "current" ? "current" : "historical"; match.confidence = Math.max(match.confidence ?? 0, value.confidence ?? 0) || undefined; match.locked ||= value.locked; if (value.origin === "manual") match.origin = "manual"; match.provenance = uniqueObjects([...match.provenance, ...value.provenance]); } } return output; }
function unique(values: string[]) { const seen = new Set<string>(); return values.filter((value) => { const key = value.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); if (!key || seen.has(key)) return false; seen.add(key); return true; }); }
function uniqueObjects<T>(values: T[]) { return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()]; }
function uniqueRules(values: CanonicalEntity["aliasNarrationRules"]) { return [...new Map(values.map((value) => [normalizeEntityName(value.alias), value])).values()]; }
function mergeText(left: string, right: string) { if (!right || left.includes(right)) return left; return [left, right].filter(Boolean).join(" ").slice(0, 8000); }
