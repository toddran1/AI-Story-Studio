import type { CanonicalEntity } from "../domain/story-bible.js";

export function normalizeEntityName(value: string | undefined | null) {
  return value ? value.normalize("NFKD").toLocaleLowerCase().replace(/\b(?:doctor|dr|young master|master|elder|lord|lady|sir|miss|mr|mrs)\b/gu, "").replace(/[^\p{L}\p{N}]/gu, "") : "";
}

export type EntityIdentityMatchKind = "canonical" | "original" | "alias" | "preferred_narration" | "localized_full" | "localized_short" | "custom_narration_replacement";
export type EntityIdentityMatch = { entity: CanonicalEntity; matchKind: EntityIdentityMatchKind; matchedValue: string };
export type EntityIdentityResolution = { status: "matched" } & EntityIdentityMatch | { status: "ambiguous"; candidates: EntityIdentityMatch[] } | { status: "none" };
export const narrationMatchKinds = new Set<EntityIdentityMatchKind>(["preferred_narration", "localized_full", "localized_short", "custom_narration_replacement"]);
export function narrationRenderings(entity: CanonicalEntity): Array<{ value: string; kind: EntityIdentityMatchKind }> {
  return [
    { value: entity.preferredNarrationName, kind: "preferred_narration" },
    { value: entity.localizedNaming?.fullName, kind: "localized_full" },
    { value: entity.localizedNaming?.shortName, kind: "localized_short" },
    ...entity.aliasNarrationRules.filter((rule) => rule.behavior === "custom").map((rule) => ({ value: rule.replacement, kind: "custom_narration_replacement" as const })),
  ].filter((item): item is { value: string; kind: EntityIdentityMatchKind } => Boolean(item.value));
}

export class EntityIdentityIndex {
  private readonly entries = new Map<string, EntityIdentityMatch[]>();
  constructor(entities: CanonicalEntity[] = []) { for (const entity of entities) this.add(entity); }
  add(entity: CanonicalEntity) {
    const values: Array<[string | undefined, EntityIdentityMatchKind]> = [
      [entity.canonicalName, "canonical"], [entity.originalName, "original"],
      ...entity.aliases.map((value): [string, EntityIdentityMatchKind] => [value, "alias"]),
      [entity.preferredNarrationName, "preferred_narration"],
      [entity.localizedNaming?.fullName, "localized_full"], [entity.localizedNaming?.shortName, "localized_short"],
      ...entity.aliasNarrationRules.filter((rule) => rule.behavior === "custom").map((rule): [string | undefined, EntityIdentityMatchKind] => [rule.replacement, "custom_narration_replacement"]),
    ];
    for (const [value, kind] of values) this.addName(entity, value, kind);
  }
  addName(entity: CanonicalEntity, value: string | undefined, kind: EntityIdentityMatchKind) {
      const key = normalizeEntityName(value);
      if (!key || !value) return;
      const matches = this.entries.get(key) ?? [];
      if (!matches.some((match) => match.entity.id === entity.id && match.matchKind === kind)) matches.push({ entity, matchKind: kind, matchedValue: value });
      this.entries.set(key, matches);
  }
  resolve(names: Iterable<string | undefined | null>): EntityIdentityResolution {
    const matches = new Map<string, EntityIdentityMatch>();
    for (const name of names) {
      const key = normalizeEntityName(name);
      if (!key) continue;
      for (const match of this.entries.get(key) ?? []) if (!matches.has(match.entity.id)) matches.set(match.entity.id, match);
    }
    if (matches.size === 0) return { status: "none" };
    if (matches.size > 1) return { status: "ambiguous", candidates: [...matches.values()] };
    return { status: "matched", ...matches.values().next().value! };
  }
}
