import { CanonicalEntity, EntityType, StoryBible, StoryBibleUpdate, storyBibleSchema } from "../domain/story-bible.js";
import { fingerprint } from "../utils/hash.js";

type Named = { canonicalEnglishName: string; originalName: string; description: string; firstSeenChapter: number; lastSeenChapter: number; aliases?: string[]; gender?: string; pronouns?: string[] };

function mergeNamed(existing: Named[], incoming: Named[]): Named[] {
  const output = structuredClone(existing);
  for (const item of incoming) {
    const match = output.find((old) =>
      (old.originalName && item.originalName && old.originalName === item.originalName) ||
      old.canonicalEnglishName.toLocaleLowerCase() === item.canonicalEnglishName.toLocaleLowerCase(),
    );
    if (!match) { output.push(item); continue; }
    // Existing canonical English is deliberately never overwritten.
    match.firstSeenChapter = Math.min(match.firstSeenChapter, item.firstSeenChapter);
    match.lastSeenChapter = Math.max(match.lastSeenChapter, item.lastSeenChapter);
    match.description = mergeDescription(match.description, item.description);
    if (match.aliases || item.aliases) match.aliases = [...new Set([...(match.aliases ?? []), ...(item.aliases ?? []), ...(match.canonicalEnglishName !== item.canonicalEnglishName ? [item.canonicalEnglishName] : [])])];
    if (!match.gender && item.gender) match.gender = item.gender;
    if (match.pronouns || item.pronouns) match.pronouns = [...new Set([...(match.pronouns ?? []), ...(item.pronouns ?? [])])];
  }
  return output;
}

export function mergeStoryBible(existing: StoryBible, update: StoryBibleUpdate, chapter: number): StoryBible {
  const result = structuredClone(existing) as Record<string, unknown>;
  for (const key of ["characters", "locations", "factions", "abilities", "classes", "ranks", "items", "creatures", "systemTerms"] as const) {
    result[key] = mergeNamed(existing[key] as Named[], update[key] as Named[]);
  }
  result.relationships = mergeUnique(existing.relationships, update.relationships, (x) => `${x.subject}\0${x.relationship}\0${x.object}`);
  result.translationTerms = mergeTerms(existing.translationTerms, update.translationTerms);
  const canonical = mergeCanonicalHistory(existing, update, chapter);
  result.canonicalEntities = canonical.entities; result.canonicalRelationships = canonical.relationships; result.entityTimeline = canonical.timeline;
  result.chapterSummaries = { ...existing.chapterSummaries, [String(chapter)]: update.chapterSummary };
  result.version = existing.version + 1;
  return storyBibleSchema.parse(result);
}

export function normalizeStoryBibleUpdate(update: StoryBibleUpdate, chapter: number): StoryBibleUpdate {
  const normalized = structuredClone(update);
  for (const key of ["characters", "locations", "factions", "abilities", "classes", "ranks", "items", "creatures", "systemTerms", "relationships", "translationTerms"] as const) {
    for (const item of normalized[key]) { item.firstSeenChapter = chapter; item.lastSeenChapter = chapter; }
  }
  for (const event of normalized.timelineEvents) event.chapter = chapter;
  return normalized;
}

function mergeUnique<T extends { firstSeenChapter: number; lastSeenChapter: number }>(existing: T[], incoming: T[], key: (item: T) => string): T[] {
  const out = structuredClone(existing);
  for (const item of incoming) {
    const match = out.find((old) => key(old).toLowerCase() === key(item).toLowerCase());
    if (!match) out.push(item);
    else { match.firstSeenChapter = Math.min(match.firstSeenChapter, item.firstSeenChapter); match.lastSeenChapter = Math.max(match.lastSeenChapter, item.lastSeenChapter); }
  }
  return out;
}

