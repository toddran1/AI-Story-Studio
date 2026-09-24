import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { z } from "zod";
import {
  CanonicalEntity,
  EntityType,
  MinorEntityReference,
  PersistenceDisposition,
  StoryBible,
  canonicalEntitySchema,
  emptyStoryBible,
  minorEntityReferenceSchema,
  storyBibleSchema,
} from "../domain/story-bible.js";
import { StageModelConfig } from "../domain/provider.js";
import { LLMProvider } from "../llm/provider.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { withStoryLock } from "../storage/story-lock.js";
import { fingerprint } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import {
  ManualDemotion,
  ManualPromotion,
  applyCanonicalOverlay,
  canonicalOverlaySchema,
  findDuplicateSuggestions,
  mergeCanonicalEntities,
} from "./canonical.js";
import { areTypesIncompatible } from "./duplicate-detection.js";
import { normalizeEntityName } from "./updater.js";

export interface PersistenceClassificationResult {
  disposition: PersistenceDisposition;
  confidence: number;
  parentEntityId?: string;
  existingEntityId?: string;
  reason: string;
}

export interface CandidateEntityInput {
  name: string;
  originalName?: string;
  type?: EntityType | "other";
  description?: string;
  aliases?: string[];
  firstSeenChapter?: number;
  lastSeenChapter?: number;
  status?: string;
  confidence?: number;
}

export interface ClassificationContext {
  canonicalEntities: CanonicalEntity[];
  minorReferences?: MinorEntityReference[];
  demotions?: ManualDemotion[];
  promotions?: ManualPromotion[];
  demotedEntityIds?: Set<string>;
  promotedReferenceIds?: Set<string>;
  parentAssignments?: Record<string, string>;
  manualOverrides?: Record<string, any>;
}

const SUB_LOCATION_KEYWORDS = [
  "hall", "room", "chamber", "courtyard", "gate", "garden", "estate", "villa",
  "residence", "parlor", "corridor", "passage", "cell", "dungeon", "pavilion",
  "terrace", "desk", "reception", "reception hall", "conference hall", "meeting room",
  "guest room", "study", "vault", "lobby", "entrance", "exit", "wall", "wing",
  "tower", "headquarters", "branch", "office", "quarters", "barracks", "ancestral hall",
  "training ground", "training room", "courtyard gate", "main gate", "back gate",
  "side room", "inner chamber", "outer courtyard", "balcony", "attic", "cellar",
  "storehouse", "warehouse", "depot", "armory", "library", "kitchen", "dining hall",
];

const GENERIC_INCIDENTAL_PATTERNS = [
  /\b(?:ordinary|common|generic|unnamed|temporary|random|standard)\s+(?:sword|blade|dagger|spear|shield|guard|soldier|shop|store|monster|beast|inn|hall|room|chair|table|building|carriage|horse)\b/i,
  /\b(?:temporary monster|generic guard|unnamed shop|ordinary sword|one-off building|minor disciple)\b/i,
  /\b(?:guard|soldier|disciple|clerk|shopkeeper|waiter|passerby|patrol|servant|maid)\s+#?\d+\b/i,
];

const MAJOR_GEOGRAPHIC_KEYWORDS = [
  "city", "town", "village", "province", "realm", "continent", "kingdom",
  "empire", "mountain", "mountains", "forest", "sea", "ocean", "river",
  "lake", "plain", "plains", "valley", "world", "dimension", "domain",
];

const aiClassificationResponseSchema = z.object({
  disposition: z.enum(["canonical", "minor_reference", "merge_existing", "needs_review"]),
  parentEntityId: z.string().optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(500),
});

/**
 * Synchronous, deterministic evaluation of entity persistence worthiness.
 * Enforces strict decision precedence:
 * 1. Explicit manual promotion
 * 2. Explicit manual demotion
 * 3. Protected / manual canonical decisions
 * 4. Matches established canonical entity
 * 5. Matches established minor reference
 * 6. Character title / Named artifact protections
 * 7. Sub-location / facility parent containment
 * 8. Generic incidental patterns
 * 9. Entity Type heuristics
 * 10. Default fallback
 */
