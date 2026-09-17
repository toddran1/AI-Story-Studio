import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CanonicalEntity, emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { findDuplicateSuggestions } from "../src/story-bible/canonical.js";
import {
  duplicateScore,
  extractNumericTokens,
  tokenizeEntityName,
} from "../src/story-bible/duplicate-detection.js";
import {
  analyzeStoryBible,
  applyCleanupRecommendations,
} from "../src/story-bible/granularity.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";

const update = (chapter: number, value: Record<string, unknown> = {}) =>
  storyBibleUpdateSchema.parse({ chapterSummary: `Chapter ${chapter}`, ...value });

function makeEntity(
  id: string,
  name: string,
  type: CanonicalEntity["type"],
  options: Partial<CanonicalEntity> = {},
): CanonicalEntity {
  return {
    id,
    type,
    canonicalName: name,
    originalName: options.originalName ?? "",
    description: options.description ?? `${name} description`,
    aliases: options.aliases ?? [],
    firstAppearance: options.firstAppearance ?? 1,
    lastKnownAppearance: options.lastKnownAppearance ?? 1,
    status: options.status ?? "unknown",
    notes: options.notes ?? "",
    canonicalNameLocked: options.canonicalNameLocked ?? false,
    origin: options.origin ?? "automatic",
    provenance: options.provenance ?? [{ chapter: 1, kind: "extraction", origin: "automatic" }],
    aliasNarrationRules: options.aliasNarrationRules ?? [],
    mergedFromIds: options.mergedFromIds ?? [],
    ...options,
  };
}

