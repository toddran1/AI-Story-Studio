import { CanonicalEntity, EntityType, StoryBible } from "../domain/story-bible.js";
import { normalizeEntityName } from "./updater.js";
import { narrationRenderings } from "./entity-identity.js";

export type DuplicateSuggestion = {
  id: string;
  entityIds: [string, string];
  entities: [{ id: string; name: string }, { id: string; name: string }];
  confidence: number;
  reason: string;
  supportingChapters: number[];
  recommendation?: "merge" | "needs_review";
  recommendedTargetEntityId?: string;
  kind?: "narration_rendering_duplicate";
};

export interface DuplicateScoreResult {
  confidence: number;
  reason: string;
  recommendation: "merge" | "needs_review";
  conflict?: string;
}

export interface DuplicateContext {
  bible?: StoryBible;
  relationships?: StoryBible["canonicalRelationships"];
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

export const IDENTIFIER_QUALIFIERS = new Set([
  "encyclopedia",
  "manual",
  "guide",
  "codex",
  "chronicle",
  "record",
  "sword",
  "blade",
  "spear",
  "armor",
  "shield",
  "pill",
  "talisman",
  "technique",
  "art",
  "scroll",
  "hall",
  "palace",
  "pavilion",
  "tower",
  "chamber",
  "realm",
  "world",
  "forest",
  "mountain",
  "valley",
  "sea",
  "ocean",
  "river",
  "lake",
  "city",
  "village",
  "sect",
  "clan",
  "family",
  "guild",
  "class",
  "order",
  "army",
  "squad",
  "corps",
  "president",
  "leader",
  "conference",
  "seaside",
  "northern",
  "southern",
  "eastern",
  "western",
  "central",
  "ancient",
  "primordial",
  "dragon",
  "fire",
  "ice",
  "thunder",
  "necromancer",
]);

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
  six: 6,
  sixth: 6,
  seven: 7,
  seventh: 7,
  eight: 8,
  eighth: 8,
  nine: 9,
  ninth: 9,
  ten: 10,
  tenth: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  thousand: 1000,
};

