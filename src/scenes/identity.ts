import type { CanonicalEntity } from "../domain/story-bible.js";
import type { VisualEntityProfile } from "../domain/visual-profile.js";
import { normalizeEntityName } from "../story-bible/updater.js";

export type CharacterResolutionKind =
  | "exact_id"
  | "canonical_name"
  | "preferred_name"
  | "localized_name"
  | "original_name"
  | "alias"
  | "unresolved";

export type ResolvedSceneCharacter = {
  name: string;
  entityId?: string;
  canonicalName?: string;
  profileStatus?: "draft" | "approved" | "missing";
  visualProfileId?: string;
  resolution: CharacterResolutionKind;
};

export function resolveSceneVisualEntity(
  name: string,
  entities: CanonicalEntity[],
  visualProfiles?: Record<string, VisualEntityProfile> | VisualEntityProfile[],
): ResolvedSceneCharacter {
  const trimmed = name.trim();
  if (!trimmed) {
    return { name, resolution: "unresolved" };
  }

  // 1. Check if name is already an exact canonical entity ID
  if (/^ent_[a-f0-9]{24}$/.test(trimmed)) {
    const matched = entities.find((e) => e.id === trimmed);
    if (matched) {
      return buildResolvedCharacter(name, matched, "exact_id", visualProfiles);
    }
  }

  const normalized = normalizeEntityName(trimmed);
  if (!normalized) {
    return { name, resolution: "unresolved" };
  }

  // 2. Canonical name exact match
  const canonicalMatches = entities.filter(
    (e) => normalizeEntityName(e.canonicalName) === normalized
  );
  if (canonicalMatches.length === 1) {
    return buildResolvedCharacter(name, canonicalMatches[0]!, "canonical_name", visualProfiles);
  }
  if (canonicalMatches.length > 1) {
    return { name, resolution: "unresolved" };
  }

  // 3. Preferred narration name match
  const preferredMatches = entities.filter(
    (e) => e.preferredNarrationName && normalizeEntityName(e.preferredNarrationName) === normalized
  );
  if (preferredMatches.length === 1) {
    return buildResolvedCharacter(name, preferredMatches[0]!, "preferred_name", visualProfiles);
  }
  if (preferredMatches.length > 1) {
    return { name, resolution: "unresolved" };
  }

  // 4. Localized naming (fullName or shortName)
  const localizedMatches = entities.filter(
    (e) =>
      (e.localizedNaming?.fullName && normalizeEntityName(e.localizedNaming.fullName) === normalized) ||
      (e.localizedNaming?.shortName && normalizeEntityName(e.localizedNaming.shortName) === normalized)
  );
  if (localizedMatches.length === 1) {
    return buildResolvedCharacter(name, localizedMatches[0]!, "localized_name", visualProfiles);
  }
  if (localizedMatches.length > 1) {
    return { name, resolution: "unresolved" };
  }

  // 5. Original name match
  const originalMatches = entities.filter(
    (e) => e.originalName && normalizeEntityName(e.originalName) === normalized
  );
  if (originalMatches.length === 1) {
    return buildResolvedCharacter(name, originalMatches[0]!, "original_name", visualProfiles);
  }
  if (originalMatches.length > 1) {
    return { name, resolution: "unresolved" };
  }

  // 6. Aliases match
  const aliasMatches = entities.filter(
    (e) => e.aliases.some((a) => normalizeEntityName(a) === normalized)
  );
  if (aliasMatches.length === 1) {
    return buildResolvedCharacter(name, aliasMatches[0]!, "alias", visualProfiles);
  }

  // 7. Unresolved
  return { name, resolution: "unresolved" };
}

function buildResolvedCharacter(
  name: string,
  entity: CanonicalEntity,
  resolution: CharacterResolutionKind,
  visualProfiles?: Record<string, VisualEntityProfile> | VisualEntityProfile[],
): ResolvedSceneCharacter {
  let profile: VisualEntityProfile | undefined;
  if (visualProfiles) {
    if (Array.isArray(visualProfiles)) {
      profile = visualProfiles.find((p) => p.entityId === entity.id);
    } else {
      profile = visualProfiles[entity.id];
    }
  }

  return {
    name,
    entityId: entity.id,
    canonicalName: entity.canonicalName,
    profileStatus: profile ? (profile.status === "approved" ? "approved" : "draft") : "missing",
    visualProfileId: profile?.id,
    resolution,
  };
}

/** Narration display names are aliases for visual identity, never new entities. */
export function resolveVisualEntities(names: string[], entities: CanonicalEntity[]) {
  const result = new Map<string, CanonicalEntity>();
  for (const name of names) {
    const resolved = resolveSceneVisualEntity(name, entities);
    if (resolved.entityId) {
      const entity = entities.find((e) => e.id === resolved.entityId);
      if (entity) result.set(entity.id, entity);
    }
  }
  return [...result.values()];
}
