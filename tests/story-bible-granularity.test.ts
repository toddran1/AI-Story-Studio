import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCanonicalEntitiesPage, getMinorReferencesPage, getStoryBibleAnalysis } from "../apps/server/catalog.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { CanonicalEntity, StoryBible, emptyStoryBible, storyBibleSchema, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { readJsonIfExists } from "../src/storage/story-files.js";
import { applyCanonicalOverlay, updateCanonicalEntity } from "../src/story-bible/canonical.js";
import {
  analyzeStoryBible,
  applyCleanupRecommendations,
  classifyEntityPersistenceSync,
  demoteCanonicalEntity,
  promoteMinorReference,
} from "../src/story-bible/granularity.js";
import { retrieveRelevantContext } from "../src/story-bible/retrieval.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";

const named = (name: string, chapter: number, extra: Record<string, unknown> = {}) => ({
  canonicalEnglishName: name,
  originalName: "",
  description: `${name} at Chapter ${chapter}`,
  firstSeenChapter: chapter,
  lastSeenChapter: chapter,
  ...extra,
});
const update = (chapter: number, value: Record<string, unknown> = {}) =>
  storyBibleUpdateSchema.parse({ chapterSummary: `Chapter ${chapter}`, ...value });

describe("Story Bible Entity Granularity & Intelligent Cleanup", () => {
  describe("Classification & Prefix Safety", () => {
    it("classifies sub-locations under organizations/locations as minor references with parent association", () => {
      const parent: CanonicalEntity = {
        id: "ent_111122223333444455556666",
        canonicalName: "Nong Family",
        originalName: "",
        type: "organization",
        aliases: [],
        aliasNarrationRules: [],
        description: "",
        firstAppearance: 1,
        lastKnownAppearance: 5,
        provenance: [],
        origin: "automatic",
        mergedFromIds: [],
        notes: "",
        canonicalNameLocked: false,
        status: "unknown",
      };

      const conferenceHall = classifyEntityPersistenceSync(
        {
          name: "Nong Family Conference Hall",
          type: "location",
          description: "A meeting room in the Nong Family estate",
          firstSeenChapter: 1,
          lastSeenChapter: 2,
        },
        { canonicalEntities: [parent] },
      );

      expect(conferenceHall.disposition).toBe("minor_reference");
      expect(conferenceHall.parentEntityId).toBe("ent_111122223333444455556666");
      expect(conferenceHall.confidence).toBeGreaterThanOrEqual(0.85);

      const villa = classifyEntityPersistenceSync(
        {
          name: "Nong Family Villa",
          type: "location",
          description: "Villa belonging to the Nong Family",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
        },
        { canonicalEntities: [parent] },
      );
      expect(villa.disposition).toBe("minor_reference");
      expect(villa.parentEntityId).toBe("ent_111122223333444455556666");
    });

    it("ensures prefix safety: characters and items sharing organization prefix remain canonical", () => {
      const parent: CanonicalEntity = {
        id: "ent_111122223333444455556666",
        canonicalName: "Nong Family",
        originalName: "",
        type: "organization",
        aliases: [],
        aliasNarrationRules: [],
        description: "",
        firstAppearance: 1,
        lastKnownAppearance: 5,
        provenance: [],
        origin: "automatic",
        mergedFromIds: [],
        notes: "",
        canonicalNameLocked: false,
        status: "unknown",
      };

      // Nong Family Patriarch is a character, NOT a sub-location
      const patriarch = classifyEntityPersistenceSync(
        {
          name: "Nong Family Patriarch",
          type: "character",
          description: "Leader of the Nong Family",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
        },
        { canonicalEntities: [parent] },
      );
      expect(patriarch.disposition).toBe("canonical");

      // Nong Family Ancestral Sword is an item, NOT a sub-location
      const sword = classifyEntityPersistenceSync(
        {
          name: "Nong Family Ancestral Sword",
          type: "item",
          description: "Sacred blade of the Nong Family",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
        },
        { canonicalEntities: [parent] },
      );
      expect(sword.disposition).toBe("canonical");
    });

    it("classifies standalone generic room nouns as minor references", () => {
      const eastCourtyard = classifyEntityPersistenceSync(
        {
          name: "East Courtyard",
          type: "location",
          description: "The courtyard to the east",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
        },
        { canonicalEntities: [] },
      );
      expect(eastCourtyard.disposition).toBe("minor_reference");

      const guestRoom = classifyEntityPersistenceSync(
        {
          name: "Guest Room #3",
          type: "location",
          description: "A room for visitors",
          firstSeenChapter: 2,
          lastSeenChapter: 2,
        },
        { canonicalEntities: [] },
      );
      expect(guestRoom.disposition).toBe("minor_reference");
    });
  });

  describe("Updater pipeline & Minor reference tracking", () => {
    it("routes sub-locations to minorReferences while keeping parent entity canonical", () => {
      let bible = emptyStoryBible();

      // Chapter 1 introduces the Nong Family
      bible = mergeStoryBible(
        bible,
        update(1, {
          factions: [named("Nong Family", 1)],
          chapterSummary: "Introduction to Nong Family",
        }),
        1,
      );

      expect(bible.canonicalEntities.some((e) => e.canonicalName === "Nong Family")).toBe(true);
      const nong = bible.canonicalEntities.find((e) => e.canonicalName === "Nong Family")!;

      // Chapter 2 mentions Nong Family Reception Hall
      bible = mergeStoryBible(
        bible,
        update(2, {
          locations: [named("Nong Family Reception Hall", 2)],
          chapterSummary: "Meeting at the reception hall",
        }),
        2,
      );

      // Reception Hall should NOT be a canonical entity
      expect(bible.canonicalEntities.some((e) => e.canonicalName === "Nong Family Reception Hall")).toBe(false);

      // It SHOULD be in minorReferences with parent linked to Nong Family
      expect(bible.minorReferences.some((r) => r.name === "Nong Family Reception Hall")).toBe(true);
      const hallRef = bible.minorReferences.find((r) => r.name === "Nong Family Reception Hall")!;
      expect(hallRef.parentEntityId).toBe(nong.id);
      expect(hallRef.disposition).toBe("minor_reference");
    });

    it("resolves relationships mentioning minor references to their parent canonical entity", () => {
      let bible = emptyStoryBible();
      // Introduce Nong Family in Chapter 1
      bible = mergeStoryBible(
        bible,
        update(1, {
          characters: [named("Su Ming", 1)],
          factions: [named("Nong Family", 1)],
          locations: [named("Nong Family Conference Hall", 1)],
          relationships: [
            {
              subject: "Su Ming",
              object: "Nong Family Conference Hall",
              relationship: "visited",
              firstSeenChapter: 1,
              lastSeenChapter: 1,
            },
          ],
        }),
        1,
      );

      const nong = bible.canonicalEntities.find((e) => e.canonicalName === "Nong Family")!;
      const su = bible.canonicalEntities.find((e) => e.canonicalName === "Su Ming")!;

      // Relationship target should be resolved to parent "Nong Family"
      const rel = bible.canonicalRelationships.find((r) => r.sourceEntityId === su.id);
      expect(rel).toBeDefined();
      expect(rel?.targetEntityId).toBe(nong.id);
    });
  });

  describe("Demotion, Promotion & Rebuild Compatibility", () => {
    it("demoting a canonical entity records demotion in manual overlay and prevents resurrection on rebuild", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-demote-"));
      const slug = "test-story";

      // Setup initial bible with a legacy canonical entity
      let bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          type: "organization",
          canonicalName: "Nong Family",
          originalName: "",
          aliases: [],
          aliasNarrationRules: [],
          description: "Main clan",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
        {
          id: "ent_000000000000000000000002",
          type: "location",
          canonicalName: "Nong Family Villa",
          originalName: "",
          aliases: [],
          aliasNarrationRules: [],
          description: "Legacy standalone room",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];

      const villa = bible.canonicalEntities.find((e) => e.canonicalName === "Nong Family Villa")!;
      const nong = bible.canonicalEntities.find((e) => e.canonicalName === "Nong Family")!;

      // Persist bible to disk
      await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);

      // Demote villa
      const demoteResult = await demoteCanonicalEntity(root, slug, villa.id, {
        parentEntityId: nong.id,
        disposition: "minor_reference",
        reason: "Villa is a sub-location of Nong Family",
      });

      expect(demoteResult.status).toBe("demoted");
      bible = demoteResult.bible;

      // Canonical entities should no longer contain Villa
      expect(bible.canonicalEntities.some((e) => e.id === villa.id)).toBe(false);

      // Minor references should contain Villa
      expect(bible.minorReferences.some((r) => r.name === "Nong Family Villa")).toBe(true);

      // Granularity audit log should record demotion
      expect(bible.granularityAudits.some((a) => a.action === "demoted" && a.fromEntityId === villa.id)).toBe(true);

      // Partial rebuild / overlay reapplication should NOT resurrect the demoted entity
      const cleanRebuild = emptyStoryBible();
      cleanRebuild.canonicalEntities = [
        {
          id: "ent_000000000000000000000002",
          type: "location",
          canonicalName: "Nong Family Villa",
          originalName: "",
          aliases: [],
          aliasNarrationRules: [],
          description: "",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      const restored = await applyCanonicalOverlay(root, slug, cleanRebuild);

      // Villa must not be resurrected into canonical entities
      expect(restored.bible.canonicalEntities.some((e) => e.canonicalName === "Nong Family Villa")).toBe(false);
      // And must be in minorReferences
      expect(restored.bible.minorReferences.some((r) => r.name === "Nong Family Villa")).toBe(true);
    });

    it("promotes a minor reference to canonical entity with provenance and audit trail", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-promote-"));
      const slug = "test-story";

      let bible = emptyStoryBible();
      bible.minorReferences = [
        {
          id: "ref_ancient_shrine",
          name: "Ancient Shrine",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          firstSeenChapter: 1,
          lastSeenChapter: 3,
          occurrenceCount: 3,
          source: "automatic",
          sourceEvidence: [{ chapter: 1 }, { chapter: 2 }, { chapter: 3 }],
          aliases: ["Old Shrine"],
          status: "minor",
        },
      ];
      await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);

      const promoteResult = await promoteMinorReference(root, slug, "ref_ancient_shrine", {
        reason: "Shrine became a major story arc location",
      });

      expect(promoteResult.status).toBe("promoted");
      const updatedBible = promoteResult.bible;

      // Minor reference should be removed
      expect(updatedBible.minorReferences.some((r) => r.id === "ref_ancient_shrine")).toBe(false);

      // Canonical entity should exist
      const canonical = updatedBible.canonicalEntities.find((e) => e.canonicalName === "Ancient Shrine");
      expect(canonical).toBeDefined();
      expect(canonical?.origin).toBe("manual");
      expect(canonical?.firstAppearance).toBe(1);
      expect(canonical?.lastKnownAppearance).toBe(3);
      expect(canonical?.aliases).toContain("Old Shrine");

      // Audit recorded
      expect(updatedBible.granularityAudits.some((a) => a.action === "promoted" && a.referenceId === "ref_ancient_shrine")).toBe(true);
    });
  });

  describe("Protection of Manual Overlays in Analyzer & Cleanup", () => {
    it("prevents automatic demotion of entities with manual locks, pronunciations, or notes", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-protected-"));
      const slug = "test-story";

      const bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          type: "organization",
          canonicalName: "Nong Family",
          originalName: "",
          aliases: [],
          aliasNarrationRules: [],
          description: "Main clan",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
        {
          id: "ent_000000000000000000000002",
          type: "location",
          canonicalName: "Nong Family Estate",
          originalName: "",
          aliases: [],
          aliasNarrationRules: [],
          description: "Main estate",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: true,
          status: "unknown",
          pronunciation: {
            romanization: "Nong Family Estate",
            source: "manual",
            locked: true,
            mode: "custom",
            customPronunciation: "Nong Family Estate",
            updatedAt: new Date().toISOString(),
          },
        },
      ];

      await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);

      // Run analyzer
      const analysis = await analyzeStoryBible(root, slug);
      const estateRec = analysis.recommendations.find((r) => r.canonicalName === "Nong Family Estate");

      expect(estateRec).toBeDefined();
      expect(estateRec?.protected).toBe(true);
      expect(estateRec?.safeToAutoApply).toBe(false);
      expect(estateRec?.recommendation).toBe("needs_review");
      expect(estateRec?.protectedReasons).toEqual(expect.arrayContaining(["Canonical name locked", "Manual pronunciation locked"]));

      // Applying cleanup should NOT demote this protected entity
      const cleanupResult = await applyCleanupRecommendations(root, slug, { highConfidenceOnly: true });
      expect(cleanupResult.demotedCount).toBe(0);

      const checkBible = cleanupResult.bible;
      expect(checkBible.canonicalEntities.some((e: any) => e.canonicalName === "Nong Family Estate")).toBe(true);
    });
  });

  describe("Context Retrieval Isolation", () => {
    it("excludes minor references from LLM context unless explicitly mentioned in chapter with parent", () => {
      const bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          canonicalName: "Nong Family",
          originalName: "",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "Main clan",
          firstAppearance: 1,
          lastKnownAppearance: 2,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      bible.minorReferences = [
        {
          id: "ref_hall",
          name: "Nong Family Conference Hall",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: "ent_000000000000000000000001",
          firstSeenChapter: 1,
          lastSeenChapter: 2,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
        {
          id: "ref_hidden_shed",
          name: "Secret Back Shed",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          firstSeenChapter: 1,
          lastSeenChapter: 2,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];

      // Chapter text does NOT mention the hall
      const contextWithoutMention = retrieveRelevantContext(bible, "Su Ming walked through the forest.", 2);
      expect(contextWithoutMention.minorReferences).toHaveLength(0);

      // Chapter text mentions Nong Family and Nong Family Conference Hall
      const contextWithMention = retrieveRelevantContext(
        bible,
        "Su Ming visited the Nong Family Conference Hall to speak with elders of the Nong Family.",
        2,
      );
      expect(contextWithMention.minorReferences?.some((r) => r.name === "Nong Family Conference Hall")).toBe(true);
      expect(contextWithMention.minorReferences?.some((r) => r.name === "Secret Back Shed")).toBe(false);

      // Granularity audits are never leaked to LLM context
      expect(contextWithMention.granularityAudits ?? []).toHaveLength(0);
    });

    it("includes directly mentioned unparented minor references into retrieved Story Bible context", () => {
      const bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          canonicalName: "Su Ming",
          originalName: "",
          type: "character",
          aliases: [],
          aliasNarrationRules: [],
          description: "Protagonist",
          firstAppearance: 1,
          lastKnownAppearance: 2,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      bible.minorReferences = [
        {
          id: "ref_ancient_tablet",
          name: "Ancient Stone Tablet",
          originalName: "古石碑",
          type: "item",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: undefined, // unparented!
          firstSeenChapter: 1,
          lastSeenChapter: 2,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: ["Old Stone Inscription"],
          sourceEvidence: [{ chapter: 1 }],
        },
        {
          id: "ref_unmentioned_box",
          name: "Discarded Wooden Box",
          type: "item",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: undefined,
          firstSeenChapter: 1,
          lastSeenChapter: 2,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];

      const chapterText = "Su Ming examined the Ancient Stone Tablet carved with ancient glyphs.";
      const context = retrieveRelevantContext(bible, chapterText, 2);

      // Directly mentioned unparented minor reference must be included
      expect(context.minorReferences?.some((r) => r.name === "Ancient Stone Tablet")).toBe(true);
      // Unmentioned unparented minor reference must be excluded
      expect(context.minorReferences?.some((r) => r.name === "Discarded Wooden Box")).toBe(false);
    });

    it("excludes parented minor reference if its parent entity is not selected in context", () => {
      const bible = emptyStoryBible();
      // Parent entity is old and not mentioned in chapter text (score 0, filtered out when maxEntities is small)
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          canonicalName: "Su Ming",
          originalName: "",
          type: "character",
          aliases: [],
          aliasNarrationRules: [],
          description: "Hero",
          firstAppearance: 1,
          lastKnownAppearance: 50,
          provenance: [{ chapter: 50, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
        {
          id: "ent_000000000000000000000002",
          canonicalName: "Forgotten Clan",
          originalName: "",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "Ancient clan from chapter 1",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      bible.minorReferences = [
        {
          id: "ref_pavilion",
          name: "Forgotten Clan Ancestral Pavilion",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: "ent_000000000000000000000002",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];

      // Chapter text mentions the pavilion name, but Forgotten Clan itself is not selected because maxEntities=1 selects only Su Ming
      const context = retrieveRelevantContext(
        bible,
        "Su Ming remembered the Forgotten Clan Ancestral Pavilion from long ago.",
        50,
        { maxEntities: 1 },
      );
      // Parent is ent_000000000000000000000002 which is not among selectedEntities
      expect(context.canonicalEntities.map((e) => e.id)).toEqual(["ent_000000000000000000000001"]);
      // Because parent is not selected, the parented minor reference must be excluded
      expect(context.minorReferences?.some((r) => r.name === "Forgotten Clan Ancestral Pavilion")).toBe(false);
    });

    it("sheds minor references before canonical entities under character budget constraints", () => {
      const bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          canonicalName: "Su Ming",
          originalName: "",
          type: "character",
          aliases: [],
          aliasNarrationRules: [],
          description: "Protagonist of the novel who walks the cultivation path.",
          firstAppearance: 1,
          lastKnownAppearance: 2,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      bible.minorReferences = [
        {
          id: "ref_1",
          name: "Stone Tablet",
          type: "item",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: undefined,
          firstSeenChapter: 1,
          lastSeenChapter: 2,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];

      const fullContext = retrieveRelevantContext(bible, "Su Ming inspected the Stone Tablet.", 2, { maxCharacters: 50_000 });
      expect(fullContext.canonicalEntities.length).toBe(1);
      expect(fullContext.minorReferences.length).toBe(1);

      // Tight budget: minor references must be shed first while preserving canonical entity
      const tightContext = retrieveRelevantContext(bible, "Su Ming inspected the Stone Tablet.", 2, { maxCharacters: 4000 });
      expect(tightContext.canonicalEntities.length).toBe(1);
      expect(tightContext.canonicalEntities[0]!.canonicalName).toBe("Su Ming");
    });

    it("verifies all 7 context retrieval scenarios for minor references (unparented, parented, unmentioned, alias, originalName)", () => {
      const bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_111111111111111111111111",
          canonicalName: "Su Ming",
          originalName: "",
          type: "character",
          aliases: [],
          aliasNarrationRules: [],
          description: "Hero",
          firstAppearance: 1,
          lastKnownAppearance: 10,
          provenance: [{ chapter: 10, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
        {
          id: "ent_222222222222222222222222",
          canonicalName: "Ancient Clan",
          originalName: "古族",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "Ancient clan",
          firstAppearance: 1,
          lastKnownAppearance: 10,
          provenance: [{ chapter: 10, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
        {
          id: "ent_333333333333333333333333",
          canonicalName: "Distant Empire",
          originalName: "",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "Faraway empire",
          firstAppearance: 1,
          lastKnownAppearance: 1, // old appearance, won't be selected when maxEntities: 2
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      bible.minorReferences = [
        // 1. Unparented + mentioned
        {
          id: "ref_training_ground",
          name: "Ancient Training Ground",
          originalName: "古练武场",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: undefined,
          aliases: ["Old Training Grounds"],
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          sourceEvidence: [{ chapter: 1 }],
        },
        // 2. Unparented + unmentioned
        {
          id: "ref_unmentioned_altar",
          name: "Broken Altar",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: undefined,
          aliases: [],
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          sourceEvidence: [{ chapter: 1 }],
        },
        // 3. Parented + mentioned + parent selected
        {
          id: "ref_clan_hall",
          name: "Ancient Clan Great Hall",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: "ent_222222222222222222222222",
          aliases: [],
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          sourceEvidence: [{ chapter: 1 }],
        },
        // 4. Parented + mentioned + parent NOT selected
        {
          id: "ref_distant_palace",
          name: "Distant Imperial Palace",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: "ent_333333333333333333333333",
          aliases: [],
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          sourceEvidence: [{ chapter: 1 }],
        },
        // 5. Parented + unmentioned + parent selected
        {
          id: "ref_clan_garden",
          name: "Ancient Clan Secret Garden",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: "ent_222222222222222222222222",
          aliases: [],
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          sourceEvidence: [{ chapter: 1 }],
        },
      ];

      // Scenario A: Mentions Ancient Training Ground, Ancient Clan Great Hall, Distant Imperial Palace, but limits maxEntities to 2 (Su Ming and Ancient Clan selected, Distant Empire excluded)
      const textA = "Su Ming walked into the Ancient Clan Great Hall and remembered the Ancient Training Ground and Distant Imperial Palace.";
      const contextA = retrieveRelevantContext(bible, textA, 10, { maxEntities: 2 });
      const selectedEntityIds = new Set(contextA.canonicalEntities.map((e) => e.id));
      expect(selectedEntityIds.has("ent_222222222222222222222222")).toBe(true);
      expect(selectedEntityIds.has("ent_333333333333333333333333")).toBe(false);

      const minorNamesA = new Set(contextA.minorReferences.map((r) => r.name));
      // 1. Unparented + mentioned -> included
      expect(minorNamesA.has("Ancient Training Ground")).toBe(true);
      // 2. Unparented + unmentioned -> excluded
      expect(minorNamesA.has("Broken Altar")).toBe(false);
      // 3. Parented + mentioned + parent selected -> included
      expect(minorNamesA.has("Ancient Clan Great Hall")).toBe(true);
      // 4. Parented + mentioned + parent NOT selected -> excluded
      expect(minorNamesA.has("Distant Imperial Palace")).toBe(false);
      // 5. Parented + unmentioned + parent selected -> excluded
      expect(minorNamesA.has("Ancient Clan Secret Garden")).toBe(false);

      // Scenario B (6. Alias mention): Chapter mentions "Old Training Grounds"
      const textB = "Su Ming visited the Old Training Grounds in the morning.";
      const contextB = retrieveRelevantContext(bible, textB, 10);
      expect(contextB.minorReferences.some((r) => r.name === "Ancient Training Ground")).toBe(true);

      // Scenario C (7. Original-name mention): Chapter mentions "古练武场"
      const textC = "Su Ming looked toward the 古练武场 from afar.";
      const contextC = retrieveRelevantContext(bible, textC, 10);
      expect(contextC.minorReferences.some((r) => r.name === "Ancient Training Ground")).toBe(true);
    });

    it("strictly trims context under character budget: sheds minor references, relationships, timeline, summaries, and validates schema", () => {
      const bible = emptyStoryBible();
      for (let i = 1; i <= 10; i++) {
        bible.canonicalEntities.push({
          id: `ent_${String(i).padStart(24, "0")}`,
          canonicalName: `Cultivator Person Number ${i}`,
          originalName: `修士${i}`,
          type: "character",
          aliases: [`Alias Alpha ${i}`, `Alias Beta ${i}`],
          aliasNarrationRules: [],
          description: `Extensive description detailing the background, spiritual roots, martial lineage, and cultivation history of Cultivator Person Number ${i}.`,
          firstAppearance: 1,
          lastKnownAppearance: 10,
          provenance: [{ chapter: 10, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: `Detailed notes regarding techniques, loyalties, and combat readiness for character number ${i}.`,
          canonicalNameLocked: false,
          status: "active",
        });
      }

      for (let i = 1; i <= 8; i++) {
        bible.minorReferences.push({
          id: `ref_${i}`,
          name: `Ancient Relic Item ${i}`,
          type: "item",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: i % 2 === 0 ? `ent_${String(i).padStart(24, "0")}` : undefined,
          aliases: [`Relic Nickname ${i}`],
          firstSeenChapter: 1,
          lastSeenChapter: 10,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          sourceEvidence: [{ chapter: 1 }],
        });
      }

      for (let i = 1; i < 10; i++) {
        bible.canonicalRelationships.push({
          id: `rel_${i}`,
          sourceEntityId: `ent_${String(i).padStart(24, "0")}`,
          targetEntityId: `ent_${String(i + 1).padStart(24, "0")}`,
          type: "allied_with",
          startChapter: 1,
          state: "current",
          provenance: [{ chapter: 1, kind: "relationship", origin: "automatic" }],
          locked: false,
          origin: "automatic",
        });
      }

      for (let i = 1; i <= 10; i++) {
        bible.entityTimeline.push({
          id: `evt_${i}`,
          entityId: `ent_${String(i).padStart(24, "0")}`,
          chapter: i,
          type: "appearance",
          summary: `Appearance event for cultivator person number ${i}`,
          origin: "automatic",
          provenance: { chapter: i, kind: "event", origin: "automatic" },
        });
      }

      for (let i = 1; i <= 5; i++) {
        bible.chapterSummaries[i] = `Chapter ${i} summary describing pivotal events, confrontations, and breakthroughs across the martial realm.`;
      }

      for (let i = 1; i <= 10; i++) {
        bible.translationTerms.push({
          original: `术语${i}`,
          canonicalEnglish: `Martial Technical Term ${i}`,
          locked: false,
          notes: "",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
        });
      }

      const chapterText = "Cultivator Person Number 1 and Cultivator Person Number 2 visited Ancient Relic Item 1 and Ancient Relic Item 2.";

      const budgeted = retrieveRelevantContext(bible, chapterText, 10, { maxCharacters: 3500 });
      const serializedLength = JSON.stringify(budgeted).length;
      expect(serializedLength).toBeLessThanOrEqual(3500);

      const remainingEntityIds = new Set(budgeted.canonicalEntities.map((e) => e.id));
      for (const rel of budgeted.canonicalRelationships) {
        expect(remainingEntityIds.has(rel.sourceEntityId)).toBe(true);
        expect(remainingEntityIds.has(rel.targetEntityId)).toBe(true);
      }
      for (const evt of budgeted.entityTimeline) {
        expect(remainingEntityIds.has(evt.entityId)).toBe(true);
      }
      for (const ref of budgeted.minorReferences) {
        if (ref.parentEntityId) {
          expect(remainingEntityIds.has(ref.parentEntityId)).toBe(true);
        }
      }

      expect(() => retrieveRelevantContext(bible, chapterText, 10, { maxCharacters: 50 })).toThrow(
        /Story context budget 50 is smaller than the minimum serializable context/,
      );
    });
  });

  describe("Canonicalization Bypass Prevention & Unparented Minor References", () => {
    it("does NOT promote or create canonical entities when relationships reference unparented minor references", () => {
      let bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          canonicalName: "Su Ming",
          originalName: "",
          type: "character",
          aliases: [],
          aliasNarrationRules: [],
          description: "Hero",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      bible.minorReferences = [
        {
          id: "ref_rusty_dagger",
          name: "Rusty Dagger",
          type: "item",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: undefined, // unparented minor reference
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];

      // Chapter 2 update: relationship references the unparented minor reference
      const ch2Update = update(2, {
        relationships: [
          {
            subject: "Rusty Dagger",
            relationship: "held_by",
            object: "Su Ming",
            firstSeenChapter: 2,
            lastSeenChapter: 2,
            confidence: 0.8,
          },
        ],
      });

      const updated = mergeStoryBible(bible, ch2Update, 2);

      // Rusty Dagger must NEVER be created as a canonical entity!
      expect(updated.canonicalEntities.some((e) => e.canonicalName === "Rusty Dagger")).toBe(false);
      expect(updated.canonicalEntities.length).toBe(1);
      expect(updated.canonicalEntities[0]!.canonicalName).toBe("Su Ming");

      // Rusty Dagger must remain in minorReferences
      expect(updated.minorReferences.some((r) => r.name === "Rusty Dagger")).toBe(true);
      // Canonical relationship between an unparented minor reference and an entity is safely dropped
      expect(updated.canonicalRelationships.length).toBe(0);
    });

    it("does NOT create canonical entities when timeline events reference unparented minor references", () => {
      let bible = emptyStoryBible();
      bible.minorReferences = [
        {
          id: "ref_iron_key",
          name: "Iron Key",
          type: "item",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: undefined,
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];

      const chUpdate = update(2, {
        timelineEvents: [
          {
            entity: "Iron Key",
            type: "revelation",
            summary: "Iron Key unlocked the ancient vault",
            chapter: 2,
            confidence: 0.9,
          },
        ],
      });

      const updated = mergeStoryBible(bible, chUpdate, 2);

      // Iron Key must NOT be created as a canonical entity
      expect(updated.canonicalEntities.some((e) => e.canonicalName === "Iron Key")).toBe(false);
      expect(updated.canonicalEntities.length).toBe(0);
      expect(updated.minorReferences.some((r) => r.name === "Iron Key")).toBe(true);
      // Timeline event referencing unparented minor ref is safely omitted from canonical timeline
      expect(updated.entityTimeline.length).toBe(0);
    });

    it("attaches relationships referencing parented minor references to the canonical parent entity", () => {
      let bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          canonicalName: "Nong Family",
          originalName: "",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "Main clan",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
        {
          id: "ent_000000000000000000000002",
          canonicalName: "Li Clan",
          originalName: "",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "Allied clan",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      bible.minorReferences = [
        {
          id: "ref_nong_villa",
          name: "Nong Family Villa",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: "ent_000000000000000000000001",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];

      // Relationship mentions Nong Family Villa and Li Clan
      const chUpdate = update(2, {
        relationships: [
          {
            subject: "Nong Family Villa",
            relationship: "hosts_meeting_with",
            object: "Li Clan",
            firstSeenChapter: 2,
            lastSeenChapter: 2,
            confidence: 0.85,
          },
        ],
      });

      const updated = mergeStoryBible(bible, chUpdate, 2);

      // Nong Family Villa must NOT be promoted to canonicalEntities
      expect(updated.canonicalEntities.some((e) => e.canonicalName === "Nong Family Villa")).toBe(false);
      expect(updated.canonicalEntities.length).toBe(2);

      // Relationship must be attached to the parent entity ent_000000000000000000000001
      expect(updated.canonicalRelationships.length).toBe(1);
      expect(updated.canonicalRelationships[0]!.sourceEntityId).toBe("ent_000000000000000000000001");
      expect(updated.canonicalRelationships[0]!.targetEntityId).toBe("ent_000000000000000000000002");
    });

    it("ensures demoted entities referenced in subsequent chapters are never resurrected as canonical", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-resurrect-"));
      const slug = "resurrect-story";

      const pathsCh1 = storyPaths(root, slug, 1);
      const pathsCh2 = storyPaths(root, slug, 2);
      await atomicWriteJson(pathsCh1.storyConfig, {
        slug,
        title: "Resurrect Test Story",
        pipeline: { storyBible: { provider: "openai", model: "gpt-4o" } },
      });

      let bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          canonicalName: "Nong Family",
          originalName: "",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "Main clan",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
        {
          id: "ent_000000000000000000000002",
          canonicalName: "Nong Family Villa",
          originalName: "",
          type: "location",
          aliases: [],
          aliasNarrationRules: [],
          description: "Villa location",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      await atomicWriteJson(pathsCh1.bible, bible);

      // 1. Demote Nong Family Villa
      const demoteRes = await demoteCanonicalEntity(root, slug, "ent_000000000000000000000002", {
        parentEntityId: "ent_000000000000000000000001",
        reason: "Sub-location under Nong Family",
      });
      expect(demoteRes.status).toBe("demoted");

      // 2. Chapter 2 update mentions Nong Family Villa in relationship and timeline
      const ch1Update = update(1, { chapterSummary: "Ch1 intro" });
      const ch2Update = update(2, {
        relationships: [
          {
            subject: "Nong Family Villa",
            relationship: "located_near",
            object: "Nong Family",
            firstSeenChapter: 2,
            lastSeenChapter: 2,
            confidence: 0.9,
          },
        ],
        timelineEvents: [
          {
            entity: "Nong Family Villa",
            type: "revelation",
            summary: "Meeting held at villa",
            chapter: 2,
            confidence: 0.9,
          },
        ],
      });

      await atomicWriteJson(pathsCh1.bibleUpdate, ch1Update);
      await atomicWriteJson(pathsCh1.chapterMeta, { chapter: 1, stages: { storyBible: { status: "complete" } } });
      await atomicWriteJson(pathsCh2.bibleUpdate, ch2Update);
      await atomicWriteJson(pathsCh2.chapterMeta, { chapter: 2, stages: { storyBible: { status: "complete" } } });

      // 3. Rebuild before Chapter 3
      const { rebuildStoryBibleBeforeChapter } = await import("../src/story-bible/rebuild.js");
      const rebuilt = await rebuildStoryBibleBeforeChapter(root, slug, 3);

      // Nong Family Villa must NOT be resurrected into canonicalEntities!
      expect(rebuilt.canonicalEntities.some((e) => e.canonicalName === "Nong Family Villa")).toBe(false);
      expect(rebuilt.canonicalEntities.some((e) => e.id === "ent_000000000000000000000002")).toBe(false);
      // Must remain strictly in minorReferences
      expect(rebuilt.minorReferences.some((r) => r.name === "Nong Family Villa")).toBe(true);

      // Disjoint invariant: no duplicate names between canonical entities and minor references
      const canonicalNames = new Set(rebuilt.canonicalEntities.map((e) => e.canonicalName));
      for (const ref of rebuilt.minorReferences) {
        expect(canonicalNames.has(ref.name)).toBe(false);
      }
    });

    it("drops relationships between minor references that share the same canonical parent to prevent self-relationships", () => {
      let bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          canonicalName: "Nong Family",
          originalName: "",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "Main clan",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      bible.minorReferences = [
        {
          id: "ref_hall",
          name: "Nong Family Conference Hall",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: "ent_000000000000000000000001",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
        {
          id: "ref_garden",
          name: "Nong Family Courtyard Garden",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: "ent_000000000000000000000001",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];

      // Chapter 2 update: relationship between Conference Hall and Courtyard Garden
      const ch2Update = update(2, {
        relationships: [
          {
            subject: "Nong Family Conference Hall",
            relationship: "adjacent_to",
            object: "Nong Family Courtyard Garden",
            firstSeenChapter: 2,
            lastSeenChapter: 2,
            confidence: 0.85,
          },
        ],
      });

      const updated = mergeStoryBible(bible, ch2Update, 2);

      // Both resolved to Nong Family (ent_000000000000000000000001), source.id === target.id dropped it
      expect(updated.canonicalRelationships.length).toBe(0);
      expect(updated.canonicalEntities.length).toBe(1);
    });

    it("prevents demoted entities from being resurrected via relationships or timeline events", () => {
      let bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          canonicalName: "Su Ming",
          originalName: "",
          type: "character",
          aliases: [],
          aliasNarrationRules: [],
          description: "Hero",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      bible.minorReferences = [
        {
          id: "ref_demoted_hall",
          name: "Demoted Hall of Shadows",
          originalName: "暗影堂",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: undefined,
          demotedFromEntityId: "ent_444444444444444444444444",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "manual_demotion",
          status: "minor",
          aliases: ["Old Hall of Shadows"],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];

      const overlay = {
        version: 1 as const,
        overrides: {},
        merges: [],
        demotions: [
          {
            entityId: "ent_444444444444444444444444",
            name: "Demoted Hall of Shadows",
            originalName: "暗影堂",
            reason: "User demoted to minor",
            demotedAt: new Date().toISOString(),
            source: "manual" as const,
          },
        ],
        promotions: [],
        suppressions: [],
        parentAssignments: {},
        visualEvidenceDecisions: {},
      };

      const ch2Update = update(2, {
        relationships: [
          {
            subject: "Demoted Hall of Shadows",
            relationship: "visited_by",
            object: "Su Ming",
            firstSeenChapter: 2,
            lastSeenChapter: 2,
            confidence: 0.9,
          },
        ],
        timelineEvents: [
          {
            entity: "Demoted Hall of Shadows",
            type: "revelation",
            summary: "Demoted Hall was sealed",
            chapter: 2,
            confidence: 0.9,
          },
        ],
      });

      const updated = mergeStoryBible(bible, ch2Update, 2, overlay);

      // Must NOT recreate Demoted Hall of Shadows as canonical!
      expect(updated.canonicalEntities.some((e) => e.canonicalName === "Demoted Hall of Shadows")).toBe(false);
      expect(updated.canonicalEntities.length).toBe(1);
      expect(updated.canonicalEntities[0]!.canonicalName).toBe("Su Ming");

      // Relationships and timeline targeting demoted entity must not create canonical records
      expect(updated.canonicalRelationships.length).toBe(0);
      expect(updated.entityTimeline.length).toBe(0);
    });

    it("verifies the complete demotion, rebuild, extraction, and promotion lifecycle for Nong Family Conference Hall", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-lifecycle-"));
      const slug = "conference-hall-lifecycle";

      const pathsCh1 = storyPaths(root, slug, 1);
      const pathsCh2 = storyPaths(root, slug, 2);
      await atomicWriteJson(pathsCh1.storyConfig, {
        slug,
        title: "Lifecycle Test Story",
        pipeline: { storyBible: { provider: "openai", model: "gpt-4o" } },
      });

      let bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_111122223333444455556666",
          canonicalName: "Nong Family",
          originalName: "农家",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "The main clan",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "active",
        },
        {
          id: "ent_777788889999000011112222",
          canonicalName: "Nong Family Conference Hall",
          originalName: "农家议事堂",
          type: "location",
          aliases: [],
          aliasNarrationRules: [],
          description: "Conference hall of the clan",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      await atomicWriteJson(pathsCh1.bible, bible);

      // Step 1: Demotion -> Nong Family Conference Hall canonical -> demoted -> minor under Nong Family
      const demoteRes = await demoteCanonicalEntity(root, slug, "ent_777788889999000011112222", {
        parentEntityId: "ent_111122223333444455556666",
        reason: "Sub-location under Nong Family",
      });
      expect(demoteRes.status).toBe("demoted");

      // Verify only minor representation remains active
      const bibleAfterDemote = await readJsonIfExists<StoryBible>(pathsCh1.bible);
      expect(bibleAfterDemote?.canonicalEntities.some((e) => e.canonicalName === "Nong Family Conference Hall")).toBe(false);
      const minorRef = bibleAfterDemote?.minorReferences.find((r) => r.name === "Nong Family Conference Hall");
      expect(minorRef).toBeDefined();
      expect(minorRef?.parentEntityId).toBe("ent_111122223333444455556666");

      // Step 2: Rebuild Story Bible
      const ch1Update = update(1, {
        chapterSummary: "Chapter 1 overview",
        locations: [
          named("Nong Family Conference Hall", 1, {
            originalName: "农家议事堂",
            description: "Conference hall of the clan",
            confidence: 0.95,
          }),
        ],
        factions: [
          named("Nong Family", 1, {
            originalName: "农家",
            description: "The main clan",
            confidence: 0.95,
          }),
        ],
      });
      await atomicWriteJson(pathsCh1.bibleUpdate, ch1Update);
      await atomicWriteJson(pathsCh1.chapterMeta, { chapter: 1, stages: { storyBible: { status: "complete" } } });

      const { rebuildStoryBibleBeforeChapter } = await import("../src/story-bible/rebuild.js");
      const rebuiltBeforeCh2 = await rebuildStoryBibleBeforeChapter(root, slug, 2);
      expect(rebuiltBeforeCh2.canonicalEntities.some((e) => e.canonicalName === "Nong Family Conference Hall")).toBe(false);
      expect(rebuiltBeforeCh2.minorReferences.some((r) => r.name === "Nong Family Conference Hall")).toBe(true);

      // Step 3: Future extraction mentions Conference Hall again in Chapter 2
      const ch2Update = update(2, {
        chapterSummary: "Chapter 2 meeting",
        locations: [
          named("Nong Family Conference Hall", 2, {
            originalName: "农家议事堂",
            description: "Elders gathered in the hall",
            confidence: 0.95,
          }),
        ],
        relationships: [
          {
            subject: "Nong Family Conference Hall",
            relationship: "hosts_meeting_of",
            object: "Nong Family",
            firstSeenChapter: 2,
            lastSeenChapter: 2,
            confidence: 0.9,
          },
        ],
      });
      await atomicWriteJson(pathsCh2.bibleUpdate, ch2Update);
      await atomicWriteJson(pathsCh2.chapterMeta, { chapter: 2, stages: { storyBible: { status: "complete" } } });

      const rebuiltBeforeCh3 = await rebuildStoryBibleBeforeChapter(root, slug, 3);
      // Canonical entity does NOT reappear
      expect(rebuiltBeforeCh3.canonicalEntities.some((e) => e.canonicalName === "Nong Family Conference Hall")).toBe(false);
      // Minor reference updates evidence
      const updatedRef = rebuiltBeforeCh3.minorReferences.find((r) => r.name === "Nong Family Conference Hall");
      expect(updatedRef).toBeDefined();
      expect(updatedRef?.sourceEvidence.some((e) => e.chapter === 2)).toBe(true);

      // Step 4: Explicit Promotion
      await atomicWriteJson(pathsCh1.bible, rebuiltBeforeCh3);
      const promoteRes = await promoteMinorReference(root, slug, updatedRef!.id, {
        reason: "Hall became significant battle venue",
      });
      expect(promoteRes.status).toBe("promoted");

      // Verify minor representation removed / reconciled, canonical representation becomes active
      const bibleAfterPromo = await readJsonIfExists<StoryBible>(pathsCh1.bible);
      expect(bibleAfterPromo?.canonicalEntities.some((e) => e.canonicalName === "Nong Family Conference Hall")).toBe(true);
      expect(bibleAfterPromo?.minorReferences.some((r) => r.name === "Nong Family Conference Hall")).toBe(false);
    });
  });

  describe("Server Catalog & Operations Integration", () => {
    it("exposes minor references pagination, parent names, and analysis via server catalog and operations", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-server-"));
      const slug = "test-story";

      const bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_000000000000000000000001",
          canonicalName: "Nong Family",
          originalName: "",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "Main clan",
          firstAppearance: 1,
          lastKnownAppearance: 2,
          provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      bible.minorReferences = [
        {
          id: "ref_1",
          name: "Nong Family Conference Hall",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: "ent_000000000000000000000001",
          firstSeenChapter: 1,
          lastSeenChapter: 2,
          occurrenceCount: 2,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }, { chapter: 2 }],
        },
        {
          id: "ref_2",
          name: "Nong Family Kitchen",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.88,
          parentEntityId: "ent_000000000000000000000001",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];
      await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);

      // Test getMinorReferencesPage
      const page = await getMinorReferencesPage(root, slug, { page: 1, pageSize: 10, type: "location" });
      expect(page.total).toBe(2);
      expect(page.items[0]?.parentEntityName).toBe("Nong Family");

      // Test server operations
      const ops = new StudioOperations(root, loadEnvironment({}));
      const analysis = await ops.analyzeStoryBible(slug);
      expect(analysis.totalCanonical).toBe(1);

      // Test update minor reference
      const updated = await ops.updateMinorReference(slug, "ref_1", { contextNotes: "Restricted to senior members" });
      expect(updated.reference.contextNotes).toBe("Restricted to senior members");
    });
  });

  describe("Regression Hardening & Granularity Edge Cases", () => {
    it("handles realistic Nong Family fixture correctly: sub-locations minor under org, independent character and item canonical", () => {
      const nongFamily: CanonicalEntity = {
        id: "ent_nong_family_org",
        canonicalName: "Nong Family",
        originalName: "农家",
        type: "organization",
        aliases: ["Nong Clan"],
        aliasNarrationRules: [],
        description: "Prominent cultivation clan",
        firstAppearance: 1,
        lastKnownAppearance: 10,
        provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }],
        origin: "automatic",
        mergedFromIds: [],
        notes: "",
        canonicalNameLocked: false,
        status: "unknown",
      };

      const context = { canonicalEntities: [nongFamily] };

      // Sub-locations under Nong Family
      const estate = classifyEntityPersistenceSync({ name: "Nong Family Estate", type: "location" }, context);
      expect(estate.disposition).toBe("minor_reference");
      expect(estate.parentEntityId).toBe("ent_nong_family_org");

      const villa = classifyEntityPersistenceSync({ name: "Nong Family Villa", type: "location" }, context);
      expect(villa.disposition).toBe("minor_reference");
      expect(villa.parentEntityId).toBe("ent_nong_family_org");

      const receptionHall = classifyEntityPersistenceSync({ name: "Nong Family Reception Hall", type: "location" }, context);
      expect(receptionHall.disposition).toBe("minor_reference");
      expect(receptionHall.parentEntityId).toBe("ent_nong_family_org");

      const conferenceHall = classifyEntityPersistenceSync({ name: "Nong Family Conference Hall", type: "location" }, context);
      expect(conferenceHall.disposition).toBe("minor_reference");
      expect(conferenceHall.parentEntityId).toBe("ent_nong_family_org");

      // Character sharing prefix
      const patriarch = classifyEntityPersistenceSync({ name: "Nong Family Patriarch", type: "character" }, context);
      expect(patriarch.disposition).toBe("canonical");
      expect(patriarch.reason).not.toContain("sub-location");

      // Item sharing prefix
      const sword = classifyEntityPersistenceSync({ name: "Nong Family Ancestral Sword", type: "item" }, context);
      expect(sword.disposition).toBe("canonical");
    });

    it("keeps recurring minor-reference evidence bounded after 20 chapters without promoting it", () => {
      let bible = emptyStoryBible();

      // Chapter 1: Nong Family
      bible = mergeStoryBible(
        bible,
        update(1, {
          factions: [named("Nong Family", 1)],
          locations: [named("Nong Family Conference Hall", 1)],
        }),
        1,
      );

      const ref = bible.minorReferences.find((r) => r.name === "Nong Family Conference Hall");
      expect(ref).toBeDefined();
      expect(ref?.parentEntityId).toBeDefined();
      expect(ref?.status).toBe("minor");

      // A long-running minor reference must remain valid beyond the evidence cap.
      for (let ch = 2; ch <= 25; ch++) {
        bible = mergeStoryBible(
          bible,
          update(ch, {
            locations: [named("Nong Family Conference Hall", ch)],
          }),
          ch,
        );
      }

      const refAfter25 = bible.minorReferences.find((r) => r.name === "Nong Family Conference Hall")!;
      expect(refAfter25.occurrenceCount).toBe(25);
      expect(refAfter25.sourceEvidence).toHaveLength(20);
      expect(refAfter25.sourceEvidence.map((item) => item.chapter)).toEqual([1, ...Array.from({ length: 19 }, (_, index) => index + 7)]);
      // Because it has a parentEntityId, it must NOT automatically become a promotion candidate
      expect(refAfter25.status).toBe("minor");
      // And must NOT have been promoted to canonical
      expect(bible.canonicalEntities.some((e) => e.canonicalName === "Nong Family Conference Hall")).toBe(false);
    });

    it("does not claim 'Recurring' in reason on first appearance of a canonical entity", () => {
      const result = classifyEntityPersistenceSync(
        {
          name: "Immortal Phoenix Sect",
          type: "organization",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
        },
        { canonicalEntities: [] },
      );
      expect(result.disposition).toBe("canonical");

      const characterResult = classifyEntityPersistenceSync(
        {
          name: "Zhao Tian",
          type: "character",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
        },
        { canonicalEntities: [] },
      );
      expect(characterResult.disposition).toBe("canonical");
      expect(characterResult.reason).not.toContain("Recurring");
    });

    it("records origin 'automatic' when promoted by analyzer/ai and 'manual' when promoted by user", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-prov-"));
      const slug = "test-story";

      const bible = emptyStoryBible();
      bible.minorReferences = [
        {
          id: "ref_auto_promo",
          name: "Lotus Pond Pavilion",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          firstSeenChapter: 1,
          lastSeenChapter: 2,
          occurrenceCount: 2,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }, { chapter: 2 }],
        },
        {
          id: "ref_user_promo",
          name: "Dragon Gate Chamber",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          firstSeenChapter: 1,
          lastSeenChapter: 2,
          occurrenceCount: 2,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }, { chapter: 2 }],
        },
      ];
      await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);

      // 1. Promote via analyzer
      const autoRes = await promoteMinorReference(root, slug, "ref_auto_promo", {
        source: "analyzer",
        reason: "Analyzer suggested promotion",
      });
      expect(autoRes.entity.origin).toBe("automatic");
      expect(autoRes.entity.provenance[0]?.origin).toBe("automatic");

      // 2. Promote via manual user action
      const manualRes = await promoteMinorReference(root, slug, "ref_user_promo", {
        source: "manual",
        reason: "User promoted entity",
      });
      expect(manualRes.entity.origin).toBe("manual");
      expect(manualRes.entity.provenance[0]?.origin).toBe("manual");
    });

    it("reconciles relationships, child minor references, and timeline events upon demotion", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-dep-"));
      const slug = "test-story";

      const bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_111111111111111111111111",
          canonicalName: "Nong Clan",
          originalName: "",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "",
          firstAppearance: 1,
          lastKnownAppearance: 3,
          provenance: [],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
        {
          id: "ent_222222222222222222222222",
          canonicalName: "Nong Compound",
          originalName: "",
          type: "location",
          aliases: [],
          aliasNarrationRules: [],
          description: "Sub compound to be demoted",
          firstAppearance: 1,
          lastKnownAppearance: 2,
          provenance: [],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
        {
          id: "ent_333333333333333333333333",
          canonicalName: "Su Ming",
          originalName: "",
          type: "character",
          aliases: [],
          aliasNarrationRules: [],
          description: "",
          firstAppearance: 1,
          lastKnownAppearance: 3,
          provenance: [],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];

      // Relationship Su Ming -> Nong Compound
      bible.canonicalRelationships = [
        {
          id: "rel_111111111111111111111111",
          sourceEntityId: "ent_333333333333333333333333",
          targetEntityId: "ent_222222222222222222222222",
          type: "infiltrated",
          startChapter: 1,
          state: "current",
          provenance: [],
          locked: false,
          origin: "automatic",
        },
      ];

      // Child minor reference inside Nong Compound
      bible.minorReferences = [
        {
          id: "ref_tea_room",
          name: "Tea Room",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          parentEntityId: "ent_222222222222222222222222",
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];

      // Timeline event referencing Nong Compound
      bible.entityTimeline = [
        {
          id: "evt_111111111111111111111111",
          entityId: "ent_333333333333333333333333",
          chapter: 1,
          type: "appearance",
          summary: "Su Ming entered compound",
          relatedEntityId: "ent_222222222222222222222222",
          origin: "automatic",
          provenance: { chapter: 1, kind: "event", origin: "automatic" },
        },
      ];

      await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);

      // Demote Nong Compound with parent Nong Clan
      const demoted = await demoteCanonicalEntity(root, slug, "ent_222222222222222222222222", {
        parentEntityId: "ent_111111111111111111111111",
        reason: "Sub compound under main clan",
      });

      const updated = demoted.bible;

      // Relationship target should be remapped to Nong Clan
      const rel = updated.canonicalRelationships.find((r) => r.id === "rel_111111111111111111111111");
      expect(rel).toBeDefined();
      expect(rel?.targetEntityId).toBe("ent_111111111111111111111111");

      // Child minor reference parent should be remapped to Nong Clan
      const teaRoom = updated.minorReferences.find((r) => r.id === "ref_tea_room");
      expect(teaRoom?.parentEntityId).toBe("ent_111111111111111111111111");

      // Timeline event related entity should be remapped to Nong Clan
      const evt = updated.entityTimeline.find((e) => e.id === "evt_111111111111111111111111");
      expect(evt?.relatedEntityId).toBe("ent_111111111111111111111111");
    });

    it("enforces idempotence for demotion and promotion", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-idemp-"));
      const slug = "test-story";

      const bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_444444444444444444444444",
          canonicalName: "Side Hall",
          originalName: "",
          type: "location",
          aliases: [],
          aliasNarrationRules: [],
          description: "",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);

      // First demotion succeeds
      const firstDemote = await demoteCanonicalEntity(root, slug, "ent_444444444444444444444444");
      expect(firstDemote.status).toBe("demoted");

      // Second demotion is idempotent
      const secondDemote = await demoteCanonicalEntity(root, slug, "ent_444444444444444444444444");
      expect(secondDemote.status).toBe("already_demoted");

      // First promotion succeeds
      const firstPromo = await promoteMinorReference(root, slug, secondDemote.referenceId);
      expect(firstPromo.status).toBe("promoted");

      // Second promotion is idempotent
      const secondPromo = await promoteMinorReference(root, slug, secondDemote.referenceId);
      expect(secondPromo.status).toBe("already_promoted");
    });

    it("validates parent assignments and prevents self-parenting", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-parent-"));
      const slug = "test-story";

      const bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_555555555555555555555555",
          canonicalName: "Imperial Palace",
          originalName: "",
          type: "location",
          aliases: [],
          aliasNarrationRules: [],
          description: "",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      bible.minorReferences = [
        {
          id: "ref_gate",
          name: "South Gate",
          type: "location",
          disposition: "minor_reference",
          confidence: 0.9,
          firstSeenChapter: 1,
          lastSeenChapter: 1,
          occurrenceCount: 1,
          source: "automatic",
          status: "minor",
          aliases: [],
          sourceEvidence: [{ chapter: 1 }],
        },
      ];
      await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);

      const ops = new StudioOperations(root, loadEnvironment({}));

      // Non-existent parent throws
      await expect(
        ops.updateMinorReference(slug, "ref_gate", { parentEntityId: "ent_999999999999999999999999" }),
      ).rejects.toThrow(/not found in canonical entities/i);

      // Self-parenting throws
      await expect(
        ops.updateMinorReference(slug, "ref_gate", { parentEntityId: "ref_gate" }),
      ).rejects.toThrow(/cannot be its own parent/i);

      // Setting valid parent succeeds
      const valid = await ops.updateMinorReference(slug, "ref_gate", { parentEntityId: "ent_555555555555555555555555" });
      expect(valid.reference.parentEntityId).toBe("ent_555555555555555555555555");

      // Clearing parent cleans up parentAssignments overlay without writing empty string
      const cleared = await ops.updateMinorReference(slug, "ref_gate", { parentEntityId: null });
      expect(cleared.reference.parentEntityId).toBeUndefined();
    });

    it("produces deterministic recommendation IDs across repeated analysis calls", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-stable-id-"));
      const slug = "test-story";

      const bible = emptyStoryBible();
      bible.canonicalEntities = [
        {
          id: "ent_666666666666666666666666",
          canonicalName: "Black Mountain Sect",
          originalName: "",
          type: "organization",
          aliases: [],
          aliasNarrationRules: [],
          description: "Main sect",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
        {
          id: "ent_777777777777777777777777",
          canonicalName: "Black Mountain Sect Hall",
          originalName: "",
          type: "location",
          aliases: [],
          aliasNarrationRules: [],
          description: "Meeting hall",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        },
      ];
      await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);

      const report1 = await analyzeStoryBible(root, slug);
      const report2 = await analyzeStoryBible(root, slug);

      expect(report1.recommendations.length).toBe(report2.recommendations.length);
      for (let i = 0; i < report1.recommendations.length; i++) {
        expect(report1.recommendations[i]?.id).toBe(report2.recommendations[i]?.id);
      }
    });

    it("executes full lifecycle: initial extraction -> demote -> rebuild -> promote -> rebuild -> protect -> cleanup immune", async () => {
      const root = await mkdtemp(join(tmpdir(), "granularity-lifecycle-"));
      const slug = "lifecycle-story";

      // 1. Initial extraction: Story with 2 chapters
      // Chapter 1: Nong Family (org) and Nong Family Estate (location)
      const ch1Update = update(1, {
        factions: [named("Nong Family", 1)],
        locations: [named("Nong Family Estate", 1)],
        chapterSummary: "Introduction to Nong Family and Estate",
      });
      // Chapter 2: Nong Family Estate referenced again
      const ch2Update = update(2, {
        locations: [named("Nong Family Estate", 2)],
        chapterSummary: "Action at the Nong Family Estate",
      });

      const pathsCh1 = storyPaths(root, slug, 1);
      const pathsCh2 = storyPaths(root, slug, 2);

      await atomicWriteJson(pathsCh1.storyConfig, {
        slug,
        title: "Lifecycle Story",
        pipeline: { storyBible: { provider: "openai", model: "gpt-4o" } },
      });
      await atomicWriteJson(pathsCh1.bibleUpdate, ch1Update);
      await atomicWriteJson(pathsCh1.chapterMeta, { chapter: 1, stages: { storyBible: { status: "complete" } } });
      await atomicWriteJson(pathsCh2.bibleUpdate, ch2Update);
      await atomicWriteJson(pathsCh2.chapterMeta, { chapter: 2, stages: { storyBible: { status: "complete" } } });

      let initialBible = emptyStoryBible();
      initialBible = mergeStoryBible(initialBible, ch1Update, 1);
      await atomicWriteJson(pathsCh1.bible, initialBible);

      // Nong Family Estate started as a canonical entity or minor reference
      const nong = initialBible.canonicalEntities.find((e) => e.canonicalName === "Nong Family")!;

      // 2. Demote Nong Family Estate to minor reference
      // If it was already minor reference or canonical entity, ensure canonical first to test full demote lifecycle
      if (!initialBible.canonicalEntities.some((e) => e.canonicalName === "Nong Family Estate")) {
        // Manually place it in canonicalEntities to simulate legacy extraction before granularity rules
        initialBible.canonicalEntities.push({
          id: "ent_888888888888888888888888",
          canonicalName: "Nong Family Estate",
          originalName: "",
          type: "location",
          aliases: [],
          aliasNarrationRules: [],
          description: "Legacy estate",
          firstAppearance: 1,
          lastKnownAppearance: 1,
          provenance: [],
          origin: "automatic",
          mergedFromIds: [],
          notes: "",
          canonicalNameLocked: false,
          status: "unknown",
        });
        initialBible.minorReferences = initialBible.minorReferences.filter((r) => r.name !== "Nong Family Estate");
        await atomicWriteJson(pathsCh1.bible, initialBible);
      }

      const estateEntity = initialBible.canonicalEntities.find((e) => e.canonicalName === "Nong Family Estate")!;
      const demoteRes = await demoteCanonicalEntity(root, slug, estateEntity.id, {
        parentEntityId: nong.id,
        reason: "Estate belongs to Nong Family",
      });
      expect(demoteRes.status).toBe("demoted");

      // 3. Rebuild before Chapter 3: verify demotion persists across rebuild!
      const { rebuildStoryBibleBeforeChapter } = await import("../src/story-bible/rebuild.js");
      const rebuilt1 = await rebuildStoryBibleBeforeChapter(root, slug, 3);
      expect(rebuilt1.canonicalEntities.some((e) => e.canonicalName === "Nong Family Estate")).toBe(false);
      expect(rebuilt1.minorReferences.some((r) => r.name === "Nong Family Estate")).toBe(true);
      const estateRef = rebuilt1.minorReferences.find((r) => r.name === "Nong Family Estate")!;
      expect(estateRef.parentEntityId).toBe(nong.id);

      // 4. Promote Nong Family Estate to canonical entity
      await atomicWriteJson(pathsCh1.bible, rebuilt1);
      const promoRes = await promoteMinorReference(root, slug, estateRef.id, {
        source: "manual",
        reason: "Promoted by author to be a key battle arena",
      });
      expect(promoRes.status).toBe("promoted");
      expect(promoRes.entity.origin).toBe("manual");

      // 5. Rebuild again: verify promotion persists!
      const rebuilt2 = await rebuildStoryBibleBeforeChapter(root, slug, 3);
      expect(rebuilt2.canonicalEntities.some((e) => e.canonicalName === "Nong Family Estate")).toBe(true);
      expect(rebuilt2.minorReferences.some((r) => r.name === "Nong Family Estate")).toBe(false);
      await atomicWriteJson(pathsCh1.bible, rebuilt2);

      // 6. Configure manual protection: lock canonical name
      const canonicalEstate = rebuilt2.canonicalEntities.find((e) => e.canonicalName === "Nong Family Estate")!;
      await updateCanonicalEntity(root, slug, rebuilt2, canonicalEstate.id, {
        canonicalNameLocked: true,
        notes: "Crucial battle ground in climax arc",
      });

      // 7. Run bulk cleanup: protected entity must NOT be demoted or merged
      const cleanupResult = await applyCleanupRecommendations(root, slug, { highConfidenceOnly: false });
      expect(cleanupResult.skippedProtectedCount).toBeGreaterThanOrEqual(1);
      expect(cleanupResult.skippedProtected).toContain("Nong Family Estate");

      const finalBible = cleanupResult.bible;
      expect(finalBible.canonicalEntities.some((e) => e.canonicalName === "Nong Family Estate")).toBe(true);
    });
  });
});