const INCOMPATIBLE_TYPE_PAIRS: Array<[EntityType, EntityType]> = [
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

/**
 * Tokenizes a name into lowercase alphanumeric words.
 */
export function tokenizeEntityName(name: string | undefined | null): string[] {
  if (!name) return [];
  const normalized = name.normalize("NFKD").toLocaleLowerCase();
  // Split on whitespace, hyphens, and punctuation
  return normalized
    .split(/[\s\p{P}\p{S}]+/gu)
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Extracts complete numeric qualifiers from a name (digits and number words).
 */
export function extractNumericTokens(name: string | undefined | null): number[] {
  if (!name) return [];
  const tokens = tokenizeEntityName(name);
  const numbers: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // Match direct digits or prefixed digits like lv44, lvl44, #44
    const digitMatch = token.match(/(?:lv|lvl|#)?(\d+)/i);
    if (digitMatch && digitMatch[1]) {
      const parsed = parseInt(digitMatch[1], 10);
      if (!Number.isNaN(parsed)) {
        numbers.push(parsed);
        continue;
      }
    }

    // Match word numbers (single or compound like forty-four parsed as tokens)
    if (token in NUMBER_WORDS) {
      let val = NUMBER_WORDS[token]!;
      // Check if next token is a single-digit word, e.g. "forty" followed by "four"
      if (val >= 20 && val <= 90 && i + 1 < tokens.length) {
        const next = tokens[i + 1]!;
        if (next in NUMBER_WORDS && NUMBER_WORDS[next]! < 10) {
          val += NUMBER_WORDS[next]!;
          i++; // Skip the combined unit
        }
      }
      numbers.push(val);
    }
  }

  return numbers;
}

/**
 * Strips known person honorifics from tokens if the entity is a character.
 */
function stripHonorificTokens(tokens: string[]): { honorifics: string[]; coreTokens: string[] } {
  const honorifics: string[] = [];
  const coreTokens: string[] = [];

  // Check multi-word honorifics first like "young master"
  let idx = 0;
  while (idx < tokens.length) {
    if (idx + 1 < tokens.length && PERSON_HONORIFICS.has(`${tokens[idx]} ${tokens[idx + 1]}`)) {
      honorifics.push(`${tokens[idx]} ${tokens[idx + 1]}`);
      idx += 2;
    } else if (PERSON_HONORIFICS.has(tokens[idx]!)) {
      honorifics.push(tokens[idx]!);
      idx++;
    } else {
      coreTokens.push(tokens[idx]!);
      idx++;
    }
  }

  return { honorifics, coreTokens };
}

function cleanRawName(value: string | undefined | null): string {
  return value ? value.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "") : "";
}

/**
 * Checks if two entity types are strictly incompatible.
 */
export function areTypesIncompatible(typeA: EntityType, typeB: EntityType): boolean {
  if (typeA === typeB) return false;
  return INCOMPATIBLE_TYPE_PAIRS.some(
    ([t1, t2]) => (typeA === t1 && typeB === t2) || (typeA === t2 && typeB === t1),
  );
}

/**
 * Evaluates duplicate scoring and candidate classification between two canonical entities.
 */
export function duplicateScore(
  a: CanonicalEntity,
  b: CanonicalEntity,
  context?: DuplicateContext,
): DuplicateScoreResult {
  // 1. Established Relationship Check:
  // If an established relationship exists between a and b, they are distinct entities.
  const relationships = context?.relationships ?? context?.bible?.canonicalRelationships ?? [];
  const hasDirectRelationship = relationships.some(
    (rel) =>
      (rel.sourceEntityId === a.id && rel.targetEntityId === b.id) ||
      (rel.sourceEntityId === b.id && rel.targetEntityId === a.id),
  );
  const narrationMatch = [
    ...narrationRenderings(a).filter((item) => normalizeEntityName(item.value) === normalizeEntityName(b.canonicalName)).map((item) => ({ owner: a, duplicate: b, ...item })),
    ...narrationRenderings(b).filter((item) => normalizeEntityName(item.value) === normalizeEntityName(a.canonicalName)).map((item) => ({ owner: b, duplicate: a, ...item })),
  ][0];
  if (hasDirectRelationship) {
    return {
      confidence: 0,
      reason: "Entities have an established relationship between them",
      recommendation: "needs_review",
      conflict: "relationship",
    };
  }

  // Extract raw clean names (without title stripping)
  const aRawCanonical = cleanRawName(a.canonicalName);
  const bRawCanonical = cleanRawName(b.canonicalName);

  // Extract all names (with title stripping)
  const aNormCanonical = normalizeEntityName(a.canonicalName);
  const bNormCanonical = normalizeEntityName(b.canonicalName);
  const aNormOriginal = a.originalName ? normalizeEntityName(a.originalName) : "";
  const bNormOriginal = b.originalName ? normalizeEntityName(b.originalName) : "";
  const aNormAliases = a.aliases.map(normalizeEntityName).filter(Boolean);
  const bNormAliases = b.aliases.map(normalizeEntityName).filter(Boolean);

  const aAllNames = [aNormCanonical, aNormOriginal, ...aNormAliases].filter(Boolean);
  const bAllNames = [bNormCanonical, bNormOriginal, ...bNormAliases].filter(Boolean);

  // 2. Exact Identity Evidence (Tier 1)
  const exactCanonicalMatch = aRawCanonical.length > 0 && aRawCanonical === bRawCanonical;
  const exactOriginalMatch = aNormOriginal.length > 0 && bNormOriginal.length > 0 && aNormOriginal === bNormOriginal;
  const aAliasMatchesBCanonical = bNormCanonical.length > 0 && aNormAliases.includes(bNormCanonical);
  const bAliasMatchesACanonical = aNormCanonical.length > 0 && bNormAliases.includes(aNormCanonical);
  const exactAliasMatch = aAliasMatchesBCanonical || bAliasMatchesACanonical;

  // 3. Numeric Qualifier Conflict
  // Compare numeric tokens from canonical names
  const aNumbers = extractNumericTokens(a.canonicalName);
  const bNumbers = extractNumericTokens(b.canonicalName);

  if (aNumbers.length > 0 && bNumbers.length > 0) {
    const aSorted = [...aNumbers].sort((x, y) => x - y);
    const bSorted = [...bNumbers].sort((x, y) => x - y);
    const numbersMatch =
      aSorted.length === bSorted.length && aSorted.every((val, idx) => val === bSorted[idx]);
    if (!numbersMatch) {
      return {
        confidence: 0,
        reason: "Distinct numeric qualifiers indicate separate identities",
        recommendation: "needs_review",
        conflict: "numeric",
      };
    }
  } else if ((aNumbers.length > 0 && bNumbers.length === 0) || (aNumbers.length === 0 && bNumbers.length > 0)) {
    // One has a number qualifier and the other does not (e.g. Level 44 vs Level)
    if (!exactOriginalMatch && !exactAliasMatch) {
      return {
        confidence: 0,
        reason: "Numeric qualifier distinguishes specialized instance from generic concept",
        recommendation: "needs_review",
        conflict: "numeric",
      };
    }
  }

  // 4. Original-Name Conflict
  // If both entities have original Chinese names and they differ, that is strong negative evidence.
  if (aNormOriginal && bNormOriginal && aNormOriginal !== bNormOriginal) {
    // Only permit if one is an explicit alias of the other
    if (narrationMatch || !exactAliasMatch) {
      return {
        confidence: 0,
        reason: "Different original-language names indicate separate identities",
        recommendation: "needs_review",
        conflict: "original_name",
      };
    }
  }

  // 5. Entity Type Conflict
  if (areTypesIncompatible(a.type, b.type)) {
    // Overridable ONLY by exact Tier 1 evidence (exact original name or exact alias match)
    if (narrationMatch || (!exactOriginalMatch && !exactAliasMatch)) {
      return {
        confidence: 0,
        reason: `Incompatible entity types (${a.type} vs ${b.type}) with no strong identity evidence`,
        recommendation: "needs_review",
        conflict: "type",
      };
    }
  }

  // 6. Check Tier 1 Positive Matches
  if (exactCanonicalMatch && a.type === b.type) {
    return {
      confidence: 0.99,
      reason: "Exact normalized canonical name match",
      recommendation: "merge",
    };
  }

  if (exactOriginalMatch) {
    return {
      confidence: 0.98,
      reason: `Exact original-language name match ('${a.originalName}')`,
      recommendation: "merge",
    };
  }

  if (narrationMatch) return {
    confidence: 0.97,
    reason: `${narrationMatch.duplicate.canonicalName} is ${narrationMatch.owner.canonicalName}'s ${narrationMatch.kind.replaceAll("_", " ")}`,
    recommendation: "needs_review",
  };

  if (exactAliasMatch) {
    const chaptersA = new Set(a.provenance.map((p) => p.chapter));
    const chaptersOverlap = b.provenance.some((p) => chaptersA.has(p.chapter));
    const confidence = chaptersOverlap ? 0.96 : 0.92;
    return {
      confidence,
      reason: chaptersOverlap
        ? "Canonical name matches entity alias with supporting chapter provenance"
        : "Canonical name matches entity alias",
      recommendation: "merge",
    };
  }


  // 7. Token-based Analysis & Qualifier Conflict
  const aTokens = tokenizeEntityName(a.canonicalName);
  const bTokens = tokenizeEntityName(b.canonicalName);

  // Check character honorific variations
  const isCharacterComparison = a.type === "character" && b.type === "character";
  const aHonorific = isCharacterComparison ? stripHonorificTokens(aTokens) : { honorifics: [], coreTokens: aTokens };
  const bHonorific = isCharacterComparison ? stripHonorificTokens(bTokens) : { honorifics: [], coreTokens: bTokens };

  const aCore = aHonorific.coreTokens.join(" ");
  const bCore = bHonorific.coreTokens.join(" ");

  if (isCharacterComparison) {
    const aCoreTokens = aHonorific.coreTokens;
    const bCoreTokens = bHonorific.coreTokens;
    const hasHonorific = aHonorific.honorifics.length > 0 || bHonorific.honorifics.length > 0;

    const exactCoreMatch = aCore.length > 0 && aCore === bCore;
    const surnameMatch =
      hasHonorific &&
      ((aCoreTokens.length === 1 && bCoreTokens.length >= 2 && aCoreTokens[0] === bCoreTokens[0]) ||
        (bCoreTokens.length === 1 && aCoreTokens.length >= 2 && bCoreTokens[0] === aCoreTokens[0]));

    if (exactCoreMatch || surnameMatch) {
      const honorificName = [...aHonorific.honorifics, ...bHonorific.honorifics][0] || "title";
      const chaptersA = new Set(a.provenance.map((p) => p.chapter));
      const chaptersOverlap = b.provenance.some((p) => chaptersA.has(p.chapter));
      const sharedAliases = aNormAliases.some((alias) => bNormAliases.includes(alias));
      const sharedOriginal = aNormOriginal && bNormOriginal && aNormOriginal === bNormOriginal;

      if (exactCoreMatch) {
        if (sharedOriginal || sharedAliases || chaptersOverlap) {
          return {
            confidence: 0.90,
            reason: `Honorific variation with matching supporting evidence ('${honorificName}')`,
            recommendation: "merge",
          };
        }
        return {
          confidence: 0.75,
          reason: `Honorific variation ('${honorificName}'), but lacks supporting identity evidence. Review required.`,
          recommendation: "needs_review",
        };
      }

      if (surnameMatch) {
        if (sharedOriginal || sharedAliases || chaptersOverlap) {
          return {
            confidence: 0.78,
            reason: `Surname honorific variation ('${honorificName}') with overlapping story context. Review required.`,
            recommendation: "needs_review",
          };
        }
        return {
          confidence: 0.72,
          reason: `Surname honorific variation ('${honorificName}'), but lacks supporting identity evidence. Review required.`,
          recommendation: "needs_review",
        };
      }
    }
  }

  // 8. Semantic Qualifier Conflict Detection
  // Check if one name contains all tokens of the other plus extra tokens
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);

  const aContainsB = bTokens.length > 0 && bTokens.every((t) => aSet.has(t));
  const bContainsA = aTokens.length > 0 && aTokens.every((t) => bSet.has(t));

  if (aContainsB || bContainsA) {
    const extraTokens = aContainsB
      ? aTokens.filter((t) => !bSet.has(t))
      : bTokens.filter((t) => !aSet.has(t));

    // Check if extra tokens include identity-defining qualifiers
    const qualifier = extraTokens.find(
      (t) => IDENTIFIER_QUALIFIERS.has(t) || t.length >= 3,
    );

    if (qualifier) {
      // E.g. "Monster Encyclopedia" vs "Monster", "Seaside Secret Realm" vs "Secret Realm"
      return {
        confidence: 0,
        reason: `Names overlap, but "${qualifier}" is an identity-defining qualifier and no supporting identity evidence was found`,
        recommendation: "needs_review",
        conflict: "semantic_qualifier",
      };
    }
  }

  // 9. Exact normalized match across any names/aliases with compatible types
  if (aAllNames.some((n) => bAllNames.includes(n))) {
    return {
      confidence: 0.90,
      reason: "Shared normalized entity name or alias",
      recommendation: "merge",
    };
  }

  // Default: no duplicate
  return {
    confidence: 0,
    reason: "Insufficient identity evidence for duplicate merge",
    recommendation: "needs_review",
  };
}

/**
 * Finds candidate duplicate pairs among canonical entities with bounded candidate generation.
 */
export function findDuplicateSuggestions(
  entities: CanonicalEntity[],
  context?: DuplicateContext,
): DuplicateSuggestion[] {
  const positions = new Map(entities.map((entity, index) => [entity.id, index]));
  const narrationOwners = new Map<string, Set<string>>();
  for (const entity of entities) for (const rendering of narrationRenderings(entity)) {
    const key = normalizeEntityName(rendering.value);
    if (!key) continue;
    const owners = narrationOwners.get(key) ?? new Set<string>(); owners.add(entity.id); narrationOwners.set(key, owners);
  }

  // Index 1: Exact name / alias / originalName lookup for O(N) candidate generation
  const exactIndex = new Map<string, CanonicalEntity[]>();
  for (const entity of entities) {
    const names = [entity.canonicalName, entity.originalName, ...entity.aliases, ...narrationRenderings(entity).map((item) => item.value)]
      .map(normalizeEntityName)
      .filter(Boolean);
    for (const name of names) {
      const list = exactIndex.get(name) ?? [];
      if (!list.some((e) => e.id === entity.id)) list.push(entity);
      exactIndex.set(name, list);
    }
  }

  const pairs = new Map<string, [CanonicalEntity, CanonicalEntity]>();

  // Add pairs from exact name index
  for (const list of exactIndex.values()) {
    if (list.length > 1) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!;
          const b = list[j]!;
          if (a.id === b.id) continue;
          const ids = [a.id, b.id].sort();
          const key = `${ids[0]}:${ids[1]}`;
          if (!pairs.has(key)) {
            pairs.set(key, (positions.get(a.id) ?? 0) <= (positions.get(b.id) ?? 0) ? [a, b] : [b, a]);
          }
        }
      }
    }
  }

  // Index 2: Sorted lexical window for honorifics / prefix candidates
  const records = entities
    .flatMap((entity) =>
      [entity.canonicalName, entity.originalName, ...entity.aliases]
        .map(normalizeEntityName)
        .filter(Boolean)
        .map((name) => ({ name, entity })),
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  const windowSize = 10;
  for (let left = 0; left < records.length; left++) {
    for (let right = left + 1; right < Math.min(records.length, left + windowSize); right++) {
      const a = records[left]!.entity;
      const b = records[right]!.entity;
      if (a.id === b.id) continue;
      const ids = [a.id, b.id].sort();
      const key = `${ids[0]}:${ids[1]}`;
      if (!pairs.has(key)) {
        pairs.set(key, (positions.get(a.id) ?? 0) <= (positions.get(b.id) ?? 0) ? [a, b] : [b, a]);
      }
    }
  }

  const output: DuplicateSuggestion[] = [];

  for (const [id, [a, b]] of pairs) {
    const scored = duplicateScore(a, b, context);
    // Preserve strict merge scoring while still surfacing identical labels of
    // different classes as a review-only suggestion in the editor.
    let score = a.type !== b.type && normalizeEntityName(a.canonicalName) === normalizeEntityName(b.canonicalName) && scored.conflict !== "original_name" && scored.conflict !== "relationship"
      ? { confidence: 0.9, reason: `Same normalized canonical name across ${a.type} and ${b.type}; review identity and type`, recommendation: "needs_review" as const }
      : scored;
    const ambiguousRendering = [a.canonicalName, b.canonicalName].some((name) => (narrationOwners.get(normalizeEntityName(name))?.size ?? 0) > 1);
    if (ambiguousRendering && score.confidence === 0.97) score = { confidence: 0.85, reason: "Several entities use this narration rendering; review identity before merging", recommendation: "needs_review" };
    if (score.confidence < 0.70) continue;

    const chapters = unique(
      [...a.provenance, ...b.provenance].map((item) => String(item.chapter)),
    )
      .map(Number)
      .sort((x, y) => x - y)
      .slice(0, 20);

    output.push({
      id,
      entityIds: [a.id, b.id],
      entities: [
        { id: a.id, name: a.canonicalName },
        { id: b.id, name: b.canonicalName },
      ],
      confidence: score.confidence,
      reason: score.reason,
      recommendation: score.recommendation,
      ...(score.confidence === 0.97 && narrationRenderings(a).some((item) => normalizeEntityName(item.value) === normalizeEntityName(b.canonicalName)) ? { recommendedTargetEntityId: a.id, kind: "narration_rendering_duplicate" as const } : {}),
      ...(score.confidence === 0.97 && narrationRenderings(b).some((item) => normalizeEntityName(item.value) === normalizeEntityName(a.canonicalName)) ? { recommendedTargetEntityId: b.id, kind: "narration_rendering_duplicate" as const } : {}),
      supportingChapters: chapters,
    });
  }

  return output.sort((a, b) => b.confidence - a.confidence);
}

function unique(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.normalize("NFKD").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
