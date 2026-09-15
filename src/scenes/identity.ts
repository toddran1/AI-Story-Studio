import type { CanonicalEntity } from "../domain/story-bible.js";
import { normalizeEntityName } from "../story-bible/updater.js";

/** Narration display names are aliases for visual identity, never new entities. */
export function resolveVisualEntities(names: string[], entities: CanonicalEntity[]) {
  const result = new Map<string, CanonicalEntity>();
  for (const name of names) {
    const normalized = normalizeEntityName(name);
    if (!normalized) continue;
    const matches = entities.filter((entity) => [entity.canonicalName, entity.originalName, ...entity.aliases,
      entity.preferredNarrationName, entity.localizedNaming?.fullName, entity.localizedNaming?.shortName]
      .some((candidate) => candidate && normalizeEntityName(candidate) === normalized));
    // Ambiguous short forms must be resolved by canonical context, not guessed.
    if (matches.length === 1) result.set(matches[0]!.id, matches[0]!);
  }
  return [...result.values()];
}
