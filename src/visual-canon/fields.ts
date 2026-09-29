import type { CanonicalEntity } from "../domain/story-bible.js";
import { characterVisualDetailsSchema, creatureVisualDetailsSchema, itemVisualDetailsSchema, locationVisualDetailsSchema, type VisualEntityProfile, type VisualEntityType } from "../domain/visual-profile.js";

const fields = {
  // character.figure is a user-controlled setting, not an AI-generated or
  // source-evidence detail, so it is excluded from the completion field list.
  character: Object.keys(characterVisualDetailsSchema.removeDefault().shape).map((key) => `character.${key}`).filter((key) => key !== "character.figure"),
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
export function validVisualField(type: VisualEntityType, path: string): boolean { return ["appearance", "visualPrompt", "negativePrompt"].includes(path) || (path === "character.figure" && profileSection(type) === "character") || visualFieldsForType(type).includes(path); }
export function readVisualField(profile: VisualEntityProfile, path: string): string | undefined {
  if (!validVisualField(profile.visualType, path)) return undefined;
  if (path === "appearance" || path === "visualPrompt" || path === "negativePrompt") return profile[path]?.trim() || undefined;
  const [section, key] = path.split(".") as [Section, string];
  return (profile[section] as Record<string, string | undefined> | undefined)?.[key]?.trim() || undefined;
}
export function writeVisualField(profile: VisualEntityProfile, path: string, value: string): boolean {
  if (!validVisualField(profile.visualType, path)) return false;
  if (path === "appearance" || path === "visualPrompt" || path === "negativePrompt") { profile[path] = value; return true; }
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

/** Restricted AI values must match the controls, rather than descriptive prose. */
export function normalizeVisualProposalValue(path: string, value: string): string | undefined {
  const trimmed = value.trim();
  if (path === "character.apparentAge") return /^\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)) ? String(Number(trimmed)) : undefined;
  if (path === "character.gender") return ["male", "female"].includes(trimmed.toLowerCase()) ? trimmed.toLowerCase() : undefined;
  if (path === "character.figure") return undefined;
  return trimmed || undefined;
}
