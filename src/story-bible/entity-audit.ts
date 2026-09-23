import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalEntitySchema } from "../domain/story-bible.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";

export const entityAuditActionSchema = z.enum([
  "created", "updated", "renamed", "type_changed", "narration_mapping_changed",
  "localized_naming_changed", "locked", "unlocked", "merged", "merge_undone",
  "demoted", "promoted", "suppressed", "restored", "visual_profile_policy_changed",
]);
export type EntityAuditAction = z.infer<typeof entityAuditActionSchema>;

/**
 * Append-only canonical entity audit trail. Entries carry only the changed
 * fields (before/after deltas), never full bible snapshots. Historical events
 * that predate this log remain readable from their original records (merges,
 * granularity audits, provenance); nothing is backfilled or fabricated.
 */
export const entityAuditEntrySchema = z.object({
  id: z.string().min(1),
  entityId: canonicalEntitySchema.shape.id,
  action: entityAuditActionSchema,
  before: z.record(z.string(), z.unknown()).optional(),
  after: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().max(2000).optional(),
  source: z.enum(["manual", "automatic", "analyzer", "ai"]),
  timestamp: z.string(),
});
export type EntityAuditEntry = z.infer<typeof entityAuditEntrySchema>;

const MAX_ENTRIES = 5000;
const auditQueues = new Map<string, Promise<void>>();

export type EntityAuditInput = Omit<EntityAuditEntry, "id" | "timestamp"> & { timestamp?: string };

/** Serialized per story: read-modify-append under an atomic write, trimmed oldest-first. */
export async function appendEntityAudit(root: string, slug: string, entries: EntityAuditInput[]): Promise<void> {
  if (!entries.length) return;
  const path = storyPaths(root, slug, 1).bibleAudit;
  const previous = auditQueues.get(path) ?? Promise.resolve();
  const update = previous.catch(() => undefined).then(async () => {
    const existing = entityAuditLogSchema.parse((await readJsonIfExists(path)) ?? []);
    for (const entry of entries) {
      existing.push(entityAuditEntrySchema.parse({ ...entry, id: `aud_${randomUUID().replaceAll("-", "").slice(0, 24)}`, timestamp: entry.timestamp ?? new Date().toISOString() }));
    }
    await atomicWriteJson(path, existing.slice(-MAX_ENTRIES));
  });
  auditQueues.set(path, update);
  try { await update; } finally { if (auditQueues.get(path) === update) auditQueues.delete(path); }
}

const entityAuditLogSchema = z.array(entityAuditEntrySchema);

export async function readEntityAudit(root: string, slug: string, entityId?: string): Promise<EntityAuditEntry[]> {
  const entries = entityAuditLogSchema.parse((await readJsonIfExists(storyPaths(root, slug, 1).bibleAudit)) ?? []);
  const filtered = entityId ? entries.filter((entry) => entry.entityId === entityId) : entries;
  // Newest first; ties (same-millisecond appends) keep reverse append order.
  return filtered.map((entry, index) => ({ entry, index })).sort((a, b) => b.entry.timestamp.localeCompare(a.entry.timestamp) || b.index - a.index).map((item) => item.entry);
}
