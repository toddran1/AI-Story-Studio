import type { CanonicalEntity, ExtractedVisualObservation, VisualEvidence } from "../domain/story-bible.js";
import { fingerprint } from "../utils/hash.js";

/** Normalize only equivalences we can establish without interpreting prose. */
export function normalizeVisualValue(field: string, value: string): string {
  const text = value.normalize("NFKC").toLocaleLowerCase().replace(/[‐‑‒–—-]/g, " ").replace(/\s+/g, " ").trim().replace(/[.!]$/, "");
  if (field === "character.hairColor" || field === "character.eyeColor") {
    const simple = /^(?:(?:ink|jet|dark) )?(black|brown|blue|green|red|white|silver|gold|blond|blonde|gray|grey|purple|violet|amber|hazel)(?: (?:hair|eyes?))?$/.exec(text)?.[1];
    if (simple) return simple === "grey" ? "gray" : simple === "blonde" ? "blond" : simple;
  }
  return text;
}

export function mergeEntityVisualEvidence(entity: CanonicalEntity, observation: ExtractedVisualObservation, chapter: number): void {
  const records = entity.visualEvidence ??= [];
  const normalizedValue = normalizeVisualValue(observation.field, observation.value);
  const provenance = { chapter, excerpt: observation.excerpt, confidence: observation.confidence };
  const latestChange = Math.max(0, ...records.filter((item) => item.field === observation.field && item.persistence === "changed" && item.chapter <= chapter).map((item) => item.chapter));
  const matching = records.find((item) => item.field === observation.field && item.normalizedValue === normalizedValue && item.persistence === observation.persistence && (observation.persistence === "temporary" ? item.chapter === chapter : item.chapter >= latestChange && item.status !== "historical"));
  if (matching) {
    matching.lastObservedChapter = Math.max(matching.lastObservedChapter, chapter);
    matching.confidence = Math.min(1, matching.confidence + (1 - matching.confidence) * observation.confidence * 0.5);
    if (!matching.provenance.some((item) => item.chapter === chapter && item.excerpt === observation.excerpt)) matching.provenance.push(provenance);
    return;
  }
  if (observation.persistence === "changed") {
    for (const item of records) if (item.field === observation.field && item.chapter < chapter && item.persistence !== "temporary") item.status = "historical";
  } else if (observation.persistence === "persistent") {
    for (const item of records) if (item.field === observation.field && item.chapter >= latestChange && item.persistence !== "temporary" && item.status !== "historical" && item.normalizedValue !== normalizedValue) item.status = "conflict";
  }
  const conflict = observation.persistence === "persistent" && records.some((item) => item.field === observation.field && item.chapter >= latestChange && item.status === "conflict");
  records.push({
    id: `ve_${fingerprint({ entityId: entity.id, field: observation.field, normalizedValue, chapter, persistence: observation.persistence }).slice(0, 24)}`,
    field: observation.field, value: observation.value, normalizedValue, chapter, lastObservedChapter: chapter,
    confidence: observation.confidence, persistence: observation.persistence,
    status: observation.persistence === "temporary" ? "temporary" : conflict ? "conflict" : "current",
    source: "source_text", provenance: [provenance],
  });
}

export type ResolvedVisualEvidence = { values: Record<string, VisualEvidence>; conflicts: Record<string, VisualEvidence[]>; temporary: VisualEvidence[] };

/** Resolve an entity at a historical chapter without mutating its evidence. */
export function resolveEntityVisualEvidence(entity: CanonicalEntity, chapter: number): ResolvedVisualEvidence {
  const byField = new Map<string, VisualEvidence[]>();
  const temporary: VisualEvidence[] = [];
  const decisions = entity.visualEvidenceDecisions ?? [];
  for (const item of entity.visualEvidence ?? []) {
    if (item.chapter > chapter) continue;
    if (decisions.some((decision) => decision.action === "dismiss" && decision.evidenceId === item.id)) continue;
    if (item.persistence === "temporary") {
      if (item.chapter === chapter) temporary.push(item);
      continue;
    }
    const list = byField.get(item.field) ?? [];
    list.push(item); byField.set(item.field, list);
  }
  const values: Record<string, VisualEvidence> = {};
  const conflicts: Record<string, VisualEvidence[]> = {};
  for (const [field, records] of byField) {
    const selectedDecision = [...decisions].reverse().find((decision) => decision.field === field && decision.action !== "dismiss" && records.some((item) => item.id === decision.evidenceId && item.chapter <= chapter));
    const selected = selectedDecision ? records.find((item) => item.id === selectedDecision.evidenceId) : undefined;
    const boundary = Math.max(0, ...records.filter((item) => item.persistence === "changed").map((item) => item.chapter), ...decisions.filter((decision) => decision.field === field && decision.action === "change").map((decision) => records.find((item) => item.id === decision.evidenceId)?.chapter ?? 0));
    const current = records.filter((item) => item.chapter >= boundary);
    if (selected && selected.chapter >= boundary) { values[field] = selected; continue; }
    const concepts = new Map<string, VisualEvidence[]>();
    for (const item of current) concepts.set(item.normalizedValue, [...(concepts.get(item.normalizedValue) ?? []), item]);
    if (concepts.size > 1) { conflicts[field] = current; continue; }
    values[field] = current.sort((left, right) => right.lastObservedChapter - left.lastObservedChapter || right.confidence - left.confidence)[0]!;
  }
  return { values, conflicts, temporary };
}
