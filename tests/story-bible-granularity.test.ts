import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCanonicalEntitiesPage, getMinorReferencesPage, getStoryBibleAnalysis } from "../apps/server/catalog.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { CanonicalEntity, emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
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
});
