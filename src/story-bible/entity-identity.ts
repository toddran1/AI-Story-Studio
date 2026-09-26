import type { CanonicalEntity, EntityType } from "../domain/story-bible.js";

export function normalizeEntityName(value?: string | null): string {
  return value
    ? value
        .normalize("NFKD")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, "")
    : "";
}

export const PERSON_HONORIFICS = new Set([
  "doctor",
  "dr",
  "elder",
  "master",
  "young master",
  "grandmaster",
  "lord",
  "lady",
  "sir",
  "miss",
  "mr",
  "mrs",
  "madam",
  "patriarch",
  "matriarch",
  "daoist",
  "abbot",
]);

export function normalizeCharacterHonorificVariant(value?: string | null): string {
  if (!value) return "";
  const tokens = value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .split(/[\s\p{P}\p{S}]+/gu)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) return "";

  let idx = 0;
  let hasHonorific = false;
  const coreTokens: string[] = [];

  while (idx < tokens.length) {
    if (idx + 1 < tokens.length && PERSON_HONORIFICS.has(`${tokens[idx]} ${tokens[idx + 1]}`)) {
      hasHonorific = true;
      idx += 2;
    } else if (PERSON_HONORIFICS.has(tokens[idx]!)) {
      hasHonorific = true;
      idx++;
    } else {
      coreTokens.push(tokens[idx]!);
      idx++;
    }
  }

  if (hasHonorific && coreTokens.length > 0) {
    return normalizeEntityName(coreTokens.join(" "));
  }

  return normalizeEntityName(value);
}

export const INCOMPATIBLE_TYPE_PAIRS: Array<[EntityType, EntityType]> = [
  ["character", "location"],
  ["character", "item"],
  ["character", "ability"],
  ["organization", "location"],
  ["ability", "item"],
  ["location", "ability"],
  ["location", "item"],
  ["organization", "item"],
  ["organization", "ability"],
];

export function areTypesIncompatible(typeA: EntityType, typeB: EntityType): boolean {
  if (typeA === typeB) return false;
  return INCOMPATIBLE_TYPE_PAIRS.some(
    ([t1, t2]) => (typeA === t1 && typeB === t2) || (typeA === t2 && typeB === t1),
  );
}

export function isIdentityTypeCompatible(existingType: EntityType, incomingType?: EntityType): boolean {
  if (!incomingType) return true;
  if (existingType === incomingType) return true;
  if (areTypesIncompatible(existingType, incomingType)) return false;
  if (existingType === "concept" && incomingType !== "concept") return true;
  if (existingType === "other" || incomingType === "other") return true;
  return false;
}

export type EntityIdentityMatchKind =
  | "canonical"
  | "original"
  | "alias"
  | "preferred_narration"
  | "localized_full"
  | "localized_short"
  | "custom_narration_replacement"
  | "honorific_variant";

export type EntityIdentityMatch = {
  entity: CanonicalEntity;
  matchKind: EntityIdentityMatchKind;
  matchedValue: string;
};

export type EntityIdentityResolution =
  | ({ status: "matched" } & EntityIdentityMatch)
  | { status: "ambiguous"; candidates: EntityIdentityMatch[] }
  | { status: "none" };

export const narrationMatchKinds = new Set<EntityIdentityMatchKind>([
  "preferred_narration",
  "localized_full",
  "localized_short",
  "custom_narration_replacement",
]);

export function canonicalIdentityRenderings(entity: CanonicalEntity): string[] {
  return [entity.canonicalName, entity.originalName, ...entity.aliases].filter((v): v is string =>
    Boolean(v && v.trim()),
  );
}

export function narrationRenderings(
  entity: CanonicalEntity,
): Array<{ value: string; kind: EntityIdentityMatchKind }> {
  return [
    { value: entity.preferredNarrationName, kind: "preferred_narration" },
    { value: entity.localizedNaming?.fullName, kind: "localized_full" },
    { value: entity.localizedNaming?.shortName, kind: "localized_short" },
    ...entity.aliasNarrationRules
      .filter((rule) => rule.behavior === "custom")
      .map((rule) => ({ value: rule.replacement, kind: "custom_narration_replacement" as const })),
  ].filter(
    (item): item is { value: string; kind: EntityIdentityMatchKind } =>
      Boolean(item.value && item.value.trim()),
  );
}

