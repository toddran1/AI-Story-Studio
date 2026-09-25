import type { CanonicalEntity, ExtractedVisualObservation } from "../domain/story-bible.js";
import { fingerprint } from "../utils/hash.js";
export { resolveEntityVisualEvidence } from "./visual-evidence-resolution.js";
export type { ResolvedVisualEvidence } from "./visual-evidence-resolution.js";

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
