import type { CanonicalEntity } from "../domain/story-bible.js";
import { characterVisualDetailsSchema, creatureVisualDetailsSchema, itemVisualDetailsSchema, locationVisualDetailsSchema, type VisualEntityProfile, type VisualEntityType } from "../domain/visual-profile.js";

const fields = {
  character: Object.keys(characterVisualDetailsSchema.removeDefault().shape).map((key) => `character.${key}`),
  location: Object.keys(locationVisualDetailsSchema.removeDefault().shape).map((key) => `location.${key}`),
  creature: Object.keys(creatureVisualDetailsSchema.removeDefault().shape).map((key) => `creature.${key}`),
  item: Object.keys(itemVisualDetailsSchema.removeDefault().shape).map((key) => `item.${key}`),
} as const;
type Section = keyof typeof fields;
export function profileSection(type: VisualEntityType): Section | undefined {
  if (type === "weapon" || type === "object") return "item";
  return type in fields ? type as Section : undefined;
}
export function visualFieldsForType(type: VisualEntityType): readonly string[] { const section = profileSection(type); return section ? fields[section] : []; }
export function validVisualField(type: VisualEntityType, path: string): boolean { return visualFieldsForType(type).includes(path); }
export function readVisualField(profile: VisualEntityProfile, path: string): string | undefined {
  if (!validVisualField(profile.visualType, path)) return undefined;
  const [section, key] = path.split(".") as [Section, string];
  return (profile[section] as Record<string, string | undefined> | undefined)?.[key]?.trim() || undefined;
}
export function writeVisualField(profile: VisualEntityProfile, path: string, value: string): boolean {
  if (!validVisualField(profile.visualType, path)) return false;
  const [section, key] = path.split(".") as [Section, string];
  (profile as unknown as Record<string, unknown>)[section] = { ...(profile[section] ?? {}), [key]: value };
  return true;
}
export function resolveVisualEntityType(entity: CanonicalEntity, existing?: VisualEntityProfile): VisualEntityType {
  if (existing) return existing.visualType;
  if (entity.type === "character" || entity.type === "location" || entity.type === "item") return entity.type;
  if (entity.type === "ability") return "object";
  if (entity.visualEvidence?.some((item) => item.field.startsWith("creature.")) || entity.sourceBucket === "creatures") return "creature";
  if (entity.visualEvidence?.some((item) => item.field.startsWith("item.")) || entity.sourceBucket === "items") return "item";
  if (entity.type === "organization") return "faction";
  return "other";
}