export function allIdentityRenderings(entity: CanonicalEntity): string[] {
  const canonical = canonicalIdentityRenderings(entity);
  const narration = narrationRenderings(entity).map((item) => item.value);
  return [...new Set([...canonical, ...narration])];
}

export type IdentityOverride = Partial<Pick<CanonicalEntity, "canonicalName" | "type" | "aliases" | "aliasNarrationRules">> & {
  preferredNarrationName?: string | null;
  localizedNaming?: CanonicalEntity["localizedNaming"] | null;
};

export type IdentityOverlay = {
  overrides?: Record<string, IdentityOverride>;
  suppressions?: Array<{ entityId: string }>;
  demotions?: Array<{ entityId: string }>;
  merges?: Array<{ targetEntityId: string; sourceEntityIds: string[]; undoneAt?: string }>;
};

/** Match the identity fields produced by the canonical manual overlay. */
export function effectiveEntityIdentity(entity: CanonicalEntity, override?: IdentityOverride): CanonicalEntity {
  const view: CanonicalEntity = {
    ...entity,
    aliases: [...entity.aliases],
    aliasNarrationRules: entity.aliasNarrationRules.map((rule) => ({ ...rule })),
    localizedNaming: entity.localizedNaming ? { ...entity.localizedNaming } : undefined,
  };
  if (!override) return view;
  if (override.type !== undefined) view.type = override.type;
  if (override.canonicalName) {
    if (normalizeEntityName(override.canonicalName) !== normalizeEntityName(view.canonicalName)) {
      view.aliases = uniqueIdentityNames([view.canonicalName, ...view.aliases]);
    }
    view.canonicalName = override.canonicalName;
  }
  if (override.aliases !== undefined) {
    view.aliases = uniqueIdentityNames(override.aliases.filter((name) => normalizeEntityName(name) !== normalizeEntityName(view.canonicalName)));
  }
  if (override.preferredNarrationName !== undefined) view.preferredNarrationName = override.preferredNarrationName ?? undefined;
  if (override.localizedNaming !== undefined) view.localizedNaming = override.localizedNaming ? { ...override.localizedNaming } : undefined;
  if (override.aliasNarrationRules !== undefined) {
    const aliases = new Set(view.aliases.map(normalizeEntityName));
    view.aliasNarrationRules = [...new Map(override.aliasNarrationRules.filter((rule) => aliases.has(normalizeEntityName(rule.alias))).map((rule) => [normalizeEntityName(rule.alias), { ...rule }])).values()];
  }
  return view;
}

export function matchesSuppressedIdentity(
  raw: {
    id?: string;
    name: string;
    originalName?: string;
    aliases?: string[];
    type: EntityType;
  },
  suppression: {
    entityId: string;
    name: string;
    originalName?: string;
    type?: EntityType;
    snapshot: CanonicalEntity;
  },
  override?: IdentityOverride,
): boolean {
  const effectiveSnapshot = effectiveEntityIdentity(suppression.snapshot, override);

  // A. Exact entity ID match
  if (raw.id && (raw.id === suppression.entityId || raw.id === suppression.snapshot.id || raw.id === effectiveSnapshot.id)) {
    return true;
  }

  // Type incompatibility guard: incompatible types never match
  if (areTypesIncompatible(effectiveSnapshot.type, raw.type)) {
    return false;
  }

  // Original identity conflict guard: if both have explicit original names and they differ, they are distinct entities
  const rawOrigNorm = normalizeEntityName(raw.originalName);
  const snapOrigNorm = normalizeEntityName(effectiveSnapshot.originalName || suppression.originalName);
  if (rawOrigNorm && snapOrigNorm && rawOrigNorm !== snapOrigNorm) {
    return false;
  }

  // Tombstones retain historical renderings even when a later manual override
  // removes them from the active identity. Old chapter updates can still carry
  // those names during a chronological rebuild.
  const suppressedRenderings = new Set<string>();
  for (const rendering of [
    ...allIdentityRenderings(suppression.snapshot),
    ...allIdentityRenderings(effectiveSnapshot),
  ]) {
    const key = normalizeEntityName(rendering);
    if (key) suppressedRenderings.add(key);
  }
  if (suppression.name) {
    const key = normalizeEntityName(suppression.name);
    if (key) suppressedRenderings.add(key);
  }
  if (suppression.originalName) {
    const key = normalizeEntityName(suppression.originalName);
    if (key) suppressedRenderings.add(key);
  }

  // Check if any of raw's names match any known rendering of the suppressed entity
  const rawKeys = [raw.name, raw.originalName, ...(raw.aliases ?? [])]
    .map(normalizeEntityName)
    .filter(Boolean);

  const hasMatchingRendering = rawKeys.some((k) => suppressedRenderings.has(k));
  if (!hasMatchingRendering) {
    return false;
  }

  // B & C: Supporting original identity match
  if (rawOrigNorm && snapOrigNorm && rawOrigNorm === snapOrigNorm) {
    return true;
  }

  // An unqualified canonical/alias display name can belong to a different
  // same-type entity. Only an explicitly configured narration rendering has
  // enough support to match without an original name, and its tombstone must
  // retain a stable original-language identity.
  if (!snapOrigNorm || raw.type !== effectiveSnapshot.type) return false;
  const narrationKeys = new Set([
    ...narrationRenderings(suppression.snapshot),
    ...narrationRenderings(effectiveSnapshot),
  ].map((item) => normalizeEntityName(item.value)).filter(Boolean));
  return rawKeys.some((key) => narrationKeys.has(key));
}

function uniqueIdentityNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = normalizeEntityName(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildEffectiveIdentityIndex(entities: CanonicalEntity[], overlay?: IdentityOverlay): EntityIdentityIndex {
  const available = new Set(entities.map((entity) => entity.id));
  const inactive = new Set([
    ...(overlay?.suppressions ?? []).map((item) => item.entityId),
    ...(overlay?.demotions ?? []).map((item) => item.entityId),
    ...(overlay?.merges ?? []).filter((item) => !item.undoneAt && available.has(item.targetEntityId)).flatMap((item) => item.sourceEntityIds),
  ]);
  return new EntityIdentityIndex(entities.filter((entity) => !inactive.has(entity.id)).map((entity) => effectiveEntityIdentity(entity, overlay?.overrides?.[entity.id])));
}

const CJK_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsIdentityRendering(
  text: string | undefined | null,
  candidate: string | undefined | null,
  _languageOrScriptHint?: string,
): boolean {
  if (!text || !candidate) return false;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return false;

  const normalizedText = text.normalize("NFKD");
  const normalizedCandidate = trimmed.normalize("NFKD");

  if (CJK_REGEX.test(normalizedCandidate)) {
    return normalizedText.toLocaleLowerCase().includes(normalizedCandidate.toLocaleLowerCase());
  }

  const words = normalizedCandidate
    .split(/\s+/gu)
    .filter(Boolean)
    .map(escapeRegex);

  if (words.length === 0) return false;

  const pattern = words.join("\\s+");
  const regex = new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, "gui");
  return regex.test(normalizedText);
}

export class EntityIdentityIndex {
  private readonly entries = new Map<string, EntityIdentityMatch[]>();
  private readonly characterHonorificEntries = new Map<string, EntityIdentityMatch[]>();
  private readonly entityKeys = new Map<string, Set<string>>();
  private readonly honorificEntityKeys = new Map<string, Set<string>>();

  constructor(entities: CanonicalEntity[] = []) {
    for (const entity of entities) {
      this.add(entity);
    }
  }

  add(entity: CanonicalEntity) {
    this.addName(entity, entity.canonicalName, "canonical");
    this.addName(entity, entity.originalName, "original");
    for (const alias of entity.aliases) {
      this.addName(entity, alias, "alias");
    }
    for (const rendering of narrationRenderings(entity)) {
      this.addName(entity, rendering.value, rendering.kind);
    }
  }

  addName(
    entity: CanonicalEntity,
    value: string | undefined | null,
    kind: EntityIdentityMatchKind,
  ) {
    if (!value) return;
    const key = normalizeEntityName(value);
    if (!key) return;

    const matches = this.entries.get(key) ?? [];
    if (!matches.some((match) => match.entity.id === entity.id && match.matchKind === kind)) {
      matches.push({ entity, matchKind: kind, matchedValue: value });
    }
    this.entries.set(key, matches);

    let keys = this.entityKeys.get(entity.id);
    if (!keys) {
      keys = new Set<string>();
      this.entityKeys.set(entity.id, keys);
    }
    keys.add(key);

    if (entity.type === "character") {
      const hKey = normalizeCharacterHonorificVariant(value);
      if (hKey && hKey !== key) {
        const hMatches = this.characterHonorificEntries.get(hKey) ?? [];
        if (!hMatches.some((m) => m.entity.id === entity.id)) {
          hMatches.push({ entity, matchKind: "honorific_variant", matchedValue: value });
        }
        this.characterHonorificEntries.set(hKey, hMatches);

        let hKeys = this.honorificEntityKeys.get(entity.id);
        if (!hKeys) {
          hKeys = new Set<string>();
          this.honorificEntityKeys.set(entity.id, hKeys);
        }
        hKeys.add(hKey);
      }
    }
  }

