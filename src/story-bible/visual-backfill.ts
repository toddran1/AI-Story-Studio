import type { CanonicalEntity, ExtractedVisualObservation } from "../domain/story-bible.js";

const colors = "ink[- ]black|jet[- ]black|dark black|black|brown|blue|green|red|white|silver|golden?|blond(?:e)?|gr[ae]y|purple|violet|amber|hazel";
const hairColor = new RegExp(`\\b(${colors})\\s+hair\\b`, "i");
const eyeColor = new RegExp(`\\b(${colors})\\s+eyes?\\b`, "i");
const hairstyle = /\b(long|short|shoulder[- ]length|waist[- ]length|braided|cropped|curly|straight|spiky)\s+hair\b/i;
const scar = /\b(?:permanent|lasting|old)\s+scar\b[^.!?]{0,100}/i;
const wardrobe = /\b(?:wore|wears|wearing|dressed in|clad in)\s+([^.!?]{2,120})/i;

function hasName(sentence: string, entity: CanonicalEntity): boolean {
  return [entity.canonicalName, entity.originalName, ...entity.aliases].filter(Boolean).some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(sentence);
  });
}

/** Conservative, free backfill: only sentences naming exactly one entity and
 * stating a literal appearance. Pronoun-only and ambiguous facts await an
 * explicit chapter extraction; this path never invents attributes. */
export function extractLocalVisualObservations(text: string, entities: CanonicalEntity[], chapter: number): ExtractedVisualObservation[] {
  const observations: ExtractedVisualObservation[] = [];
  for (const sentence of text.match(/[^.!?。！？]+[.!?。！？]?/gu) ?? []) {
    const excerpt = sentence.trim().replace(/\s+/g, " ");
    if (!excerpt || excerpt.length > 500) continue;
    const matches = entities.filter((entity) => entity.type === "character" && hasName(excerpt, entity));
    if (matches.length !== 1) continue;
    const entity = matches[0]!;
    const push = (field: ExtractedVisualObservation["field"], value: string, persistence: ExtractedVisualObservation["persistence"]) => {
      observations.push({ entity: entity.canonicalName, field, value, chapter, confidence: 0.85, persistence, excerpt });
    };
    const color = hairColor.exec(excerpt)?.[1]; if (color) push("character.hairColor", color, "persistent");
    const length = hairstyle.exec(excerpt)?.[0]; if (length) push("character.hairstyle", length, /\b(?:cut|grew|became|turned)\b/i.test(excerpt) ? "changed" : "persistent");
    const eyes = eyeColor.exec(excerpt)?.[1]; if (eyes) push("character.eyeColor", eyes, "persistent");
    const mark = scar.exec(excerpt)?.[0]; if (mark) push("character.scars", mark, /\b(?:received|gained|acquired)\b/i.test(excerpt) ? "changed" : "persistent");
    const clothes = wardrobe.exec(excerpt)?.[1]; if (clothes) push("character.defaultOutfit", clothes.trim(), "temporary");
  }
  return observations;
}
