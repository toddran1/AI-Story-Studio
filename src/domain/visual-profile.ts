import { z } from "zod";

export const visualRoleSchema = z.enum([
  "front",
  "three_quarter",
  "side",
  "back",
  "full_body",
  "face_portrait",
  "expression_sheet",
  "outfit_sheet",
  "equipment_reference",
  "environment_reference",
  "general_reference",
]);
export type VisualRole = z.infer<typeof visualRoleSchema>;

export const visualReferenceSourceSchema = z.enum(["generated", "uploaded", "style_sheet"]);
export type VisualReferenceSource = z.infer<typeof visualReferenceSourceSchema>;

export const visualReferenceExtensionSchema = z.enum(["png", "jpg", "jpeg", "webp"]);
export type VisualReferenceExtension = z.infer<typeof visualReferenceExtensionSchema>;

export const visualReferenceImageSchema = z.object({
  id: z.string().min(1),
  entityId: z.string().regex(/^ent_[a-f0-9]{24}$/),
  role: visualRoleSchema.default("general_reference"),
  imagePath: z.string().min(1),
  createdAt: z.string().datetime(),
  source: visualReferenceSourceSchema.default("uploaded"),
  approved: z.boolean().default(false),
  prompt: z.string().max(10_000).optional(),
  provenance: z.record(z.string(), z.unknown()).optional(),
});
export type VisualReferenceImage = z.infer<typeof visualReferenceImageSchema>;

export const visualEntityTypeSchema = z.enum([
  "character",
  "creature",
  "location",
  "item",
  "weapon",
  "object",
  "faction",
  "vehicle",
  "other",
]);
export type VisualEntityType = z.infer<typeof visualEntityTypeSchema>;

export const visualProfileStatusSchema = z.enum(["draft", "approved"]);
export type VisualProfileStatus = z.infer<typeof visualProfileStatusSchema>;

export const characterVisualDetailsSchema = z.object({
  apparentAge: z.string().trim().max(200).optional(),
  gender: z.string().trim().max(100).optional(),
  height: z.string().trim().max(100).optional(),
  build: z.string().trim().max(200).optional(),
  skinTone: z.string().trim().max(200).optional(),
  faceShape: z.string().trim().max(200).optional(),
  eyeColor: z.string().trim().max(200).optional(),
  hairColor: z.string().trim().max(200).optional(),
  hairstyle: z.string().trim().max(300).optional(),
  facialHair: z.string().trim().max(300).optional(),
  distinguishingFeatures: z.string().trim().max(1000).optional(),
  scars: z.string().trim().max(500).optional(),
  tattoos: z.string().trim().max(500).optional(),
  defaultOutfit: z.string().trim().max(1000).optional(),
  shoes: z.string().trim().max(300).optional(),
  accessories: z.string().trim().max(1000).optional(),
  weapons: z.string().trim().max(1000).optional(),
  equipment: z.string().trim().max(1000).optional(),
  additionalAppearanceNotes: z.string().trim().max(5000).optional(),
}).default({});
export type CharacterVisualDetails = z.infer<typeof characterVisualDetailsSchema>;

export const locationVisualDetailsSchema = z.object({
  environmentDescription: z.string().trim().max(2000).optional(),
  architecture: z.string().trim().max(1000).optional(),
  terrain: z.string().trim().max(500).optional(),
  vegetation: z.string().trim().max(500).optional(),
  weatherTendencies: z.string().trim().max(500).optional(),
  lighting: z.string().trim().max(500).optional(),
  atmosphere: z.string().trim().max(500).optional(),
  colorPalette: z.string().trim().max(500).optional(),
  recurringLandmarks: z.string().trim().max(1000).optional(),
  canonicalEnvironmentPrompt: z.string().trim().max(5000).optional(),
}).default({});
export type LocationVisualDetails = z.infer<typeof locationVisualDetailsSchema>;

export const creatureVisualDetailsSchema = z.object({
  species: z.string().trim().max(300).optional(),
  scale: z.string().trim().max(200).optional(),
  anatomy: z.string().trim().max(1000).optional(),
  coloration: z.string().trim().max(500).optional(),
  eyes: z.string().trim().max(300).optional(),
  armorFur: z.string().trim().max(500).optional(),
  distinguishingFeatures: z.string().trim().max(1000).optional(),
  sizeRelativeToHuman: z.string().trim().max(300).optional(),
  canonicalCreaturePrompt: z.string().trim().max(5000).optional(),
}).default({});
export type CreatureVisualDetails = z.infer<typeof creatureVisualDetailsSchema>;

export const itemVisualDetailsSchema = z.object({
  shape: z.string().trim().max(500).optional(),
  materials: z.string().trim().max(500).optional(),
  dimensions: z.string().trim().max(300).optional(),
  color: z.string().trim().max(300).optional(),
  ornamentation: z.string().trim().max(1000).optional(),
  wearDamage: z.string().trim().max(500).optional(),
  magicalEffects: z.string().trim().max(1000).optional(),
  canonicalObjectPrompt: z.string().trim().max(5000).optional(),
}).default({});
export type ItemVisualDetails = z.infer<typeof itemVisualDetailsSchema>;

export const visualVariantSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  defaultOutfit: z.string().trim().max(1000).optional(),
  visualPrompt: z.string().trim().max(5000).optional(),
});
export type VisualVariant = z.infer<typeof visualVariantSchema>;

export const visualProfileSchema = z.object({
  id: z.string().min(1),
  entityId: z.string().regex(/^ent_[a-f0-9]{24}$/),
  visualType: visualEntityTypeSchema.default("character"),
  status: visualProfileStatusSchema.default("draft"),
  appearance: z.string().trim().max(10_000).default(""),
  visualPrompt: z.string().trim().max(10_000).default(""),
  negativePrompt: z.string().trim().max(2000).default(""),
  notes: z.string().trim().max(5000).default(""),
  character: characterVisualDetailsSchema.optional(),
  location: locationVisualDetailsSchema.optional(),
  creature: creatureVisualDetailsSchema.optional(),
  item: itemVisualDetailsSchema.optional(),
  variants: z.array(visualVariantSchema).default([]),
  references: z.array(visualReferenceImageSchema).default([]),
  revision: z.number().int().nonnegative().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  approvedAt: z.string().datetime().optional(),
});
export type VisualEntityProfile = z.infer<typeof visualProfileSchema>;