  removeEntity(entityId: string): void {
    const keys = this.entityKeys.get(entityId);
    if (keys) {
      for (const key of keys) {
        const matches = this.entries.get(key);
        if (matches) {
          const remaining = matches.filter((m) => m.entity.id !== entityId);
          if (remaining.length === 0) {
            this.entries.delete(key);
          } else {
            this.entries.set(key, remaining);
          }
        }
      }
      this.entityKeys.delete(entityId);
    }

    const hKeys = this.honorificEntityKeys.get(entityId);
    if (hKeys) {
      for (const hKey of hKeys) {
        const hMatches = this.characterHonorificEntries.get(hKey);
        if (hMatches) {
          const remaining = hMatches.filter((m) => m.entity.id !== entityId);
          if (remaining.length === 0) {
            this.characterHonorificEntries.delete(hKey);
          } else {
            this.characterHonorificEntries.set(hKey, remaining);
          }
        }
      }
      this.honorificEntityKeys.delete(entityId);
    }
  }

  replace(entity: CanonicalEntity): void {
    this.removeEntity(entity.id);
    this.add(entity);
  }

  resolve(
    names: Iterable<string | undefined | null>,
    options?: { expectedType?: EntityType },
  ): EntityIdentityResolution {
    const expectedType = options?.expectedType;
    const exactMatches = new Map<string, EntityIdentityMatch>();

    for (const name of names) {
      const key = normalizeEntityName(name);
      if (!key) continue;
      for (const match of this.entries.get(key) ?? []) {
        if (!exactMatches.has(match.entity.id)) {
          exactMatches.set(match.entity.id, match);
        }
      }
    }

    let candidateMatches = [...exactMatches.values()];
    if (expectedType) {
      const compatible = candidateMatches.filter((match) =>
        isIdentityTypeCompatible(match.entity.type, expectedType),
      );
      const exactTypeMatches = compatible.filter((match) => match.entity.type === expectedType);
      candidateMatches = exactTypeMatches.length > 0 ? exactTypeMatches : compatible;
    }

    const uniqueCandidates = new Map<string, EntityIdentityMatch>();
    for (const match of candidateMatches) {
      if (!uniqueCandidates.has(match.entity.id)) {
        uniqueCandidates.set(match.entity.id, match);
      }
    }

    if (uniqueCandidates.size === 1) {
      return { status: "matched", ...uniqueCandidates.values().next().value! };
    }
    if (uniqueCandidates.size > 1) {
      return { status: "ambiguous", candidates: [...uniqueCandidates.values()] };
    }

    // Tier 2: character-only honorific fallback
    if (expectedType === "character") {
      const honorificMatches = new Map<string, EntityIdentityMatch>();
      for (const name of names) {
        if (!name) continue;
        const key = normalizeEntityName(name);
        const hKey = normalizeCharacterHonorificVariant(name);

        if (hKey && hKey !== key) {
          for (const match of this.entries.get(hKey) ?? []) {
            if (match.entity.type === "character" && !honorificMatches.has(match.entity.id)) {
              honorificMatches.set(match.entity.id, {
                entity: match.entity,
                matchKind: "honorific_variant",
                matchedValue: match.matchedValue,
              });
            }
          }
        }

        if (key) {
          for (const match of this.characterHonorificEntries.get(key) ?? []) {
            if (!honorificMatches.has(match.entity.id)) {
              honorificMatches.set(match.entity.id, match);
            }
          }
        }

        if (hKey && hKey !== key) {
          for (const match of this.characterHonorificEntries.get(hKey) ?? []) {
            if (!honorificMatches.has(match.entity.id)) {
              honorificMatches.set(match.entity.id, match);
            }
          }
        }
      }

      if (honorificMatches.size === 1) {
        return { status: "matched", ...honorificMatches.values().next().value! };
      }
      if (honorificMatches.size > 1) {
        return { status: "ambiguous", candidates: [...honorificMatches.values()] };
      }
    }

    return { status: "none" };
  }
}