function mergeTerms(existing: StoryBible["translationTerms"], incoming: StoryBibleUpdate["translationTerms"]) {
  const out = structuredClone(existing);
  for (const item of incoming) {
    const match = out.find((old) => old.original === item.original);
    if (!match) out.push(item);
    else {
      // Original text is the stable key; preserve its established canonical translation.
      match.firstSeenChapter = Math.min(match.firstSeenChapter, item.firstSeenChapter);
      match.lastSeenChapter = Math.max(match.lastSeenChapter, item.lastSeenChapter);
      if (item.notes && !match.notes.includes(item.notes)) match.notes = [match.notes, item.notes].filter(Boolean).join(" ");
    }
  }
  return out;
}

export function contextBeforeChapter(bible: StoryBible, chapter: number, recentSummaryCount = 5): StoryBible {
  const result = structuredClone(bible);
  for (const key of ["characters", "locations", "factions", "abilities", "classes", "ranks", "items", "creatures", "systemTerms", "relationships", "translationTerms"] as const) {
    (result[key] as Array<{ firstSeenChapter: number }>) = result[key].filter((item) => item.firstSeenChapter < chapter) as never;
  }
  result.canonicalEntities = result.canonicalEntities.filter((item) => item.firstAppearance < chapter);
  const ids = new Set(result.canonicalEntities.map((item) => item.id));
  result.canonicalRelationships = result.canonicalRelationships.filter((item) => item.startChapter < chapter && ids.has(item.sourceEntityId) && ids.has(item.targetEntityId));
  result.entityTimeline = result.entityTimeline.filter((item) => item.chapter < chapter && ids.has(item.entityId));
  const earlierSummaries = Object.entries(result.chapterSummaries)
    .filter(([number]) => Number(number) < chapter)
    .sort(([a], [b]) => Number(a) - Number(b));
  result.chapterSummaries = Object.fromEntries(recentSummaryCount === 0 ? [] : earlierSummaries.slice(-recentSummaryCount));
  // The cumulative file may include this chapter from an earlier run. Context
  // versioning must describe only prior chapters so reruns remain cache-stable.
  // This value participates in fingerprints and therefore includes the chapter
  // numbers, not merely the number of retained summaries.
  result.version = bible.version;
  return result;
}