export function classifyEntityPersistenceSync(
  candidate: CandidateEntityInput,
  context: ClassificationContext,
): PersistenceClassificationResult {
  const normName = normalizeEntityName(candidate.name);
  const normOriginal = candidate.originalName ? normalizeEntityName(candidate.originalName) : "";
  const candidateAliases = (candidate.aliases ?? []).map(normalizeEntityName).filter(Boolean);
  const allCandidateNames = new Set([normName, normOriginal, ...candidateAliases].filter(Boolean));

  // 1. Check if candidate matches an existing canonical entity
  // 1. Explicit manual promotion (overlay.promotions or context.promotedReferenceIds)
  if (context.promotions) {
    for (const promo of context.promotions) {
      if (allCandidateNames.has(normalizeEntityName(promo.name))) {
        return {
          disposition: "canonical",
          confidence: 1.0,
          reason: `Explicit manual promotion: ${promo.reason || "promoted by user"}`,
        };
      }
    }
  }
  if (context.promotedReferenceIds && context.minorReferences) {
    for (const ref of context.minorReferences) {
      if (context.promotedReferenceIds.has(ref.id)) {
        const refNames = [ref.name, ref.originalName, ...(ref.aliases ?? [])].map(normalizeEntityName).filter(Boolean);
        if (refNames.some((n) => allCandidateNames.has(n))) {
          return {
            disposition: "canonical",
            confidence: 1.0,
            reason: `Explicitly promoted reference '${ref.name}'`,
          };
        }
      }
    }
  }

  // 2. Explicit manual demotion (overlay.demotions or context.demotedEntityIds)
  if (context.demotions) {
    for (const demo of context.demotions) {
      const demoNames = [demo.name, demo.originalName].map(normalizeEntityName).filter(Boolean);
      if (demoNames.some((n) => allCandidateNames.has(n))) {
        const parentId = demo.parentEntityId ?? context.parentAssignments?.[demo.entityId];
        return {
          disposition: "minor_reference",
          confidence: 1.0,
          parentEntityId: parentId || undefined,
          reason: `Explicit manual demotion: ${demo.reason || "demoted by user"}`,
        };
      }
    }
  }
  if (context.demotedEntityIds) {
    for (const entity of context.canonicalEntities) {
      if (context.demotedEntityIds.has(entity.id)) {
        const entityNames = [entity.canonicalName, entity.originalName, ...entity.aliases].map(normalizeEntityName).filter(Boolean);
        if (entityNames.some((n) => allCandidateNames.has(n))) {
          const parentId = context.parentAssignments?.[entity.id];
          return {
            disposition: "minor_reference",
            confidence: 1.0,
            parentEntityId: parentId || undefined,
            reason: `Previously demoted by manual configuration`,
          };
        }
      }
    }
  }

  // 3. Protected / manual canonical decisions
  for (const entity of context.canonicalEntities) {
    const entityNames = [entity.canonicalName, entity.originalName, ...entity.aliases].map(normalizeEntityName).filter(Boolean);
    if (entityNames.some((n) => allCandidateNames.has(n))) {
      const override = context.manualOverrides?.[entity.id];
      const isProtected =
        entity.canonicalNameLocked ||
        override?.canonicalNameLocked ||
        Boolean(entity.preferredNarrationName || override?.preferredNarrationName) ||
        Boolean(entity.localizedNaming || override?.localizedNaming) ||
        entity.pronunciation?.locked ||
        entity.pronunciation?.source === "manual" ||
        Boolean(override?.pronunciation?.locked || override?.pronunciation?.source === "manual") ||
        entity.origin === "manual" ||
        Boolean(override?.notes || (entity.notes && entity.notes.trim().length > 0)) ||
        Boolean(override?.status) ||
        Boolean(override?.aliases && override.aliases.length > 0) ||
        Boolean(override?.aliasNarrationRules && override.aliasNarrationRules.length > 0) ||
        Boolean(entity.aliasNarrationRules && entity.aliasNarrationRules.length > 0);

      if (isProtected) {
        return {
          disposition: "canonical",
          confidence: 1.0,
          existingEntityId: entity.id,
          reason: `Protected canonical entity with manual configuration: '${entity.canonicalName}'`,
        };
      }
    }
  }

  // 4. Matches established canonical entity (without manual protection)
  for (const entity of context.canonicalEntities) {
    const entityNames = [entity.canonicalName, entity.originalName, ...entity.aliases].map(normalizeEntityName).filter(Boolean);
    if (entityNames.some((n) => allCandidateNames.has(n))) {
      return {
        disposition: "canonical",
        confidence: 1.0,
        existingEntityId: entity.id,
        reason: `Matches established canonical entity '${entity.canonicalName}'`,
      };
    }
  }

  // 2. Check if candidate was previously demoted in manual overlay
  if (context.demotedEntityIds) {
    for (const entity of context.canonicalEntities) {
      if (context.demotedEntityIds.has(entity.id) && allCandidateNames.has(normalizeEntityName(entity.canonicalName))) {
  // 5. Matches established minor reference
        return {
          disposition: "minor_reference",
          confidence: 1.0,
          reason: `Previously demoted by manual configuration`,
        };
      }
    }
  }

  // 3. Matches established minor reference
  if (context.minorReferences) {
    for (const ref of context.minorReferences) {
      const refNames = [ref.name, ref.originalName, ...(ref.aliases ?? [])].map(normalizeEntityName).filter(Boolean);
      if (refNames.some((n) => allCandidateNames.has(n))) {
        return {
          disposition: "minor_reference",
          confidence: 1.0,
          parentEntityId: ref.parentEntityId,
          reason: `Matches established minor reference '${ref.name}'`,
        };
      }
    }
  }

  // 4. Check if candidate was previously promoted
  if (context.promotions) {
    for (const promo of context.promotions) {
      if (allCandidateNames.has(normalizeEntityName(promo.name))) {
        return {
          disposition: "canonical",
          confidence: 1.0,
          reason: `Previously promoted by manual configuration: '${promo.name}'`,
        };
      }
    }
  }
  if (context.promotedReferenceIds) {
    for (const ref of context.minorReferences ?? []) {
      if (context.promotedReferenceIds.has(ref.id) && allCandidateNames.has(normalizeEntityName(ref.name))) {
        return {
          disposition: "canonical",
          confidence: 1.0,
          reason: `Previously promoted by manual configuration`,
        };
      }
    }
  }

  // 5. Character / Title or Named Artifact protections before sub-location heuristics
  const candidateType = candidate.type ?? "concept";
  const isCharacterTitle = /\b(?:patriarch|matriarch|elder|master|ancestor|sect master|clan head|leader|chief|commander|general|captain)\b/i.test(candidate.name);
  if (isCharacterTitle && candidateType !== "location") {
    return {
      disposition: "canonical",
      confidence: 0.9,
      reason: "Character with specific title or leadership role.",
    };
  }

  const isNamedArtifact = /\b(?:ancestral sword|ancient cauldron|sacred bell|dragon seal|heavenly mirror|divine spear)\b/i.test(candidate.name);
  if (isNamedArtifact && candidateType !== "location") {
    return {
      disposition: "canonical",
      confidence: 0.88,
      reason: "Named unique artifact with plot significance.",
    };
  }

  // 7. Semantic sub-location / facility parent containment detection
  if (candidateType === "location" || candidateType === "concept") {
    for (const entity of context.canonicalEntities) {
      if (entity.type !== "organization" && entity.type !== "location") continue;
      const entityNorm = normalizeEntityName(entity.canonicalName);
      if (entityNorm.length < 2) continue;

      // Check if candidate name contains the parent entity name plus a sub-location descriptor
      const candidateLower = candidate.name.toLowerCase();
      const entityLower = entity.canonicalName.toLowerCase();
      if (candidateLower.includes(entityLower) && candidateLower !== entityLower) {
        // Extract the remainder
        const remainder = candidateLower.replace(entityLower, "").replace(/['’]s/g, "").trim();
        const hasSubLocationNoun = SUB_LOCATION_KEYWORDS.some((kw) => {
          const regex = new RegExp(`\\b${kw}\\b`, "i");
          return regex.test(remainder);
        });

        if (hasSubLocationNoun) {
          return {
            disposition: "minor_reference",
            confidence: 0.95,
            parentEntityId: entity.id,
            reason: `Incidental sub-location associated with ${entity.canonicalName} with no independent recurring state.`,
          };
        }
      }
    }
  }

  // 5. Generic incidental patterns
  // 8. Generic incidental patterns
  for (const pattern of GENERIC_INCIDENTAL_PATTERNS) {
    if (pattern.test(candidate.name)) {
      return {
        disposition: "minor_reference",
        confidence: 0.92,
        reason: "Generic incidental concept with no independent narrative persistence.",
      };
    }
  }

  // 6. Character / Organization / Plot artifact / Ability signals
  // Characters with real names, specific original names, or explicit gender/pronouns deserve canonical identity
  // 9. Entity Type heuristics
  if (candidateType === "character") {
    // Check if it's a generic descriptor vs an actual character
    const isGenericRole = /^(?:guard|soldier|servant|waiter|passerby|patrol|disciple|clerk)\s*#?\d*$/i.test(candidate.name.trim());
    if (isGenericRole && !candidate.originalName) {
      return {
        disposition: "minor_reference",
        confidence: 0.88,
        reason: "Incidental unnamed character with no independent persistent identity.",
      };
    }
    const hasPriorAppearances = candidate.firstSeenChapter !== undefined && candidate.lastSeenChapter !== undefined && candidate.lastSeenChapter > candidate.firstSeenChapter;
    return {
      disposition: "canonical",
      confidence: 0.92,
      reason: hasPriorAppearances
        ? "Recurring character entity with independent narrative actions and persistent role."
        : "Character entity with independent narrative actions and persistent role.",
    };
  }

  if (candidateType === "organization") {
    // Factions, guilds, sects, clans are almost always canonical unless purely temporary
    const isMinorShop = /^(?:unnamed shop|small stall|vegetable stall|street vendor)\b/i.test(candidate.name);
    if (isMinorShop) {
      return {
        disposition: "minor_reference",
        confidence: 0.9,
        reason: "Incidental commercial venue with no independent organization state.",
      };
    }
    return {
      disposition: "canonical",
      confidence: 0.93,
      reason: "Story organization or faction with persistent collective identity.",
    };
  }

  if (candidateType === "ability") {
    return {
      disposition: "canonical",
      confidence: 0.88,
      reason: "Story technique or ability requiring persistent continuity tracking.",
    };
  }

  if (candidateType === "item") {
    const isGenericItem = /^(?:ordinary|common|wooden|iron|simple)\s+(?:sword|spear|knife|table|chair|cup|bowl|stone)\b/i.test(candidate.name);
    if (isGenericItem) {
      return {
        disposition: "minor_reference",
        confidence: 0.91,
        reason: "Common non-unique physical item with no persistent plot significance.",
      };
    }
    return {
      disposition: "canonical",
      confidence: 0.85,
      reason: "Named item or artifact with potential narrative importance.",
    };
  }

  if (candidateType === "location") {
    const isMajorGeographic = MAJOR_GEOGRAPHIC_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`, "i").test(candidate.name));
    if (isMajorGeographic) {
      return {
        disposition: "canonical",
        confidence: 0.9,
        reason: "Major geographic or administrative location requiring independent identity.",
      };
    }

    const isGenericRoomOrFacility = /^(?:east|west|north|south|inner|outer|front|back|central|upper|lower|first|second|third|main|side|guest|master|ancestral|private|secret|storage|meeting)?\s*(?:courtyard|room|hall|chamber|corridor|passage|wing|cellar|attic|parlor|study|storehouse|kitchen|dining hall|dining room|gate|balcony|terrace)(?:\s*#?\d+)?$/i.test(candidate.name.trim());
    if (isGenericRoomOrFacility) {
      return {
        disposition: "minor_reference",
        confidence: 0.9,
        reason: "Generic sub-location or room with no specific parent or independent geographical scope.",
      };
    }
  }

  // Default fallback:
  // 10. Default fallback:
  if (candidate.originalName && candidate.originalName.length >= 2) {
    return {
      disposition: "canonical",
      confidence: 0.8,
      reason: "Entity has distinct source-language proper name.",
    };
  }

  return {
    disposition: "needs_review",
    confidence: 0.5,
    reason: "Ambiguous persistence worthiness requiring editorial review.",
  };
}

/**
 * Classifies whether an extracted entity candidate warrants independent canonical persistence
 * or should be treated as a lightweight minor reference (often associated with a parent entity).
 */
export async function classifyEntityPersistence(
  candidate: CandidateEntityInput,
  context: ClassificationContext,
  options: {
    provider?: LLMProvider;
    config?: StageModelConfig;
    chapterEvidence?: string;
  } = {},
): Promise<PersistenceClassificationResult> {
  const syncResult = classifyEntityPersistenceSync(candidate, context);

  // If deterministic result is clear (high confidence), return immediately
  if (syncResult.confidence >= 0.85 || !options.provider || !options.config) {
    return syncResult;
  }

  // If ambiguous and provider is available, use compact structured prompt
  try {
    const parentCandidates = context.canonicalEntities
      .filter((e) => e.type === "organization" || e.type === "location")
      .slice(0, 20)
      .map((e) => `${e.id}: ${e.canonicalName} (${e.type})`)
      .join("\n");

    const response = await options.provider.generateStructured({
      model: options.config.model,
      instructions: `You are an expert story bible classifier. Determine whether the candidate entity warrants persistent independent canonical identity in the Story Bible, or if it is a lightweight minor reference (such as a sub-room, minor courtyard, generic item, or incidental object) that should be associated with a canonical parent entity if available. Return structured data with disposition ("canonical", "minor_reference", "merge_existing", or "needs_review"), confidence (0.0 to 1.0), optional parentEntityId, and a concise user-facing reason.`,
      input: [
        `Candidate: ${candidate.name}`,
        candidate.originalName ? `Original: ${candidate.originalName}` : "",
        `Type: ${candidate.type || "unknown"}`,
        candidate.description ? `Description: ${candidate.description}` : "",
        options.chapterEvidence ? `Evidence: ${options.chapterEvidence}` : "",
        `Existing canonical entities:\n${parentCandidates}`,
      ].filter(Boolean).join("\n"),
      schemaName: "entity_persistence_classification",
      schema: aiClassificationResponseSchema,
    });

    return {
      disposition: response.value.disposition,
      confidence: response.value.confidence,
      parentEntityId: response.value.parentEntityId,
      reason: response.value.reason,
    };
  } catch {
    return syncResult;
  }
}

export interface BibleAnalysisRecommendation {
  id: string;
  entityId: string;
  canonicalName: string;
  originalName: string;
  type: EntityType;
  appearances: { first: number; lastKnown: number; count: number };
  recommendation: "keep_canonical" | "minor_reference" | "merge" | "needs_review";
  parentEntityId?: string;
  parentEntityName?: string;
  targetEntityId?: string;
  targetEntityName?: string;
  confidence: number;
  reason: string;
  supportingChapters?: number[];
  protected: boolean;
  protectedReasons: string[];
  safeToAutoApply: boolean;
  /** What produced this recommendation. Omitted when the origin cannot be determined honestly. */
  source?: "deterministic" | "ai";
}

export interface BibleAnalysisReport {
  totalCanonical: number;
  keepCanonicalCount: number;
  convertMinorCount: number;
  mergeExistingCount: number;
  possibleDuplicatesCount: number;
  needsReviewCount: number;
  protectedCount: number;
  recommendations: BibleAnalysisRecommendation[];
}

/**
 * Analyzes all existing canonical entities in a story to discover cleanup opportunities.
 * Purely read-only; does not modify any files.
 */
export async function analyzeStoryBible(
  root: string,
  slug: string,
  options: { provider?: LLMProvider; config?: StageModelConfig; duplicateSuggestions?: ReturnType<typeof findDuplicateSuggestions> } = {},
): Promise<BibleAnalysisReport> {
  const paths = storyPaths(root, slug, 1);
  const rawBible = await readJsonIfExists(paths.bible);
  const bible = rawBible ? storyBibleSchema.parse(rawBible) : undefined;
  if (!bible) {
    return {
      totalCanonical: 0,
      keepCanonicalCount: 0,
      convertMinorCount: 0,
      mergeExistingCount: 0,
      possibleDuplicatesCount: 0,
      needsReviewCount: 0,
      protectedCount: 0,
      recommendations: [],
    };
  }

  const overlayRaw = await readJsonIfExists(paths.bibleCanonicalManual);
  const overlay = overlayRaw ? canonicalOverlaySchema.safeParse(overlayRaw) : undefined;
  const manualOverrides = overlay?.success ? overlay.data.overrides : {};
  // Callers that already derived suggestions for this same revision (e.g. the
  // shared review context) pass them in so detection never runs twice; the
  // scoring itself is unchanged.
  const duplicateSuggestions = options.duplicateSuggestions ?? findDuplicateSuggestions(bible.canonicalEntities, { bible });
  const duplicatePairs = new Map<
    string,
    {
      target: CanonicalEntity;
      confidence: number;
      reason: string;
      recommendation?: "merge" | "needs_review";
      supportingChapters?: number[];
    }
  >();

  for (const suggestion of duplicateSuggestions) {
    if (suggestion.confidence >= 0.70) {
      const [firstId, secondId] = suggestion.entityIds;
      const first = bible.canonicalEntities.find((e) => e.id === firstId);
      const second = bible.canonicalEntities.find((e) => e.id === secondId);
      if (first && second) {
        // Target is the earlier or locked one
        const target =
          first.canonicalNameLocked || first.firstAppearance <= second.firstAppearance
            ? first
            : second;
        const duplicate = target === first ? second : first;
        duplicatePairs.set(duplicate.id, {
          target,
          confidence: suggestion.confidence,
          reason: suggestion.reason,
          recommendation: suggestion.recommendation,
          supportingChapters: suggestion.supportingChapters,
        });
      }
    }
  }

  const recommendations: BibleAnalysisRecommendation[] = [];
  const entityMap = new Map(bible.canonicalEntities.map((e) => [e.id, e]));
  // Persistence classifications only consult a provider when one is supplied;
  // duplicate detection above is always deterministic.
  const classificationSource: "deterministic" | "ai" = options.provider ? "ai" : "deterministic";

  for (const entity of bible.canonicalEntities) {
    const protectedReasons: string[] = [];
    const override = manualOverrides[entity.id];

    if (entity.canonicalNameLocked) protectedReasons.push("Canonical name locked");
    if (entity.preferredNarrationName) protectedReasons.push(`Preferred narration name: ${entity.preferredNarrationName}`);
    if (entity.localizedNaming) protectedReasons.push(`Localized naming configured: ${entity.localizedNaming.fullName || entity.localizedNaming.shortName}`);
    if (entity.pronunciation?.locked || entity.pronunciation?.source === "manual") protectedReasons.push("Manual pronunciation locked");
    if (entity.canonicalNameLocked || override?.canonicalNameLocked) protectedReasons.push("Canonical name locked");
    if (entity.preferredNarrationName || override?.preferredNarrationName) protectedReasons.push(`Preferred narration name: ${entity.preferredNarrationName || override?.preferredNarrationName}`);
    if (entity.localizedNaming || override?.localizedNaming) protectedReasons.push(`Localized naming configured: ${(entity.localizedNaming || override?.localizedNaming)?.fullName || (entity.localizedNaming || override?.localizedNaming)?.shortName}`);
    if (entity.pronunciation?.locked || entity.pronunciation?.source === "manual" || override?.pronunciation?.locked || override?.pronunciation?.source === "manual") protectedReasons.push("Manual pronunciation locked");
    if (entity.origin === "manual") protectedReasons.push("Created manually");
    if (override?.notes || (entity.notes && entity.notes.trim().length > 0)) protectedReasons.push("Manual notes exist");
    if (override?.status) protectedReasons.push(`Manual status: ${override.status}`);
    if (override?.aliases && override.aliases.length > 0) protectedReasons.push("Manual aliases configured");
    if ((entity.aliasNarrationRules && entity.aliasNarrationRules.length > 0) || (override?.aliasNarrationRules && override.aliasNarrationRules.length > 0)) protectedReasons.push("Alias narration rules configured");
    if (bible.canonicalRelationships.some((r) => (r.sourceEntityId === entity.id || r.targetEntityId === entity.id) && (r.locked || r.origin === "manual"))) {
      protectedReasons.push("Protected relationship exists");
    }

    const isProtected = protectedReasons.length > 0;
    const appearances = {
      first: entity.firstAppearance,
      lastKnown: entity.lastKnownAppearance,
      count: Math.max(1, entity.provenance.length),
    };

    // Check duplicate pair
    const duplicate = duplicatePairs.get(entity.id);
    if (duplicate && duplicate.confidence >= 0.70) {
      const recId = `rec_${fingerprint({ entityId: entity.id, action: "merge", target: duplicate.target.id }).slice(0, 16)}`;
      const isActionableMerge =
        !isProtected &&
        duplicate.confidence >= 0.85 &&
        duplicate.recommendation === "merge";

      recommendations.push({
        id: recId,
        entityId: entity.id,
        canonicalName: entity.canonicalName,
        originalName: entity.originalName,
        type: entity.type,
        appearances,
        recommendation: isProtected ? "needs_review" : (isActionableMerge ? "merge" : "needs_review"),
        targetEntityId: duplicate.target.id,
        targetEntityName: duplicate.target.canonicalName,
        confidence: duplicate.confidence,
        reason: isProtected
          ? `Possible duplicate of '${duplicate.target.canonicalName}', but entity has protected manual configuration.`
          : (isActionableMerge
              ? `Duplicate of canonical entity '${duplicate.target.canonicalName}' (${duplicate.reason}).`
              : `Possible duplicate of '${duplicate.target.canonicalName}' (${duplicate.reason}). Review required.`),
        supportingChapters: duplicate.supportingChapters,
        protected: isProtected,
        protectedReasons,
        // A merge across incompatible types is never auto-safe, even at high confidence.
        safeToAutoApply: !isProtected && duplicate.confidence >= 0.90 && duplicate.recommendation === "merge" && !areTypesIncompatible(entity.type, duplicate.target.type),
        source: "deterministic",
      });
      continue;
    }

    // Evaluate persistence classification
    const classification = await classifyEntityPersistence(
      {
        name: entity.canonicalName,
        originalName: entity.originalName,
        type: entity.type,
        description: entity.description,
        aliases: entity.aliases,
        firstSeenChapter: entity.firstAppearance,
        lastSeenChapter: entity.lastKnownAppearance,
      },
      {
        canonicalEntities: bible.canonicalEntities.filter((e) => e.id !== entity.id),
        minorReferences: bible.minorReferences,
        manualOverrides,
      },
      options,
    );

    if (classification.disposition === "minor_reference") {
      const parent = classification.parentEntityId ? entityMap.get(classification.parentEntityId) : undefined;
      const recId = `rec_${fingerprint({ entityId: entity.id, action: "minor_reference", parent: classification.parentEntityId }).slice(0, 16)}`;
      recommendations.push({
        id: recId,
        entityId: entity.id,
        canonicalName: entity.canonicalName,
        originalName: entity.originalName,
        type: entity.type,
        appearances,
        recommendation: isProtected ? "needs_review" : "minor_reference",
        parentEntityId: classification.parentEntityId,
        parentEntityName: parent?.canonicalName,
        confidence: classification.confidence,
        reason: isProtected
          ? `Identified as minor reference, but entity has protected manual configuration.`
          : classification.reason,
        protected: isProtected,
        protectedReasons,
        safeToAutoApply: !isProtected && classification.confidence >= 0.9,
        source: classificationSource,
      });
    } else if (classification.disposition === "needs_review") {
      const recId = `rec_${fingerprint({ entityId: entity.id, action: "needs_review" }).slice(0, 16)}`;
      recommendations.push({
        id: recId,
        entityId: entity.id,
        canonicalName: entity.canonicalName,
        originalName: entity.originalName,
        type: entity.type,
        appearances,
        recommendation: "needs_review",
        confidence: classification.confidence,
        reason: classification.reason,
        protected: isProtected,
        protectedReasons,
        safeToAutoApply: false,
        source: classificationSource,
      });
    } else {
      const recId = `rec_${fingerprint({ entityId: entity.id, action: "keep_canonical" }).slice(0, 16)}`;
      recommendations.push({
        id: recId,
        entityId: entity.id,
        canonicalName: entity.canonicalName,
        originalName: entity.originalName,
        type: entity.type,
        appearances,
        recommendation: "keep_canonical",
        confidence: classification.confidence,
        reason: classification.reason,
        protected: isProtected,
        protectedReasons,
        safeToAutoApply: false,
        source: classificationSource,
      });
    }
  }

  const report: BibleAnalysisReport = {
    totalCanonical: bible.canonicalEntities.length,
    keepCanonicalCount: recommendations.filter((r) => r.recommendation === "keep_canonical").length,
    convertMinorCount: recommendations.filter((r) => r.recommendation === "minor_reference").length,
    mergeExistingCount: recommendations.filter((r) => r.recommendation === "merge").length,
    possibleDuplicatesCount: duplicateSuggestions.length,
    needsReviewCount: recommendations.filter((r) => r.recommendation === "needs_review").length,
    protectedCount: recommendations.filter((r) => r.protected).length,
    recommendations: recommendations.sort((a, b) => {
      // Order: minor_reference, merge, needs_review, keep_canonical
      const rank = (rec: BibleAnalysisRecommendation) =>
        rec.recommendation === "minor_reference" ? 1 : rec.recommendation === "merge" ? 2 : rec.recommendation === "needs_review" ? 3 : 4;
      return rank(a) - rank(b) || b.confidence - a.confidence;
    }),
  };

  return report;
}

/**
 * Demotes a canonical entity into a lightweight minor reference.
 * Persists the demotion decision in story-bible-canonical-manual.json so it survives rebuilds.
 */
export async function demoteCanonicalEntity(
  root: string,
  slug: string,
  entityId: string,
  options: {
    parentEntityId?: string;
    disposition?: PersistenceDisposition;
    reason?: string;
    force?: boolean;
    source?: "manual" | "analyzer" | "ai";
  } = {},
) {
  return withStoryLock(root, slug, `demote canonical entity ${entityId}`, async () => {
    const paths = storyPaths(root, slug, 1);
    const bibleRaw = await readJsonIfExists(paths.bible);
    if (!bibleRaw) throw new Error("Story Bible not found");
    const bible = storyBibleSchema.parse(bibleRaw);

    const refId = `ref_${entityId.startsWith("ent_") ? entityId.slice(4) : entityId}`;
    const entity = bible.canonicalEntities.find((e) => e.id === entityId);

    // Idempotency: if already demoted to minor references and not in canonicalEntities
    if (!entity) {
      const alreadyRef = bible.minorReferences.find(
        (r) => r.id === refId || r.demotedFromEntityId === entityId,
      );
      if (alreadyRef) {
        return {
          status: "already_demoted" as const,
          entityId,
          referenceId: alreadyRef.id,
          bible,
        };
      }
      throw new Error(`Canonical entity '${entityId}' was not found`);
    }

    const overlay = canonicalOverlaySchema.parse(
      (await readJsonIfExists(paths.bibleCanonicalManual)) ?? {
        version: 1,
        overrides: {},
        merges: [],
        demotions: [],
        promotions: [],
        parentAssignments: {},
      },
    );

    const override = overlay.overrides[entityId];

    // Check protection
    if (!options.force) {
      const protectedReasons: string[] = [];
      if (entity.canonicalNameLocked || override?.canonicalNameLocked) protectedReasons.push("canonical name is locked");
      if (entity.preferredNarrationName || override?.preferredNarrationName) protectedReasons.push("preferred narration name is set");
      if (entity.localizedNaming || override?.localizedNaming) protectedReasons.push("localized naming is configured");
      if (entity.pronunciation?.locked || entity.pronunciation?.source === "manual" || override?.pronunciation?.locked || override?.pronunciation?.source === "manual") protectedReasons.push("pronunciation is locked");
      if (entity.origin === "manual") protectedReasons.push("entity was created manually");
      if (override?.notes || (entity.notes && entity.notes.trim().length > 0)) protectedReasons.push("manual notes exist");
      if (override?.status) protectedReasons.push("manual status is configured");
      if (override?.aliases && override.aliases.length > 0) protectedReasons.push("manual aliases configured");
      if ((entity.aliasNarrationRules && entity.aliasNarrationRules.length > 0) || (override?.aliasNarrationRules && override.aliasNarrationRules.length > 0)) protectedReasons.push("alias narration rules configured");

      if (protectedReasons.length > 0) {
        throw new Error(`Cannot demote '${entity.canonicalName}': entity has protected manual configuration (${protectedReasons.join(", ")})`);
      }
    }

    // Validate parentEntityId if provided
    if (options.parentEntityId) {
      if (options.parentEntityId === entityId) {
        throw new Error(`Cannot set parent entity to self for '${entity.canonicalName}'`);
      }
      const parentExists = bible.canonicalEntities.some((e) => e.id === options.parentEntityId);
      if (!parentExists) {
        throw new Error(`Parent entity '${options.parentEntityId}' was not found in canonical entities`);
      }
    }

    const now = new Date().toISOString();
    const reason = options.reason || "Demoted to minor entity reference";

    // Add or update demotion record in overlay
    const existingDemotion = overlay.demotions.find((d) => d.entityId === entityId);
    if (!existingDemotion) {
      overlay.demotions.push({
        entityId,
        name: entity.canonicalName,
        originalName: entity.originalName || undefined,
        type: entity.type,
        parentEntityId: options.parentEntityId,
        reason,
        demotedAt: now,
        source: options.source ?? "manual",
      });
    } else {
      existingDemotion.name = entity.canonicalName;
      if (options.parentEntityId) existingDemotion.parentEntityId = options.parentEntityId;
      existingDemotion.reason = reason;
      existingDemotion.source = options.source ?? existingDemotion.source;
    }

    if (options.parentEntityId) {
      overlay.parentAssignments[refId] = options.parentEntityId;
      overlay.parentAssignments[entityId] = options.parentEntityId;
    }

    // Remove any existing manual promotion record
    overlay.promotions = overlay.promotions.filter((p) => p.referenceId !== refId && p.name !== entity.canonicalName);
    overlay.promotions = overlay.promotions.filter((p) => p.referenceId !== refId && normalizeEntityName(p.name) !== normalizeEntityName(entity.canonicalName));

    // Create or update minor reference in bible
    const existingRef = bible.minorReferences.find(
      (r) => r.id === refId || r.demotedFromEntityId === entityId || normalizeEntityName(r.name) === normalizeEntityName(entity.canonicalName),
    );

    if (!existingRef) {
      bible.minorReferences.push({
        id: refId,
        name: entity.canonicalName,
        originalName: entity.originalName || undefined,
        type: entity.type as any,
        parentEntityId: options.parentEntityId,
        aliases: entity.aliases,
        firstSeenChapter: entity.firstAppearance,
        lastSeenChapter: entity.lastKnownAppearance,
        occurrenceCount: Math.max(1, entity.provenance.length),
        sourceEvidence: entity.provenance.map((p) => ({ chapter: p.chapter })),
        disposition: options.disposition ?? "minor_reference",
        source: "manual_demotion",
        status: "minor",
        demotedFromEntityId: entityId,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      existingRef.status = "minor";
      existingRef.demotedFromEntityId = entityId;
      if (options.parentEntityId) existingRef.parentEntityId = options.parentEntityId;
      existingRef.updatedAt = now;
    }

    // Remove entity from canonicalEntities
    bible.canonicalEntities = bible.canonicalEntities.filter((e) => e.id !== entityId);

    // Dependency reconciliation:
    // 1. Canonical relationships
    if (options.parentEntityId) {
      for (const rel of bible.canonicalRelationships) {
        if (rel.sourceEntityId === entityId) rel.sourceEntityId = options.parentEntityId;
        if (rel.targetEntityId === entityId) rel.targetEntityId = options.parentEntityId;
      }
      // Remove self-relationships
      bible.canonicalRelationships = bible.canonicalRelationships.filter(
        (rel) => rel.sourceEntityId !== rel.targetEntityId,
      );
    } else {
      // Remove relationships involving demoted entity
      bible.canonicalRelationships = bible.canonicalRelationships.filter(
        (rel) => rel.sourceEntityId !== entityId && rel.targetEntityId !== entityId,
      );
    }

    // 2. Child minor references
    for (const childRef of bible.minorReferences) {
      if (childRef.parentEntityId === entityId) {
        if (options.parentEntityId) {
          childRef.parentEntityId = options.parentEntityId;
          overlay.parentAssignments[childRef.id] = options.parentEntityId;
        } else {
          childRef.parentEntityId = undefined;
          delete overlay.parentAssignments[childRef.id];
        }
      }
    }

    // 3. Timeline events
    if (options.parentEntityId) {
      for (const event of bible.entityTimeline) {
        if (event.entityId === entityId) event.entityId = options.parentEntityId;
        if (event.relatedEntityId === entityId) event.relatedEntityId = options.parentEntityId;
      }
    }

    // Audit
    bible.granularityAudits.push({
      id: randomUUID(),
      action: "demoted",
      fromEntityId: entityId,
      parentEntityId: options.parentEntityId,
      referenceId: refId,
      name: entity.canonicalName,
      reason,
      confidence: 1.0,
      source: options.source ?? "manual",
      timestamp: now,
    });

    await atomicWriteJson(paths.bibleCanonicalManual, overlay);
    await atomicWriteJson(paths.bible, bible);
    return { status: "demoted", entityId, referenceId: refId, bible };
    return { status: "demoted" as const, entityId, referenceId: refId, bible };
  });
}

/**
 * Promotes a minor entity reference into a full canonical entity.
 * Persists the promotion decision in story-bible-canonical-manual.json so it survives rebuilds.
 */
export async function promoteMinorReference(
  root: string,
  slug: string,
  referenceId: string,
  options: { reason?: string; source?: "manual" | "analyzer" | "ai" } = {},
) {
  return withStoryLock(root, slug, `promote minor reference ${referenceId}`, async () => {
    const paths = storyPaths(root, slug, 1);
    const bibleRaw = await readJsonIfExists(paths.bible);
    if (!bibleRaw) throw new Error("Story Bible not found");
    const bible = storyBibleSchema.parse(bibleRaw);

    const overlay = canonicalOverlaySchema.parse(
      (await readJsonIfExists(paths.bibleCanonicalManual)) ?? {
        version: 1,
        overrides: {},
        merges: [],
        demotions: [],
        promotions: [],
        parentAssignments: {},
      },
    );

    const ref = bible.minorReferences.find((r) => r.id === referenceId);
    const promoRecord = overlay.promotions.find((p) => p.referenceId === referenceId);
    const derivedEntityId = referenceId.startsWith("ref_") ? `ent_${referenceId.slice(4)}` : undefined;

    // Idempotency: if already in canonicalEntities
    const targetEntityId = ref?.demotedFromEntityId;
    const existingCanonical = bible.canonicalEntities.find(
      (e) =>
        (targetEntityId && e.id === targetEntityId) ||
        (derivedEntityId && e.id === derivedEntityId) ||
        (ref && normalizeEntityName(e.canonicalName) === normalizeEntityName(ref.name)) ||
        (promoRecord && normalizeEntityName(e.canonicalName) === normalizeEntityName(promoRecord.name)),
    );

    if (!ref) {
      if (existingCanonical) {
        return { status: "already_promoted" as const, referenceId, entity: existingCanonical, bible };
      }
      throw new Error(`Minor reference '${referenceId}' was not found`);
    }

    if (existingCanonical && !ref.demotedFromEntityId) {
      return { status: "already_promoted" as const, referenceId, entity: existingCanonical, bible };
    }

    const now = new Date().toISOString();
    const reason = options.reason || "Promoted to canonical entity";
    const entityId = ref.demotedFromEntityId || `ent_${fingerprint({ name: ref.name, type: ref.type, origin: ref.originalName }).slice(0, 24)}`;

    // Remove any demotion record matching this entity or reference
    overlay.demotions = overlay.demotions.filter((d) => d.entityId !== entityId && normalizeEntityName(d.name) !== normalizeEntityName(ref.name));

    // Remove parent assignments for this reference / entity
    delete overlay.parentAssignments[referenceId];
    delete overlay.parentAssignments[entityId];

    // Record promotion
    const promotionSource: "manual" | "analyzer" | "ai" = options.source ?? "manual";
    overlay.promotions.push({
      referenceId,
      name: ref.name,
      promotedAt: now,
      reason,
      source: promotionSource,
    });

    const promotionOrigin: "manual" | "automatic" = promotionSource === "manual" ? "manual" : "automatic";

    // Create canonical entity
    const existingIndex = bible.canonicalEntities.findIndex((e) => e.id === entityId);
    const newEntity: CanonicalEntity = {
      id: entityId,
      type: (ref.type && ref.type !== "other" ? ref.type : "concept") as EntityType,
      canonicalName: ref.name,
      originalName: ref.originalName || "",
      description: ref.contextNotes || "",
      aliases: ref.aliases,
      firstAppearance: ref.firstSeenChapter || 1,
      lastKnownAppearance: ref.lastSeenChapter || ref.firstSeenChapter || 1,
      status: "unknown",
      notes: "",
      canonicalNameLocked: false,
      origin: promotionOrigin,
      provenance: ref.sourceEvidence.map((e) => ({
        chapter: e.chapter,
        kind: "extraction" as const,
        origin: promotionOrigin,
      })),
      aliasNarrationRules: [],
      mergedFromIds: [],
    };

    if (existingIndex >= 0) {
      bible.canonicalEntities[existingIndex] = newEntity;
    } else {
      bible.canonicalEntities.push(newEntity);
    }

    // If parentEntityId was set, create a relationship
    if (ref.parentEntityId) {
      const parentExists = bible.canonicalEntities.some((e) => e.id === ref.parentEntityId);
      if (parentExists) {
        bible.canonicalRelationships.push({
          id: `rel_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          sourceEntityId: entityId,
          targetEntityId: ref.parentEntityId,
          type: "part_of",
          startChapter: ref.firstSeenChapter || 1,
          state: "current",
          provenance: [{ chapter: ref.firstSeenChapter || 1, kind: "relationship", origin: promotionOrigin }],
          locked: false,
          origin: promotionOrigin,
        });
      }
    }

    // Remove from minorReferences
    bible.minorReferences = bible.minorReferences.filter((r) => r.id !== referenceId);

    // Reconcile child minor references that pointed to referenceId or demotedFromEntityId
    for (const childRef of bible.minorReferences) {
      if (childRef.parentEntityId === referenceId || childRef.parentEntityId === entityId) {
        childRef.parentEntityId = entityId;
      }
    }

    // Audit
    bible.granularityAudits.push({
      id: randomUUID(),
      action: "promoted",
      fromEntityId: referenceId,
      toEntityId: entityId,
      referenceId,
      name: ref.name,
      reason,
      confidence: 1.0,
      source: options.source ?? "manual",
      timestamp: now,
    });

    await atomicWriteJson(paths.bibleCanonicalManual, overlay);
    await atomicWriteJson(paths.bible, bible);
    return { status: "promoted", referenceId, entity: newEntity, bible };
    return { status: "promoted" as const, referenceId, entity: newEntity, bible };
  });
}

