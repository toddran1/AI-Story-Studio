import type { CanonicalEntity, ExtractedVisualObservation } from "../domain/story-bible.js";

const colors = "ink[- ]black|jet[- ]black|dark black|black|brown|blue|green|red|white|silver|golden?|blond(?:e)?|gr[ae]y|purple|violet|amber|hazel";
const hairColor = new RegExp(`\\b(${colors})\\s+hair\\b`, "i");
const eyeColor = new RegExp(`\\b(${colors})\\s+eyes?\\b`, "i");
const hairstyle = /\b(long|short|shoulder[- ]length|waist[- ]length|braided|cropped|curly|straight|spiky)\s+hair\b/i;
const scar = /\b(?:permanent|lasting|old)\s+scar\b[^.!?]{0,100}/i;
const wardrobe = /\b(?:wore|wears|wearing|dressed in|clad in)\s+([^.!?]{2,120})/i;
const literalFacts: Array<[ExtractedVisualObservation["field"], RegExp]> = [
  ["character.height", /\b(?:was|is|stood)\s+(tall|short|average height)\b/i],
  ["character.build", /\b(?:had|has)\s+(?:a\s+)?(lean|slender|stocky|muscular|athletic|broad|frail)\s+build\b/i],
  ["character.skinTone", /\b(?:had|has)\s+(pale|tan|tanned|dark|light|brown|bronze)\s+(?:skin|complexion)\b/i],
  ["character.facialHair", /\b(?:wore|wears|had|has)\s+(?:a\s+)?((?:short|long|trimmed|full|thin)\s+(?:beard|mustache|moustache))\b/i],
  ["character.tattoos", /\b(?:had|has)\s+(?:a\s+)?([\w -]{2,70}\s+tattoo(?:\s+on\s+(?:his|her|their|the)\s+[\w -]{2,40})?)\b/i],
  ["character.scars", /\b(?:had|has)\s+(?:a\s+)?(scar\s+(?:over|above|below|across|on)\s+(?:his|her|their|the)?\s*[\w -]{2,60})\b/i],
  ["character.distinguishingFeatures", /\b(?:had|has)\s+(?:a\s+)?((?:birthmark|missing (?:eye|arm|hand|finger)|prosthetic (?:arm|hand|leg))[^.!?]{0,70})/i],
  ["character.shoes", /\b(?:wore|wears)\s+((?:black|brown|red|white|leather|muddy|torn|high|low)[\w -]{0,45}\s+(?:boots|shoes|sandals))\b/i],
  ["character.accessories", /\b(?:wore|wears|had|has)\s+(?:a\s+)?((?:silver|gold|bronze|jade|black|red)[\w -]{0,50}\s+(?:necklace|ring|amulet|earrings|mask))\b/i],
  ["character.weapons", /\b(?:carried|carries|wielded|wields)\s+(?:a\s+)?((?:black|silver|steel|iron|wooden|red)[\w -]{0,55}\s+(?:sword|spear|dagger|bow|axe)(?:\s+at\s+(?:his|her|their|the)\s+[\w -]{2,35})?)\b/i],
  ["character.equipment", /\b(?:carried|carries|wore|wears)\s+(?:a\s+)?((?:leather|steel|iron|wooden|silver|black)[\w -]{0,55}\s+(?:shield|pack|backpack|helmet))\b/i],
];

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
    const matches = entities.filter((entity) => hasName(excerpt, entity));
    if (matches.length !== 1 || matches[0]?.type !== "character") continue;
    const entity = matches[0]!;
    const subjectNames = [entity.canonicalName, entity.originalName, ...entity.aliases].filter(Boolean);
    if (!subjectNames.some((name) => excerpt.toLocaleLowerCase().startsWith(name.toLocaleLowerCase()) && /^(?:'s|’s|\s+(?:was|is|stood|had|has|wore|wears|wearing|carried|carries|wielded|wields|always|usually))\b/i.test(excerpt.slice(name.length)))) continue;
    const push = (field: ExtractedVisualObservation["field"], value: string, persistence: ExtractedVisualObservation["persistence"]) => {
      observations.push({ entity: entity.canonicalName, field, value, chapter, confidence: 0.85, persistence, excerpt });
    };
    const color = hairColor.exec(excerpt)?.[1]; if (color) push("character.hairColor", color, "persistent");
    const length = hairstyle.exec(excerpt)?.[0]; if (length) push("character.hairstyle", length, /\b(?:cut|grew|became|turned)\b/i.test(excerpt) ? "changed" : "persistent");
    const eyes = eyeColor.exec(excerpt)?.[1]; if (eyes) push("character.eyeColor", eyes, "persistent");
    const mark = scar.exec(excerpt)?.[0]; if (mark) push("character.scars", mark, /\b(?:received|gained|acquired)\b/i.test(excerpt) ? "changed" : "persistent");
    for (const [field, pattern] of literalFacts) { const match = pattern.exec(excerpt)?.[1]; if (match) push(field, match.trim().replace(/\b(?:his|her|their)\b/g, "").replace(/\s+/g, " ").trim(), "persistent"); }
    const clothes = wardrobe.exec(excerpt)?.[1];
    if (clothes && !/\b(?:necklace|ring|amulet|earrings|mask|beard|mustache|moustache|tattoo|boots|shoes|sandals|sword|spear|dagger|bow|axe|shield|pack|backpack|helmet)\b/i.test(clothes)) {
      const recurring = /\b(?:always|usually|habitually|typically|signature|usual)\b/i.test(excerpt);
      push("character.defaultOutfit", clothes.trim(), recurring ? "persistent" : "temporary");
    }
  }
  return observations;
}