const canonicalCategories: Array<[keyof StoryBibleUpdate, EntityType]> = [["characters", "character"], ["locations", "location"], ["factions", "organization"], ["abilities", "ability"], ["items", "item"], ["classes", "concept"], ["ranks", "concept"], ["creatures", "concept"], ["systemTerms", "concept"]];
function mergeCanonicalHistory(existing: StoryBible, update: StoryBibleUpdate, chapter: number) {
  const entities = structuredClone(existing.canonicalEntities); const relationships = structuredClone(existing.canonicalRelationships); const timeline = structuredClone(existing.entityTimeline);
  const ensure = (name: string, type: EntityType = "concept", originalName = "", description = "", aliases: string[] = [], status = "unknown", confidence?: number) => {
    const keys = new Set([name, originalName, ...aliases].map(normalizeName).filter(Boolean)); let entity = entities.find((candidate) => [candidate.canonicalName, candidate.originalName, ...candidate.aliases].some((value) => keys.has(normalizeName(value))));
    if (!entity) { entity = { id: stableId("ent", { type, identity: normalizeName(originalName || name) }), type, canonicalName: name, aliases: uniqueNames([name, ...aliases]).filter((value) => normalizeName(value) !== normalizeName(name)), originalName, description, aliasNarrationRules: [], firstAppearance: chapter, lastKnownAppearance: chapter, status, notes: "", canonicalNameLocked: false, origin: "automatic", provenance: [], mergedFromIds: [] }; entities.push(entity); }
    else { entity.firstAppearance = Math.min(entity.firstAppearance, chapter); entity.lastKnownAppearance = Math.max(entity.lastKnownAppearance, chapter); if (entity.type === "concept" && type !== "concept") entity.type = type; entity.aliases = uniqueNames([...entity.aliases, ...aliases, ...(normalizeName(name) !== normalizeName(entity.canonicalName) ? [name] : [])]); entity.description = mergeDescription(entity.description, description); if (!entity.originalName && originalName) entity.originalName = originalName; if (status && status !== "unknown" && status !== entity.status) { addTimeline(timeline, entity.id, chapter, "status_change", `${entity.canonicalName}: ${entity.status} → ${status}`, undefined, status, confidence); entity.status = status; } }
    addProvenance(entity, chapter, "extraction", confidence); return entity;
  };
  for (const [category, type] of canonicalCategories) for (const raw of update[category] as Array<any>) { const entity = ensure(raw.canonicalEnglishName, type, raw.originalName, raw.description, raw.aliases ?? [], raw.status ?? "unknown", raw.confidence); addTimeline(timeline, entity.id, chapter, "appearance", `${entity.canonicalName} appears`, undefined, undefined, raw.confidence); }
  for (const raw of update.relationships) { const source = ensure(raw.subject); const target = ensure(raw.object); const key = `${source.id}\0${normalizeName(raw.relationship)}\0${target.id}`; let relation = relationships.find((item) => `${item.sourceEntityId}\0${normalizeName(item.type)}\0${item.targetEntityId}` === key); const provenance = { chapter, kind: "relationship" as const, confidence: raw.confidence, origin: "automatic" as const };
    if (!relation) { relation = { id: stableId("rel", { key }), sourceEntityId: source.id, targetEntityId: target.id, type: raw.relationship, startChapter: chapter, endChapter: raw.endChapter, state: raw.state ?? "current", confidence: raw.confidence, provenance: [provenance], locked: raw.locked ?? false, origin: "automatic" }; relationships.push(relation); }
    else { if (!relation.locked) { relation.endChapter = raw.endChapter ?? relation.endChapter; relation.state = raw.state ?? relation.state; relation.confidence = raw.confidence ?? relation.confidence; } if (!relation.provenance.some((item) => item.chapter === chapter)) relation.provenance.push(provenance); }
  }
  for (const raw of update.timelineEvents) { const entity = ensure(raw.entity); const related = raw.relatedEntity ? ensure(raw.relatedEntity) : undefined; addTimeline(timeline, entity.id, chapter, raw.type, raw.summary, related?.id, raw.status, raw.confidence); if (raw.status && raw.status !== entity.status) entity.status = raw.status; }
  return { entities, relationships, timeline };
}

function addTimeline(timeline: StoryBible["entityTimeline"], entityId: string, chapter: number, type: StoryBible["entityTimeline"][number]["type"], summary: string, relatedEntityId?: string, status?: string, confidence?: number) { const id = stableId("evt", { entityId, chapter, type, summary: normalizeName(summary), relatedEntityId }); if (timeline.some((item) => item.id === id)) return; timeline.push({ id, entityId, chapter, type, summary, relatedEntityId, status, confidence, origin: "automatic", provenance: { chapter, kind: "event", confidence, origin: "automatic" } }); }
function addProvenance(entity: CanonicalEntity, chapter: number, kind: "extraction", confidence?: number) { if (!entity.provenance.some((item) => item.chapter === chapter && item.kind === kind)) entity.provenance.push({ chapter, kind, confidence, origin: "automatic" }); }
function stableId(prefix: "ent" | "rel" | "evt", value: unknown) { return `${prefix}_${fingerprint(value).slice(0, 24)}`; }
export function normalizeEntityName(value: string) { return normalizeName(value); }
function normalizeName(value: string) { return value.normalize("NFKD").toLocaleLowerCase().replace(/\b(?:doctor|dr|young master|master|elder|lord|lady|sir|miss|mr|mrs)\b/gu, "").replace(/[^\p{L}\p{N}]/gu, ""); }
function uniqueNames(values: string[]) { const seen = new Set<string>(); return values.filter((value) => { const key = value.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); if (!key || seen.has(key)) return false; seen.add(key); return true; }); }

function mergeDescription(existing: string, incoming: string): string {
  if (!incoming) return existing;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  if (normalize(existing).includes(normalize(incoming))) return existing;
  const combined = [existing.trim(), incoming.trim()].filter(Boolean).join(" ");
  return combined.length <= 4000 ? combined : `${combined.slice(0, 3999).trimEnd()}…`;
}
