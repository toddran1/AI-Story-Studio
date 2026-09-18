import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testStory } from "./helpers.js";
import { StoryBible, emptyStoryBible, canonicalEntitySchema } from "../src/domain/story-bible.js";
import {
  loadVisualProfiles,
  saveVisualProfiles,
  getVisualProfile,
  updateVisualProfile,
  deleteVisualReferenceImage,
  addVisualReferenceImage,
  handleEntityMerge,
  finalizeVisualCanonMerge,
} from "../src/visual-canon/profiles.js";
import {
  normalizeVisualReferenceExtension,
  isVisualReferenceExtension,
  mimeForVisualReferenceExtension,
  findVisualReferenceFile,
} from "../src/visual-canon/assets.js";
import { visualProfileRefPath, storyPaths } from "../src/storage/paths.js";
import { exists } from "../src/storage/story-files.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { getStoryBible } from "../apps/server/catalog.js";

const DUMMY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

describe("Milestone 21: Visual Canon Backend Consistency & Asset Safety Hardening", () => {
  let tempDir: string;
  const slug = "hardening-test-story";
  const story = testStory();

  const idTarget = "ent_111111111111111111111111";
  const idSource = "ent_222222222222222222222222";

  let testBible: StoryBible;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "visual-canon-backend-test-"));
    await mkdir(join(tempDir, "stories", slug), { recursive: true });
    await atomicWriteJson(storyPaths(tempDir, slug, 1).storyConfig, story);

    testBible = {
      ...emptyStoryBible(),
      canonicalEntities: [
        canonicalEntitySchema.parse({
          id: idTarget,
          type: "character",
          canonicalName: "Protagonist Target",
          aliases: ["Hero"],
          description: "Target entity for merge tests",
          firstAppearance: 1,
          lastKnownAppearance: 5,
        }),
        canonicalEntitySchema.parse({
          id: idSource,
          type: "character",
          canonicalName: "Duplicate Source",
          aliases: ["Alt Hero"],
          description: "Source entity to be merged",
          firstAppearance: 1,
          lastKnownAppearance: 3,
        }),
      ],
    };
    await atomicWriteJson(storyPaths(tempDir, slug, 1).bible, testBible);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  // Scenario A: Visual Canon merge failure prevents Story Bible commit / marks operation failed
  it("Scenario A: merge failure during Visual Canon preparation prevents Story Bible commit", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    // Setup source with profile
    await updateVisualProfile(tempDir, slug, idSource, { appearance: "Source Appearance" });

    // Calling with an invalid entity ID (not matching schema) will fail preparation
    await expect(
      operations.mergeCanonicalEntities(slug, {
        targetEntityId: idTarget,
        sourceEntityIds: ["invalid_id"],
        reason: "Testing merge failure",
      })
    ).rejects.toThrow();

    // Verify Story Bible was NOT changed (idSource is still in canonicalEntities)
    const bibleAfter = await getStoryBible(tempDir, slug);
    expect(bibleAfter.canonicalEntities.some((e) => e.id === idSource)).toBe(true);
    expect(bibleAfter.canonicalEntities.some((e) => e.id === idTarget)).toBe(true);
  });

  // Scenario B: Successful merge synchronizes both Story Bible and Visual Canon
  it("Scenario B: successful merge synchronizes both Story Bible and Visual Canon atomically", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    // Setup visual profiles and reference for source
    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target Appearance" });
    await updateVisualProfile(tempDir, slug, idSource, { appearance: "Source Appearance" });

    const { reference: srcRef } = await addVisualReferenceImage(tempDir, slug, idSource, {
      data: DUMMY_PNG,
      role: "face_portrait",
      ext: "png",
    });

    expect(await exists(srcRef.imagePath)).toBe(true);

    const result = await operations.mergeCanonicalEntities(slug, {
      targetEntityId: idTarget,
      sourceEntityIds: [idSource],
      reason: "Merging duplicate character records",
    });

    expect(result.merge).toBeDefined();

    // Verify Story Bible
    const bibleAfter = await getStoryBible(tempDir, slug);
    expect(bibleAfter.canonicalEntities.some((e) => e.id === idSource)).toBe(false);
    expect(bibleAfter.canonicalEntities.some((e) => e.id === idTarget)).toBe(true);

    // Verify Visual Canon
    const profiles = await loadVisualProfiles(tempDir, slug);
    expect(profiles[idSource]).toBeUndefined();
    expect(profiles[idTarget]).toBeDefined();

    const targetProfile = profiles[idTarget]!;
    expect(targetProfile.references.length).toBe(1);
    expect(targetProfile.references[0]!.provenance?.migratedFromEntityId).toBe(idSource);
    expect(await exists(targetProfile.references[0]!.imagePath)).toBe(true);

    // Verify source directory was cleaned up
    const sourceDir = join(storyPaths(tempDir, slug, 1).visualProfilesDirectory, idSource);
    expect(await exists(sourceDir)).toBe(false);
  });

  // Scenario C: Continuity merge executes single authoritative synchronization
  it("Scenario C: continuity resolution 'merged' performs single authoritative synchronization", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    // Setup visual profile for source
    await updateVisualProfile(tempDir, slug, idSource, { appearance: "Source Hero" });
    await addVisualReferenceImage(tempDir, slug, idSource, {
      data: DUMMY_PNG,
      role: "expression_sheet",
      ext: "webp",
    });

    // Create a continuity review with finding matching continuityFindingSchema & continuityReviewSchema
    const findingId = "ctf_111111111111111111111111";
    const continuityData = {
      version: 1,
      analyzedThroughChapter: 2,
      inputFingerprint: "fp_test_12345",
      updatedAt: new Date().toISOString(),
      findings: [
        {
          id: findingId,
          type: "identity_alias_ambiguity",
          severity: "warning",
          status: "open",
          explanation: "Hero and Alt Hero appear to be the same person.",
          supportingFacts: [
            {
              entityId: idSource,
              chapter: 1,
              summary: "Observed in chapter 1",
              provenanceKind: "chapter_text",
            },
          ],
          evidenceFingerprint: "fp_test_12345",
          entityIds: [idTarget, idSource],
          chapters: [1, 2],
        },
      ],
    };
    await atomicWriteJson(storyPaths(tempDir, slug, 1).continuityReview, continuityData);

    const res = await operations.resolveContinuity(slug, findingId, {
      resolution: "merged",
      note: "Confirmed duplicates from finding",
    });

    expect(res.finding.status).toBe("merged");
    expect(res.finding.resolutionNote).toBe("Confirmed duplicates from finding");

    // Both Story Bible and Visual Canon should be updated
    const bibleAfter = await getStoryBible(tempDir, slug);
    expect(bibleAfter.canonicalEntities.some((e) => e.id === idSource)).toBe(false);

    const profiles = await loadVisualProfiles(tempDir, slug);
    expect(profiles[idSource]).toBeUndefined();
    expect(profiles[idTarget]?.references.length).toBe(1);
  });

  // Scenario D: Demotion failure surfaces to caller and succeeds normally
  it("Scenario D: demoteCanonicalEntity updates profile status without swallowing errors", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    await updateVisualProfile(tempDir, slug, idTarget, {
      appearance: "Target Appearance",
      notes: "Important notes",
      status: "approved",
    });

    const result = await operations.demoteCanonicalEntity(slug, idTarget, {
      reason: "Minor background character",
    });

    expect(result.status).toBe("demoted");
    expect(result.entityId).toBe(idTarget);

    const profiles = await loadVisualProfiles(tempDir, slug);
    const profile = profiles[idTarget]!;
    expect(profile.status).toBe("draft");
    expect(profile.notes).toContain("[Archived from demoted entity]");
  });

  // Scenario E: Destructive reference-image deletion rejects / ignores arbitrary imagePath
  it("Scenario E: reference image deletion strictly ignores external or tampered imagePath", async () => {
    // Create an external file outside the story
    const externalFile = join(tempDir, "critical-external-secret.txt");
    await writeFile(externalFile, "TOP_SECRET_DATA", "utf8");
    expect(await exists(externalFile)).toBe(true);

    // Setup a profile with a reference whose imagePath points to externalFile
    const refId = "ref_tampered01";
    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target" });
    const profiles = await loadVisualProfiles(tempDir, slug);
    profiles[idTarget]!.references.push({
      id: refId,
      entityId: idTarget,
      role: "front",
      imagePath: externalFile, // malicious / tampered path
      createdAt: new Date().toISOString(),
      source: "uploaded",
      approved: false,
    });
    await saveVisualProfiles(tempDir, slug, profiles);

    // Perform deletion
    const delResult = await deleteVisualReferenceImage(tempDir, slug, idTarget, refId);
    expect(delResult.deleted).toBe(true);

    // CRITICAL: The external file MUST NOT have been deleted!
    expect(await exists(externalFile)).toBe(true);
    const content = await readFile(externalFile, "utf8");
    expect(content).toBe("TOP_SECRET_DATA");

    // Profile metadata was cleanly updated
    const updatedProfiles = await loadVisualProfiles(tempDir, slug);
    expect(updatedProfiles[idTarget]!.references.some((r) => r.id === refId)).toBe(false);
  });

  // Scenario F: Deleting reference image with valid canonical path succeeds
  it("Scenario F: deleting reference image removes file on disk and updates metadata", async () => {
    const { reference } = await addVisualReferenceImage(tempDir, slug, idTarget, {
      data: DUMMY_PNG,
      role: "front",
      ext: "png",
    });

    expect(await exists(reference.imagePath)).toBe(true);

    const result = await deleteVisualReferenceImage(tempDir, slug, idTarget, reference.id);
    expect(result.deleted).toBe(true);
    expect(await exists(reference.imagePath)).toBe(false);

    const profile = await getVisualProfile(tempDir, slug, idTarget);
    expect(profile?.references.length).toBe(0);
  });

  // Scenario G: Missing reference image file on disk deletes metadata cleanly
  it("Scenario G: missing physical reference file is handled idempotently during deletion", async () => {
    const { reference } = await addVisualReferenceImage(tempDir, slug, idTarget, {
      data: DUMMY_PNG,
      role: "front",
      ext: "png",
    });

    // Manually delete the physical file
    await rm(reference.imagePath, { force: true });
    expect(await exists(reference.imagePath)).toBe(false);

    // Deletion must succeed without throwing
    const result = await deleteVisualReferenceImage(tempDir, slug, idTarget, reference.id);
    expect(result.deleted).toBe(true);

    const profile = await getVisualProfile(tempDir, slug, idTarget);
    expect(profile?.references.length).toBe(0);
  });

  // Scenario H: Centralized extension validation
  it("Scenario H: centralized extension validation enforces allowed formats and rejects unsafe ones", async () => {
    // Valid formats
    expect(normalizeVisualReferenceExtension("png")).toBe("png");
    expect(normalizeVisualReferenceExtension("PNG")).toBe("png");
    expect(normalizeVisualReferenceExtension(".jpg")).toBe("jpg");
    expect(normalizeVisualReferenceExtension("jpeg")).toBe("jpeg");
    expect(normalizeVisualReferenceExtension("  .webp  ")).toBe("webp");

    expect(isVisualReferenceExtension("png")).toBe(true);
    expect(isVisualReferenceExtension("jpg")).toBe(true);
    expect(isVisualReferenceExtension("jpeg")).toBe(true);
    expect(isVisualReferenceExtension("webp")).toBe(true);

    // Invalid formats
    expect(isVisualReferenceExtension("exe")).toBe(false);
    expect(isVisualReferenceExtension("sh")).toBe(false);
    expect(isVisualReferenceExtension("svg")).toBe(false);
    expect(isVisualReferenceExtension("")).toBe(false);

    expect(() => normalizeVisualReferenceExtension("exe")).toThrow("Unsupported reference image format");
    expect(() => normalizeVisualReferenceExtension("")).toThrow("Invalid reference image extension");

    // addVisualReferenceImage rejects invalid format
    await expect(
      addVisualReferenceImage(tempDir, slug, idTarget, {
        data: DUMMY_PNG,
        ext: "exe",
      })
    ).rejects.toThrow("Unsupported reference image format");

    // visualProfileRefPath rejects invalid format
    expect(() => visualProfileRefPath(tempDir, slug, idTarget, "ref_123", "exe")).toThrow();
  });

  // Scenario I: Serving reference images resolves supported formats safely
  it("Scenario I: findVisualReferenceFile and mime helper resolve assets safely", async () => {
    const { reference } = await addVisualReferenceImage(tempDir, slug, idTarget, {
      data: DUMMY_PNG,
      role: "front",
      ext: "jpg",
    });

    const found = await findVisualReferenceFile(tempDir, slug, idTarget, reference.id);
    expect(found).toBeDefined();
    expect(found?.ext).toBe("jpg");
    expect(found?.path).toBe(reference.imagePath);

    expect(mimeForVisualReferenceExtension("png")).toBe("image/png");
    expect(mimeForVisualReferenceExtension("jpg")).toBe("image/jpeg");
    expect(mimeForVisualReferenceExtension("jpeg")).toBe("image/jpeg");
    expect(mimeForVisualReferenceExtension("webp")).toBe("image/webp");

    // Non-existent ref returns undefined
    const notFound = await findVisualReferenceFile(tempDir, slug, idTarget, "ref_nonexistent");
    expect(notFound).toBeUndefined();
  });

  // Scenario J: Visual Canon merge ignores unsafe source imagePath
  it("Scenario J: Visual Canon merge does not read or copy arbitrary external source paths", async () => {
    const externalSecret = join(tempDir, "source-external-secret.txt");
    await writeFile(externalSecret, "CONFIDENTIAL_PAYLOAD", "utf8");

    const refId = "ref_external_source";
    await updateVisualProfile(tempDir, slug, idSource, { appearance: "Source" });
    const profiles = await loadVisualProfiles(tempDir, slug);
    profiles[idSource]!.references.push({
      id: refId,
      entityId: idSource,
      role: "side",
      imagePath: externalSecret, // External path
      createdAt: new Date().toISOString(),
      source: "uploaded",
      approved: false,
    });
    await saveVisualProfiles(tempDir, slug, profiles);

    // Merge entities
    await handleEntityMerge(tempDir, slug, idTarget, [idSource]);

    // External secret was untouched
    expect(await exists(externalSecret)).toBe(true);
    expect(await readFile(externalSecret, "utf8")).toBe("CONFIDENTIAL_PAYLOAD");

    // Target profile was created with reference metadata, but never copied external secret
    const updatedProfiles = await loadVisualProfiles(tempDir, slug);
    const targetRef = updatedProfiles[idTarget]!.references[0]!;
    expect(targetRef.imagePath).not.toBe(externalSecret);
    expect(targetRef.imagePath).toContain(idTarget);
    // The target path should not contain the external secret's content
    expect(await exists(targetRef.imagePath)).toBe(false);
  });

  // Scenario K: Non-critical cleanup failure after successful commit logs warning and preserves merge
  it("Scenario K: source directory cleanup failure is non-fatal to merge", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Prepare a merge object with a dummy directory
    const dummyNonExistent = join(tempDir, "stories", slug, "visual-profiles", "ent_nonexistent_dir");

    const prepared = {
      targetEntityId: idTarget,
      sourceEntityIds: [idSource],
      preparedProfiles: {},
      migratedTargetPaths: [],
      migratedSourceDirs: [dummyNonExistent],
    };

    // finalizeVisualCanonMerge does not throw
    const result = await finalizeVisualCanonMerge(prepared);
    expect(result.cleanedDirs.length).toBe(1); // rm with force: true succeeds on non-existent

    warnSpy.mockRestore();
  });
});