/**
 * Updates a minor reference's properties (e.g. parent entity assignment).
 */
export async function updateMinorReference(
  root: string,
  slug: string,
  referenceId: string,
  patch: {
    name?: string;
    parentEntityId?: string | null;
    status?: "minor" | "promotion_candidate";
    aliases?: string[];
    contextNotes?: string | null;
  },
) {
  return withStoryLock(root, slug, `update minor reference ${referenceId}`, async () => {
    const paths = storyPaths(root, slug, 1);
    const bibleRaw = await readJsonIfExists(paths.bible);
    if (!bibleRaw) throw new Error("Story Bible not found");
    const bible = storyBibleSchema.parse(bibleRaw);
    const ref = bible.minorReferences.find((r) => r.id === referenceId);
    if (!ref) throw new Error(`Minor reference '${referenceId}' was not found`);

    const overlay = canonicalOverlaySchema.parse(
      (await readJsonIfExists(paths.bibleCanonicalManual)) ?? {
        version: 1,
        overrides: {},
        merges: [],
        demotions: [],
        promotions: [],
        parentAssignments: {},
      },
    );

    if (patch.name !== undefined) ref.name = patch.name;
    if (patch.aliases !== undefined) ref.aliases = patch.aliases;
    if (patch.status !== undefined) ref.status = patch.status;
    if (patch.contextNotes !== undefined) ref.contextNotes = patch.contextNotes ?? undefined;

    if (patch.parentEntityId !== undefined) {
      if (patch.parentEntityId) {
        if (patch.parentEntityId === referenceId || patch.parentEntityId === ref.demotedFromEntityId) {
          throw new Error(`Minor reference '${ref.name}' cannot be its own parent`);
        }
        const parentExists = bible.canonicalEntities.some((e) => e.id === patch.parentEntityId);
        if (!parentExists) {
          throw new Error(`Parent entity '${patch.parentEntityId}' was not found in canonical entities`);
        }
        ref.parentEntityId = patch.parentEntityId;
        overlay.parentAssignments[referenceId] = patch.parentEntityId;
        if (ref.demotedFromEntityId) {
          overlay.parentAssignments[ref.demotedFromEntityId] = patch.parentEntityId;
        }
      } else {
        ref.parentEntityId = undefined;
        delete overlay.parentAssignments[referenceId];
        if (ref.demotedFromEntityId) {
          delete overlay.parentAssignments[ref.demotedFromEntityId];
        }
      }
    }
    ref.updatedAt = new Date().toISOString();

    await atomicWriteJson(paths.bibleCanonicalManual, overlay);
    await atomicWriteJson(paths.bible, bible);
    return { status: "updated" as const, reference: ref };
  });
}