describe("Story Bible — Duplicate Detection & Qualifier Protection", () => {
  describe("Tokenization & Numeric Qualifiers", () => {
    it("tokenizes names and extracts numeric values accurately", () => {
      expect(tokenizeEntityName("Seaside Secret Realm")).toEqual(["seaside", "secret", "realm"]);
      expect(tokenizeEntityName("Level 44")).toEqual(["level", "44"]);
      expect(extractNumericTokens("Level 44")).toEqual([44]);
      expect(extractNumericTokens("Lv. 4")).toEqual([4]);
      expect(extractNumericTokens("Floor Forty-Four")).toEqual([44]);
      expect(extractNumericTokens("Chapter 120")).toEqual([120]);
      expect(extractNumericTokens("Gate 7")).toEqual([7]);
      expect(extractNumericTokens("Squad 2")).toEqual([2]);
    });
  });

  describe("Numeric Qualifier Protection", () => {
    it("rejects Level 44 vs Level 4 due to conflicting numeric qualifier", () => {
      const a = makeEntity("ent_01", "Level 44", "concept");
      const b = makeEntity("ent_02", "Level 4", "concept");
      const score = duplicateScore(a, b);
      expect(score.confidence).toBe(0);
      expect(score.conflict).toBe("numeric");
      expect(score.reason).toContain("Distinct numeric qualifiers");
    });

    it("rejects Level 10 vs Level 1, Rank 30 vs Rank 3, Floor 40 vs Floor 4", () => {
      expect(duplicateScore(makeEntity("e1", "Level 10", "concept"), makeEntity("e2", "Level 1", "concept")).confidence).toBe(0);
      expect(duplicateScore(makeEntity("e1", "Rank 30", "concept"), makeEntity("e2", "Rank 3", "concept")).confidence).toBe(0);
      expect(duplicateScore(makeEntity("e1", "Floor 40", "location"), makeEntity("e2", "Floor 4", "location")).confidence).toBe(0);
      expect(duplicateScore(makeEntity("e1", "Chapter 120", "concept"), makeEntity("e2", "Chapter 12", "concept")).confidence).toBe(0);
      expect(duplicateScore(makeEntity("e1", "Gate 70", "location"), makeEntity("e2", "Gate 7", "location")).confidence).toBe(0);
      expect(duplicateScore(makeEntity("e1", "Squad 20", "organization"), makeEntity("e2", "Squad 2", "organization")).confidence).toBe(0);
    });

    it("rejects qualified numbered instance vs generic bare concept (Level 44 vs Level)", () => {
      const a = makeEntity("e1", "Level 44", "concept");
      const b = makeEntity("e2", "Level", "concept");
      const score = duplicateScore(a, b);
      expect(score.confidence).toBe(0);
      expect(score.conflict).toBe("numeric");
      expect(score.reason).toContain("Numeric qualifier distinguishes specialized instance");
    });
  });

  describe("Semantic Qualifier Protection", () => {
    it("rejects Monster Encyclopedia vs Monster based solely on name containment", () => {
      const a = makeEntity("ent_01", "Monster Encyclopedia", "concept");
      const b = makeEntity("ent_02", "Monster", "concept");
      const score = duplicateScore(a, b);
      expect(score.confidence).toBe(0);
      expect(score.conflict).toBe("semantic_qualifier");
      expect(score.reason).toContain("encyclopedia");
    });

    it("rejects Seaside Secret Realm vs Secret Realm based solely on name containment", () => {
      const a = makeEntity("ent_01", "Seaside Secret Realm", "location");
      const b = makeEntity("ent_02", "Secret Realm", "location");
      const score = duplicateScore(a, b);
      expect(score.confidence).toBe(0);
      expect(score.conflict).toBe("semantic_qualifier");
      expect(score.reason).toContain("seaside");
    });

    it("rejects Dragon Sword vs Dragon, Sword Technique vs Sword, Necromancer Class vs Necromancer", () => {
      expect(duplicateScore(makeEntity("e1", "Dragon Sword", "item"), makeEntity("e2", "Dragon", "concept")).confidence).toBe(0);
      expect(duplicateScore(makeEntity("e1", "Sword Technique", "ability"), makeEntity("e2", "Sword", "item")).confidence).toBe(0);
      expect(duplicateScore(makeEntity("e1", "Necromancer Class", "concept"), makeEntity("e2", "Necromancer", "concept")).confidence).toBe(0);
    });

    it("rejects Guild President vs Guild", () => {
      const a = makeEntity("e1", "Guild President", "character");
      const b = makeEntity("e2", "Guild", "organization");
      const score = duplicateScore(a, b);
      expect(score.confidence).toBe(0);
    });
  });

  describe("Legitimate Duplicate Detection", () => {
    it("detects exact canonical duplicate with 0.99 confidence", () => {
      const a = makeEntity("ent_01", "Su Ming", "character");
      const b = makeEntity("ent_02", "Su Ming", "character");
      const score = duplicateScore(a, b);
      expect(score.confidence).toBe(0.99);
      expect(score.recommendation).toBe("merge");
      expect(score.reason).toContain("Exact normalized canonical name match");
    });

    it("detects exact original-name duplicate (Su Ming / 苏铭 vs Malakai / 苏铭) with 0.98 confidence", () => {
      const a = makeEntity("ent_01", "Su Ming", "character", { originalName: "苏铭" });
      const b = makeEntity("ent_02", "Malakai", "character", { originalName: "苏铭" });
      const score = duplicateScore(a, b);
      expect(score.confidence).toBe(0.98);
      expect(score.recommendation).toBe("merge");
      expect(score.reason).toContain("Exact original-language name match");
    });

    it("detects alias duplicate (Malakai Sterling [alias: Su Ming] vs Su Ming)", () => {
      const a = makeEntity("ent_01", "Malakai Sterling", "character", { aliases: ["Su Ming"], provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }] });
      const b = makeEntity("ent_02", "Su Ming", "character", { provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }] });
      const score = duplicateScore(a, b);
      expect(score.confidence).toBeGreaterThanOrEqual(0.95);
      expect(score.recommendation).toBe("merge");
      expect(score.reason).toContain("alias");
    });

    it("detects honorific variation with supporting evidence (Elder Wang vs Wang in same chapter)", () => {
      const a = makeEntity("ent_01", "Elder Wang", "character", { provenance: [{ chapter: 5, kind: "extraction", origin: "automatic" }] });
      const b = makeEntity("ent_02", "Wang", "character", { provenance: [{ chapter: 5, kind: "extraction", origin: "automatic" }] });
      const score = duplicateScore(a, b);
      expect(score.confidence).toBeGreaterThanOrEqual(0.88);
      expect(score.recommendation).toBe("merge");
      expect(score.reason).toContain("Honorific variation with matching supporting evidence");
    });

    it("downgrades honorific variation without supporting evidence to needs_review (Elder Wang vs Wang)", () => {
      const a = makeEntity("ent_01", "Elder Wang", "character", { provenance: [{ chapter: 10, kind: "extraction", origin: "automatic" }] });
      const b = makeEntity("ent_02", "Wang", "character", { provenance: [{ chapter: 50, kind: "extraction", origin: "automatic" }] });
      const score = duplicateScore(a, b);
      expect(score.confidence).toBe(0.75);
      expect(score.recommendation).toBe("needs_review");
      expect(score.reason).toContain("Review required");
    });
  });

  describe("Conflict and Ambiguity Protections", () => {
    it("rejects semantic type conflicts (character vs location) unless Tier 1 evidence exists", () => {
      const a = makeEntity("ent_01", "Azure Dragon", "character");
      const b = makeEntity("ent_02", "Azure Dragon", "location");
      // Even with same name, strictly incompatible types character vs location reject
      const score = duplicateScore(a, b);
      expect(score.confidence).toBe(0);
      expect(score.conflict).toBe("type");
    });

    it("overrides type conflict if exact original name matches", () => {
      const a = makeEntity("ent_01", "Azure Dragon", "character", { originalName: "青龙" });
      const b = makeEntity("ent_02", "Azure Dragon", "location", { originalName: "青龙" });
      const score = duplicateScore(a, b);
      expect(score.confidence).toBe(0.98);
      expect(score.recommendation).toBe("merge");
    });

    it("rejects conflicting original-language names (Old Steward / 老管家 vs Old Master Nong / 农老爷)", () => {
      const a = makeEntity("ent_01", "Old Steward", "character", { originalName: "老管家" });
      const b = makeEntity("ent_02", "Old Master Nong", "character", { originalName: "农老爷" });
      const score = duplicateScore(a, b);
      expect(score.confidence).toBe(0);
      expect(score.conflict).toBe("original_name");
      expect(score.reason).toContain("Different original-language names");
    });

    it("rejects entities with an established relationship between them", () => {
      const a = makeEntity("ent_01", "Conference Hall", "location");
      const b = makeEntity("ent_02", "Nong Family", "organization");
      const score = duplicateScore(a, b, {
        relationships: [
          {
            id: "rel_000000000000000000000001",
            sourceEntityId: "ent_01",
            targetEntityId: "ent_02",
            type: "part_of",
            startChapter: 1,
            state: "current",
            origin: "automatic",
            locked: false,
            provenance: [{ chapter: 1, kind: "relationship", origin: "automatic" }],
          },
        ],
      });
      expect(score.confidence).toBe(0);
      expect(score.conflict).toBe("relationship");
    });
  });

  describe("Granularity vs Duplicate Separation in Analyze Bible", () => {
    it("handles Nong Family Conference Hall through granularity (minor reference) NOT duplicate merge", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-duplicate-"));
      let bible = mergeStoryBible(
        emptyStoryBible(),
        update(1, {
          locations: [
            {
              canonicalEnglishName: "Nong Family",
              originalName: "农家",
              description: "The ancestral Nong Family residence and grounds",
              firstSeenChapter: 1,
              lastSeenChapter: 1,
            },
          ],
        }),
        1,
      );
      // Simulate an existing canonical entity (e.g. from historical extraction before granularity analysis)
      bible.canonicalEntities.push(
        makeEntity("ent_000000000000000000000001", "Nong Family Conference Hall", "location", {
          originalName: "农家议事大厅",
          description: "The main hall where clan elders meet",
          firstAppearance: 1,
          lastKnownAppearance: 1,
        }),
      );
      await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);

      const report = await analyzeStoryBible(root, "demo-story");
      const hallRec = report.recommendations.find((r) => r.canonicalName === "Nong Family Conference Hall");
      expect(hallRec).toBeDefined();
      // Must be classified as minor_reference under Nong Family, NOT merged into Nong Family
      expect(hallRec?.recommendation).toBe("minor_reference");
      expect(hallRec?.parentEntityName).toBe("Nong Family");
      expect(hallRec?.targetEntityId).toBeUndefined();

      // Ensure it is never recommended as a merge
      const mergeRec = report.recommendations.find(
        (r) => r.canonicalName === "Nong Family Conference Hall" && r.recommendation === "merge",
      );
      expect(mergeRec).toBeUndefined();
    });

    it("excludes Level 44 vs Level 4, Monster Encyclopedia vs Monster from high-confidence bulk cleanup", async () => {
      const root = await mkdtemp(join(tmpdir(), "bulk-safety-"));
      let bible = mergeStoryBible(
        emptyStoryBible(),
        update(1, {
          items: [
            { canonicalEnglishName: "Level 44", originalName: "", description: "Level 44 badge", firstSeenChapter: 1, lastSeenChapter: 1 },
            { canonicalEnglishName: "Level 4", originalName: "", description: "Level 4 badge", firstSeenChapter: 1, lastSeenChapter: 1 },
            { canonicalEnglishName: "Monster Encyclopedia", originalName: "", description: "Reference book", firstSeenChapter: 1, lastSeenChapter: 1 },
            { canonicalEnglishName: "Monster", originalName: "", description: "Generic monster category", firstSeenChapter: 1, lastSeenChapter: 1 },
            { canonicalEnglishName: "Seaside Secret Realm", originalName: "", description: "Realm by the sea", firstSeenChapter: 1, lastSeenChapter: 1 },
            { canonicalEnglishName: "Secret Realm", originalName: "", description: "Mystic realm", firstSeenChapter: 1, lastSeenChapter: 1 },
          ],
        }),
        1,
      );
      await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);

      const report = await analyzeStoryBible(root, "demo-story");
      const mergeRecs = report.recommendations.filter((r) => r.recommendation === "merge");
      // None of these should be merge recommendations
      expect(mergeRecs).toHaveLength(0);

      // Bulk cleanup with highConfidenceOnly should NOT merge any of them
      const bulk = await applyCleanupRecommendations(root, "demo-story", { highConfidenceOnly: true });
      expect(bulk.appliedMergesCount).toBe(0);
      expect(bulk.appliedMerges).toEqual([]);
    });

    it("preserves manual/protected entities from auto-merge and requires review", async () => {
      const root = await mkdtemp(join(tmpdir(), "protected-merge-"));
      const bible = emptyStoryBible();
      const ent1 = makeEntity("ent_000000000000000000000001", "Su Ming", "character", {
        originalName: "苏铭",
        canonicalNameLocked: true,
      });
      const ent2 = makeEntity("ent_000000000000000000000002", "Malakai", "character", {
        originalName: "苏铭",
        notes: "Protected note",
      });
      bible.canonicalEntities = [ent1, ent2];
      await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);

      const report = await analyzeStoryBible(root, "demo-story");
      const secondRec = report.recommendations.find((r) => r.entityId === ent2.id);
      expect(secondRec?.protected).toBe(true);
      expect(secondRec?.recommendation).toBe("needs_review");
      expect(secondRec?.safeToAutoApply).toBe(false);
    });

    it("maintains stable recommendation IDs across successive analyzeStoryBible calls", async () => {
      const root = await mkdtemp(join(tmpdir(), "stable-rec-"));
      let bible = mergeStoryBible(
        emptyStoryBible(),
        update(1, {
          characters: [
            { canonicalEnglishName: "Su Ming", originalName: "苏铭", description: "Hero", firstSeenChapter: 1, lastSeenChapter: 1 },
            { canonicalEnglishName: "Malakai", originalName: "苏铭", description: "Hero duplicate", firstSeenChapter: 1, lastSeenChapter: 1 },
          ],
        }),
        1,
      );
      await atomicWriteJson(storyPaths(root, "demo-story", 1).bible, bible);

      const report1 = await analyzeStoryBible(root, "demo-story");
      const report2 = await analyzeStoryBible(root, "demo-story");

      expect(report1.recommendations.map((r) => r.id)).toEqual(report2.recommendations.map((r) => r.id));
      expect(report1.recommendations[0]?.id).toMatch(/^rec_[a-f0-9]{16}$/);
    });
  });

  describe("Candidate Generation Performance on Large Entity Sets", () => {
    it("efficiently handles 500+ entities in under 100ms without O(N²) explosion", () => {
      const entities: CanonicalEntity[] = [];
      for (let i = 1; i <= 500; i++) {
        entities.push(
          makeEntity(
            `ent_${String(i).padStart(24, "0")}`,
            `Character Entity ${i}`,
            "character",
            { originalName: `人物${i}` },
          ),
        );
      }
      // Add two intentional exact duplicates
      entities.push(
        makeEntity("ent_dup1_00000000000000000001", "Special Hero", "character", { originalName: "英雄" }),
        makeEntity("ent_dup2_00000000000000000002", "Special Hero", "character", { originalName: "英雄" }),
      );

      const startTime = performance.now();
      const suggestions = findDuplicateSuggestions(entities);
      const elapsed = performance.now() - startTime;

      expect(elapsed).toBeLessThan(100);
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      expect(suggestions[0]?.entities.map((e) => e.name)).toEqual(["Special Hero", "Special Hero"]);
    });
  });
});