export interface BulkCleanupFailedItem {
  entityId: string;
  canonicalName: string;
  action: "demote" | "merge";
  reason: string;
}

export interface BulkCleanupResult {
  analyzedCount: number;
  appliedCount: number;
  appliedDemotionsCount: number;
  appliedMergesCount: number;
  demotedCount: number;
  mergedCount: number;
  skippedProtectedCount: number;
  failedCount: number;
  appliedDemotions: string[];
  appliedMerges: string[];
  skippedProtected: string[];
  failed: BulkCleanupFailedItem[];
  /** Per-entity change records for the append-only entity audit log (source: analyzer). */
  auditTrail: Array<{ entityId: string; action: "demoted" | "merged"; before?: Record<string, unknown>; after?: Record<string, unknown>; reason?: string; source: "analyzer" }>;
  bible: StoryBible;
}

/**
 * Applies cleanup recommendations. Supports high-confidence bulk cleanup and selective application.
 */
export async function applyCleanupRecommendations(
  root: string,
  slug: string,
  recommendationIdsOrOptions: string[] | { recommendationIds?: string[]; highConfidenceOnly?: boolean } = [],
  options: { highConfidenceOnly?: boolean } = {},
): Promise<BulkCleanupResult> {
  const ids = Array.isArray(recommendationIdsOrOptions)
    ? recommendationIdsOrOptions
    : (recommendationIdsOrOptions.recommendationIds ?? []);
  const highConfidenceOnly = Array.isArray(recommendationIdsOrOptions)
    ? options.highConfidenceOnly
    : (recommendationIdsOrOptions.highConfidenceOnly ?? options.highConfidenceOnly);

  const report = await analyzeStoryBible(root, slug);
  const targetRecs = report.recommendations.filter((r) => {
    if (ids.length > 0) return ids.includes(r.id);
    if (highConfidenceOnly) return r.safeToAutoApply;
    return true;
  });

  const appliedDemotions: string[] = [];
  const appliedMerges: string[] = [];
  const skippedProtected: string[] = [];
  const failed: BulkCleanupFailedItem[] = [];
  const auditTrail: BulkCleanupResult["auditTrail"] = [];

  for (const rec of targetRecs) {
    if (rec.protected) {
      skippedProtected.push(rec.canonicalName);
      continue;
    }

    if (rec.recommendation === "minor_reference") {
      try {
        const res = await demoteCanonicalEntity(root, slug, rec.entityId, {
          parentEntityId: rec.parentEntityId,
          reason: rec.reason,
          source: "analyzer",
        });
        if (res.status === "demoted") {
          appliedDemotions.push(rec.canonicalName);
          auditTrail.push({ entityId: rec.entityId, action: "demoted", after: { referenceId: res.referenceId, parentEntityId: rec.parentEntityId ?? null }, reason: rec.reason, source: "analyzer" });
        }
      } catch (err) {
        logger.warn({ entityId: rec.entityId, err }, "Failed to demote canonical entity during cleanup");
        failed.push({
          entityId: rec.entityId,
          canonicalName: rec.canonicalName,
          action: "demote",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (rec.recommendation === "merge" && rec.targetEntityId) {
      try {
        const base = await readJsonIfExists(storyPaths(root, slug, 1).bible);
        if (base) {
          const merged = await mergeCanonicalEntities(root, slug, storyBibleSchema.parse(base), rec.targetEntityId, [rec.entityId], rec.reason);
          appliedMerges.push(`${rec.canonicalName} → ${rec.targetEntityName}`);
          auditTrail.push(
            { entityId: rec.targetEntityId, action: "merged", after: { mergeId: merged.merge.id, mergedSourceIds: [rec.entityId], reason: rec.reason }, reason: rec.reason, source: "analyzer" },
            { entityId: rec.entityId, action: "merged", after: { mergeId: merged.merge.id, mergedInto: rec.targetEntityId, reason: rec.reason }, reason: rec.reason, source: "analyzer" },
          );
        }
      } catch (err) {
        logger.warn({ entityId: rec.entityId, err }, "Failed to merge canonical entity during cleanup");
        failed.push({
          entityId: rec.entityId,
          canonicalName: rec.canonicalName,
          action: "merge",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const updatedBible = await readJsonIfExists(storyPaths(root, slug, 1).bible);
  const bible = updatedBible ? storyBibleSchema.parse(updatedBible) : emptyStoryBible();

  return {
    analyzedCount: report.totalCanonical,
    appliedCount: appliedDemotions.length + appliedMerges.length,
    appliedDemotionsCount: appliedDemotions.length,
    appliedMergesCount: appliedMerges.length,
    demotedCount: appliedDemotions.length,
    mergedCount: appliedMerges.length,
    skippedProtectedCount: skippedProtected.length,
    failedCount: failed.length,
    appliedDemotions,
    appliedMerges,
    skippedProtected,
    failed,
    auditTrail,
    bible,
  };
}

export interface PreDemoteSnapshot {
  bible: StoryBible;
  overlay?: Record<string, unknown>;
}

export async function snapshotPreDemoteStoryBible(root: string, slug: string): Promise<PreDemoteSnapshot> {
  const paths = storyPaths(root, slug, 1);
  const bibleRaw = await readJsonIfExists(paths.bible);
  if (!bibleRaw) throw new Error(`Story Bible not found for '${slug}'`);
  const bible = storyBibleSchema.parse(bibleRaw);
  const overlayRaw = await readJsonIfExists<Record<string, unknown>>(paths.bibleCanonicalManual);
  return {
    bible: structuredClone(bible),
    overlay: overlayRaw ? structuredClone(overlayRaw) : undefined,
  };
}

export async function restorePreDemoteStoryBible(root: string, slug: string, snapshot: PreDemoteSnapshot): Promise<void> {
  const paths = storyPaths(root, slug, 1);
  await atomicWriteJson(paths.bible, snapshot.bible);
  if (snapshot.overlay) {
    await atomicWriteJson(paths.bibleCanonicalManual, snapshot.overlay);
  } else {
    await rm(paths.bibleCanonicalManual, { force: true }).catch(() => undefined);
  }
}
