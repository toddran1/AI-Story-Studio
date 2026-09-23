import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { join, basename } from "node:path";
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
  prepareVisualCanonMerge,
  rollbackPreparedVisualCanonMerge,
  generateStyleSheet,
} from "../src/visual-canon/profiles.js";
import * as profilesModule from "../src/visual-canon/profiles.js";
import * as canonicalModule from "../src/story-bible/canonical.js";
import * as granularityModule from "../src/story-bible/granularity.js";
import { ReconciliationError, StorageError } from "../src/pipeline/errors.js";
import { readActivity } from "../src/studio/projects.js";
import {
  normalizeVisualReferenceExtension,
  isVisualReferenceExtension,
  mimeForVisualReferenceExtension,
  findVisualReferenceFile,
  deleteControlledVisualReferenceFiles,
} from "../src/visual-canon/assets.js";
import * as assetsModule from "../src/visual-canon/assets.js";
import { loadStoryArtDirection } from "../src/visual-canon/art-direction.js";
import { ImageProvider } from "../src/artwork/provider.js";
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

  it("preserves but unapproves a Visual Profile after canonical type correction", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));
    await updateVisualProfile(tempDir, slug, idTarget, { visualType: "character", appearance: "Distinct cloak", status: "approved" });
    const result = await operations.updateCanonicalEntity(slug, idTarget, { type: "location" });
    expect(result.visualProfileReviewRequired).toBe(true);
    expect((await getVisualProfile(tempDir, slug, idTarget))?.status).toBe("draft");
    expect((await getVisualProfile(tempDir, slug, idTarget))?.appearance).toBe("Distinct cloak");
    expect((await getStoryBible(tempDir, slug)).canonicalEntities.find((item) => item.id === idTarget)?.type).toBe("location");
  });

  it("suppresses and restores a canonical identity through the shared operations layer", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));
    await updateVisualProfile(tempDir, slug, idSource, { appearance: "Historical design", status: "approved" });
    const removed = await operations.suppressCanonicalEntity(slug, idSource, { reason: "Duplicate residue" });
    expect(removed.status).toBe("suppressed");
    expect((await getStoryBible(tempDir, slug)).canonicalEntities.some((item) => item.id === idSource)).toBe(false);
    expect((await loadVisualProfiles(tempDir, slug))[idSource]?.appearance).toBe("Historical design");
    const restored = await operations.restoreCanonicalEntity(slug, idSource);
    expect(restored.status).toBe("restored");
    expect((await getStoryBible(tempDir, slug)).canonicalEntities.some((item) => item.id === idSource)).toBe(true);
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

  // Scenario L: Visual Canon commit failure after Story Bible merge rolls back Story Bible and prepared assets
  it("Scenario L: Visual Canon commit failure after Story Bible merge rolls back Story Bible and prepared assets", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target Appearance" });
    await updateVisualProfile(tempDir, slug, idSource, { appearance: "Source Appearance" });

    const { reference: srcRef } = await addVisualReferenceImage(tempDir, slug, idSource, {
      data: DUMMY_PNG,
      role: "face_portrait",
      ext: "png",
    });

    const commitSpy = vi.spyOn(profilesModule, "commitVisualCanonMerge").mockRejectedValueOnce(
      new Error("Disk failure during Visual Canon commit")
    );

    await expect(
      operations.mergeCanonicalEntities(slug, {
        targetEntityId: idTarget,
        sourceEntityIds: [idSource],
        reason: "Test merge rollback on Visual Canon failure",
      })
    ).rejects.toThrow("Disk failure during Visual Canon commit");

    commitSpy.mockRestore();

    // Story Bible was restored via undoCanonicalMerge
    const bibleAfter = await getStoryBible(tempDir, slug);
    expect(bibleAfter.canonicalEntities.some((e) => e.id === idSource)).toBe(true);
    expect(bibleAfter.canonicalEntities.some((e) => e.id === idTarget)).toBe(true);

    // Source visual profile and reference image remain intact
    const profiles = await loadVisualProfiles(tempDir, slug);
    expect(profiles[idSource]).toBeDefined();
    expect(profiles[idSource]?.references.length).toBe(1);
    expect(await exists(srcRef.imagePath)).toBe(true);

    // No merge activity was logged because transaction aborted
    const activities = await readActivity(tempDir, slug);
    expect(activities.some((a) => a.type === "bible.entities.merged")).toBe(false);
  });

  // Scenario M1 (Case B): Visual Canon commit failure with failed VC rollback still executes Bible undo and throws ReconciliationError
  it("Scenario M1 (Case B): Visual Canon commit failure with failed VC rollback still executes Bible undo and throws ReconciliationError", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target Appearance" });
    await updateVisualProfile(tempDir, slug, idSource, { appearance: "Source Appearance" });

    const commitSpy = vi.spyOn(profilesModule, "commitVisualCanonMerge").mockRejectedValueOnce(
      new Error("Primary commit failed")
    );
    const rollbackVCSpy = vi.spyOn(profilesModule, "rollbackPreparedVisualCanonMerge").mockRejectedValueOnce(
      new Error("Rollback VC assets failed")
    );

    let caughtError: any;
    try {
      await operations.mergeCanonicalEntities(slug, {
        targetEntityId: idTarget,
        sourceEntityIds: [idSource],
        reason: "Testing Case B",
      });
    } catch (err) {
      caughtError = err;
    } finally {
      commitSpy.mockRestore();
      rollbackVCSpy.mockRestore();
    }

    expect(caughtError).toBeInstanceOf(ReconciliationError);
    const recErr = caughtError as ReconciliationError;
    expect(recErr.storySlug).toBe(slug);
    expect(recErr.targetEntityId).toBe(idTarget);
    expect(recErr.sourceEntityIds).toEqual([idSource]);
    expect(recErr.failedPhase).toBe("visual_canon_commit_rollback");
    expect((recErr.cause as Error)?.message).toBe("Primary commit failed");
    expect(recErr.rollbackFailures).toHaveLength(1);
    expect(recErr.rollbackFailures?.[0]?.phase).toBe("visual_canon_prepared_assets");
    expect((recErr.rollbackFailures?.[0]?.error as Error)?.message).toBe("Rollback VC assets failed");
    expect((recErr.rollbackError as Error)?.message).toBe("Rollback VC assets failed");

    // CRITICAL: Story Bible undo STILL executed and restored despite VC rollback failure!
    const bibleAfter = await getStoryBible(tempDir, slug);
    expect(bibleAfter.canonicalEntities.some((e) => e.id === idSource)).toBe(true);
    expect(bibleAfter.canonicalEntities.some((e) => e.id === idTarget)).toBe(true);

    // No merge activity logged
    const activities = await readActivity(tempDir, slug);
    expect(activities.some((a) => a.type === "bible.entities.merged")).toBe(false);
  });

  // Scenario M2 (Case C): Visual Canon commit failure with failed Story Bible undo throws ReconciliationError
  it("Scenario M2 (Case C): Visual Canon commit failure with failed Story Bible undo throws ReconciliationError", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target Appearance" });
    await updateVisualProfile(tempDir, slug, idSource, { appearance: "Source Appearance" });

    const commitSpy = vi.spyOn(profilesModule, "commitVisualCanonMerge").mockRejectedValueOnce(
      new Error("Primary commit failed")
    );
    const undoSpy = vi.spyOn(canonicalModule, "undoCanonicalMerge").mockRejectedValueOnce(
      new Error("Undo canonical merge disk error")
    );

    let caughtError: any;
    try {
      await operations.mergeCanonicalEntities(slug, {
        targetEntityId: idTarget,
        sourceEntityIds: [idSource],
        reason: "Testing Case C",
      });
    } catch (err) {
      caughtError = err;
    } finally {
      commitSpy.mockRestore();
      undoSpy.mockRestore();
    }

    expect(caughtError).toBeInstanceOf(ReconciliationError);
    const recErr = caughtError as ReconciliationError;
    expect(recErr.storySlug).toBe(slug);
    expect(recErr.targetEntityId).toBe(idTarget);
    expect(recErr.sourceEntityIds).toEqual([idSource]);
    expect(recErr.failedPhase).toBe("visual_canon_commit_rollback");
    expect((recErr.cause as Error)?.message).toBe("Primary commit failed");
    expect(recErr.rollbackFailures).toHaveLength(1);
    expect(recErr.rollbackFailures?.[0]?.phase).toBe("story_bible_merge");
    expect((recErr.rollbackFailures?.[0]?.error as Error)?.message).toBe("Undo canonical merge disk error");
    expect((recErr.rollbackError as Error)?.message).toBe("Undo canonical merge disk error");
    expect(recErr.message).toContain("rollback could not fully restore the previous state");

    // No merge activity logged
    const activities = await readActivity(tempDir, slug);
    expect(activities.some((a) => a.type === "bible.entities.merged")).toBe(false);
  });

  // Scenario M3 (Case D): Visual Canon commit failure with BOTH VC rollback and Story Bible undo failing records both failures
  it("Scenario M3 (Case D): Visual Canon commit failure with BOTH VC rollback and Story Bible undo failing records both failures", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target Appearance" });
    await updateVisualProfile(tempDir, slug, idSource, { appearance: "Source Appearance" });

    const commitSpy = vi.spyOn(profilesModule, "commitVisualCanonMerge").mockRejectedValueOnce(
      new Error("Primary commit failed")
    );
    const rollbackVCSpy = vi.spyOn(profilesModule, "rollbackPreparedVisualCanonMerge").mockRejectedValueOnce(
      new Error("Rollback VC assets failed")
    );
    const undoSpy = vi.spyOn(canonicalModule, "undoCanonicalMerge").mockRejectedValueOnce(
      new Error("Undo canonical merge failed")
    );

    let caughtError: any;
    try {
      await operations.mergeCanonicalEntities(slug, {
        targetEntityId: idTarget,
        sourceEntityIds: [idSource],
        reason: "Testing Case D",
      });
    } catch (err) {
      caughtError = err;
    } finally {
      commitSpy.mockRestore();
      rollbackVCSpy.mockRestore();
      undoSpy.mockRestore();
    }

    expect(caughtError).toBeInstanceOf(ReconciliationError);
    const recErr = caughtError as ReconciliationError;
    expect(recErr.storySlug).toBe(slug);
    expect(recErr.targetEntityId).toBe(idTarget);
    expect(recErr.sourceEntityIds).toEqual([idSource]);
    expect(recErr.failedPhase).toBe("visual_canon_commit_rollback");
    expect((recErr.cause as Error)?.message).toBe("Primary commit failed");
    expect(recErr.rollbackFailures).toHaveLength(2);
    expect(recErr.rollbackFailures?.map((f) => f.phase)).toEqual([
      "visual_canon_prepared_assets",
      "story_bible_merge",
    ]);
    expect((recErr.rollbackFailures?.[0]?.error as Error)?.message).toBe("Rollback VC assets failed");
    expect((recErr.rollbackFailures?.[1]?.error as Error)?.message).toBe("Undo canonical merge failed");
    expect((recErr.rollbackError as Error)?.message).toBe("Rollback VC assets failed");

    // No merge activity logged
    const activities = await readActivity(tempDir, slug);
    expect(activities.some((a) => a.type === "bible.entities.merged")).toBe(false);
  });

  // Scenario M4: Demote failure with BOTH Story Bible restore and Visual Canon rollback failing records both failures
  it("Scenario M4: Demote failure with BOTH Story Bible restore and Visual Canon rollback failing records both failures", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target Appearance" });

    const commitSpy = vi.spyOn(profilesModule, "commitVisualCanonDemote").mockRejectedValueOnce(
      new Error("Visual Canon demote write failed")
    );
    const restoreSpy = vi.spyOn(granularityModule, "restorePreDemoteStoryBible").mockRejectedValueOnce(
      new Error("Disk restore error")
    );
    const rollbackDemoteSpy = vi.spyOn(profilesModule, "rollbackPreparedVisualCanonDemote").mockRejectedValueOnce(
      new Error("Visual Canon rollback error")
    );

    let caughtError: any;
    try {
      await operations.demoteCanonicalEntity(slug, idTarget, {
        reason: "Testing demotion double rollback failure",
      });
    } catch (err) {
      caughtError = err;
    } finally {
      commitSpy.mockRestore();
      restoreSpy.mockRestore();
      rollbackDemoteSpy.mockRestore();
    }

    expect(caughtError).toBeInstanceOf(ReconciliationError);
    const recErr = caughtError as ReconciliationError;
    expect(recErr.storySlug).toBe(slug);
    expect(recErr.targetEntityId).toBe(idTarget);
    expect(recErr.failedPhase).toBe("visual_canon_demote_rollback");
    expect((recErr.cause as Error)?.message).toBe("Visual Canon demote write failed");
    expect(recErr.rollbackFailures).toHaveLength(2);
    expect(recErr.rollbackFailures?.map((f) => f.phase)).toEqual([
      "story_bible_demote",
      "visual_canon_demote",
    ]);
    expect((recErr.rollbackFailures?.[0]?.error as Error)?.message).toBe("Disk restore error");
    expect((recErr.rollbackFailures?.[1]?.error as Error)?.message).toBe("Visual Canon rollback error");
    expect((recErr.rollbackError as Error)?.message).toBe("Disk restore error");

    // No demote activity logged
    const activities = await readActivity(tempDir, slug);
    expect(activities.some((a) => a.type === "bible.entity.demoted")).toBe(false);
  });

  // Scenario N: Demotion commit failure restores pre-demotion Story Bible faithfully
  it("Scenario N: Demotion commit failure restores pre-demotion Story Bible faithfully", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    // Setup target with rich attributes and approved profile
    await updateVisualProfile(tempDir, slug, idTarget, {
      appearance: "Target Appearance",
      status: "approved",
      notes: "Canon notes",
    });

    const commitSpy = vi.spyOn(profilesModule, "commitVisualCanonDemote").mockRejectedValueOnce(
      new Error("Visual Canon demote write failed")
    );

    await expect(
      operations.demoteCanonicalEntity(slug, idTarget, {
        reason: "Testing demotion rollback",
      })
    ).rejects.toThrow("Visual Canon demote write failed");

    commitSpy.mockRestore();

    // Story Bible entity must be fully restored
    const bibleAfter = await getStoryBible(tempDir, slug);
    const entity = bibleAfter.canonicalEntities.find((e) => e.id === idTarget);
    expect(entity).toBeDefined();
    expect(entity?.canonicalName).toBe("Protagonist Target");
    expect(entity?.aliases).toEqual(["Hero"]);
    expect(entity?.description).toBe("Target entity for merge tests");

    // Visual profile remains approved (not modified to draft)
    const profiles = await loadVisualProfiles(tempDir, slug);
    expect(profiles[idTarget]?.status).toBe("approved");

    // No demotion activity logged
    const activities = await readActivity(tempDir, slug);
    expect(activities.some((a) => a.type === "bible.entity.demoted")).toBe(false);
  });

  // Scenario O: Real filesystem cleanup failure during merge finalization logs warning and preserves successful merge
  it("Scenario O: Real filesystem cleanup failure during merge finalization logs warning and preserves successful merge", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create a source directory with a file inside it, then make directory read-only so rm fails with EACCES
    const unremovableDir = join(tempDir, "unremovable-source-dir");
    await mkdir(unremovableDir, { recursive: true });
    await writeFile(join(unremovableDir, "dummy.txt"), "data", "utf8");
    await chmod(unremovableDir, 0o555);

    const prepared = {
      targetEntityId: idTarget,
      sourceEntityIds: [idSource],
      preparedProfiles: {},
      migratedTargetPaths: [],
      migratedSourceDirs: [unremovableDir],
    };

    try {
      const result = await finalizeVisualCanonMerge(prepared);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain("Failed to clean up source directory");
      expect(warnSpy).toHaveBeenCalled();
      const warnCall = warnSpy.mock.calls.find((call) =>
        String(call[0]).includes("Failed to clean up source directory")
      );
      expect(warnCall).toBeDefined();
    } finally {
      await chmod(unremovableDir, 0o777);
      warnSpy.mockRestore();
    }
  });

  // Scenario P: Individual reference deletion with real cleanup failure surfaces cleanupWarnings and removes metadata
  // Scenario O2: Merge with cleanup warnings from finalizeVisualCanonMerge propagates cleanupWarnings without rolling back
  it("Scenario O2: Merge with cleanup warnings from finalizeVisualCanonMerge propagates cleanupWarnings without rolling back", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target Appearance" });
    await updateVisualProfile(tempDir, slug, idSource, { appearance: "Source Appearance" });

    const finalizeSpy = vi.spyOn(profilesModule, "finalizeVisualCanonMerge").mockResolvedValueOnce({
      cleanedDirs: [],
      errors: ["Non-fatal unlink warning: file locked by another process"],
    });

    try {
      const result = await operations.mergeCanonicalEntities(slug, {
        targetEntityId: idTarget,
        sourceEntityIds: [idSource],
        reason: "Testing cleanup warnings propagation",
      });

      expect(result).toBeDefined();
      expect(result.cleanupWarnings).toEqual(["Non-fatal unlink warning: file locked by another process"]);
      expect(result.merge.id).toBeDefined();

      // Logical commit succeeded and was not rolled back!
      const bibleAfter = await getStoryBible(tempDir, slug);
      expect(bibleAfter.canonicalEntities.some((e) => e.id === idSource)).toBe(false);
      expect(bibleAfter.canonicalEntities.some((e) => e.id === idTarget)).toBe(true);

      // Merge activity was logged because logical transaction committed
      const activities = await readActivity(tempDir, slug);
      expect(activities.some((a) => a.type === "bible.entities.merged")).toBe(true);
    } finally {
      finalizeSpy.mockRestore();
    }
  });
  it("Scenario P: Individual reference deletion with real cleanup failure surfaces cleanupWarnings and removes metadata", async () => {
    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target" });
    const { reference: ref } = await addVisualReferenceImage(tempDir, slug, idTarget, {
      data: DUMMY_PNG,
      role: "front",
      ext: "png",
    });

    expect(await exists(ref.imagePath)).toBe(true);

    // Make the containing entity directory read-only so deleting the file inside it fails with EACCES
    const targetDir = join(storyPaths(tempDir, slug, 1).visualProfilesDirectory, idTarget);
    await chmod(targetDir, 0o555);

    try {
      const result = await deleteVisualReferenceImage(tempDir, slug, idTarget, ref.id);

      expect(result.deleted).toBe(true);
      expect(result.cleanupWarnings).toBeDefined();
      expect(result.cleanupWarnings?.length).toBeGreaterThan(0);
      expect(result.cleanupWarnings?.[0]).toContain("EACCES");
      // Metadata was still cleaned up
      expect(result.profile.references.some((r) => r.id === ref.id)).toBe(false);

      // Profile on disk also reflects metadata deletion
      const profiles = await loadVisualProfiles(tempDir, slug);
      expect(profiles[idTarget]?.references.some((r) => r.id === ref.id)).toBe(false);
    } finally {
      await chmod(targetDir, 0o777);
    }
  });

  // Scenario Q: Narrow rollback deletes only newly-migrated target assets, preserving existing target assets
  it("Scenario Q: Narrow rollback deletes only newly-migrated target assets, preserving existing target assets", async () => {
    // Target entity already has an existing reference
    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target" });
    const { reference: existingTargetRef } = await addVisualReferenceImage(tempDir, slug, idTarget, {
      data: DUMMY_PNG,
      role: "front",
      ext: "png",
    });
    expect(await exists(existingTargetRef.imagePath)).toBe(true);

    // Source entity has a reference
    await updateVisualProfile(tempDir, slug, idSource, { appearance: "Source" });
    const { reference: sourceRef } = await addVisualReferenceImage(tempDir, slug, idSource, {
      data: DUMMY_PNG,
      role: "side",
      ext: "png",
    });
    expect(await exists(sourceRef.imagePath)).toBe(true);

    // Prepare merge
    const prepared = await prepareVisualCanonMerge(tempDir, slug, idTarget, [idSource]);
    expect(prepared.migratedTargetPaths.length).toBe(1);
    const newlyPreparedPath = prepared.migratedTargetPaths[0]!;
    expect(await exists(newlyPreparedPath)).toBe(true);
    expect(newlyPreparedPath).not.toBe(existingTargetRef.imagePath);

    // Rollback prepared merge
    await rollbackPreparedVisualCanonMerge(prepared);

    // Newly prepared target path is deleted
    expect(await exists(newlyPreparedPath)).toBe(false);

    // Pre-existing target reference image is still present and untouched!
    expect(await exists(existingTargetRef.imagePath)).toBe(true);

    // Source reference image is still present and untouched!
    expect(await exists(sourceRef.imagePath)).toBe(true);
  });

  // Scenario R1: Nonexistent canonical entity cannot create or update Visual Profile
  it("Scenario R1: nonexistent canonical entity cannot create or update Visual Profile", async () => {
    const invalidId = "ent_999999999999999999999999";
    await expect(updateVisualProfile(tempDir, slug, invalidId, { appearance: "Ghost" }))
      .rejects.toThrow("Canonical entity 'ent_999999999999999999999999' was not found in Story Bible");
  });

  // Scenario R2: Nonexistent canonical entity cannot receive reference image
  it("Scenario R2: nonexistent canonical entity cannot receive reference", async () => {
    const invalidId = "ent_999999999999999999999999";
    await expect(
      addVisualReferenceImage(tempDir, slug, invalidId, {
        data: DUMMY_PNG,
        role: "face_portrait",
        ext: "png",
      })
    ).rejects.toThrow("Canonical entity 'ent_999999999999999999999999' was not found in Story Bible");
  });

  // Scenario R3: Nonexistent canonical entity cannot generate Style Sheet
  it("Scenario R3: nonexistent canonical entity cannot generate Style Sheet", async () => {
    const invalidId = "ent_999999999999999999999999";
    const dummyProvider: ImageProvider = {
      name: "test-provider",
      version: "1.0",
      validateConfiguration: async () => {},
      generate: async () => ({ data: DUMMY_PNG, mimeType: "image/png" }),
    };
    await expect(generateStyleSheet(tempDir, slug, invalidId, dummyProvider, story))
      .rejects.toThrow("Canonical entity 'ent_999999999999999999999999' was not found in Story Bible");
  });

  // Scenario S: prepareVisualCanonMerge does not mutate original profile metadata
  it("Scenario S: prepareVisualCanonMerge does not mutate original profile metadata", async () => {
    await updateVisualProfile(tempDir, slug, idTarget, {
      appearance: "Target App",
      notes: "Original Target Notes",
      negativePrompt: "target_bad",
      variants: [{ id: "var_target", name: "TargetVariant", description: "target variant app" }],
    });
    await addVisualReferenceImage(tempDir, slug, idTarget, {
      data: DUMMY_PNG,
      role: "front",
      ext: "png",
    });

    await updateVisualProfile(tempDir, slug, idSource, {
      appearance: "Source App",
      notes: "Original Source Notes",
      negativePrompt: "source_bad",
      variants: [{ id: "var_source", name: "SourceVariant", description: "source variant app" }],
    });
    await addVisualReferenceImage(tempDir, slug, idSource, {
      data: DUMMY_PNG,
      role: "side",
      ext: "png",
    });

    const originalProfiles = await loadVisualProfiles(tempDir, slug);
    const targetBefore = structuredClone(originalProfiles[idTarget]!);
    const sourceBefore = structuredClone(originalProfiles[idSource]!);

    // Prepare merge WITHOUT commit
    const prepared = await prepareVisualCanonMerge(tempDir, slug, idTarget, [idSource]);

    // Verify original input profiles are 100% unchanged
    expect(originalProfiles[idTarget]!.notes).toBe(targetBefore.notes);
    expect(originalProfiles[idTarget]!.negativePrompt).toBe(targetBefore.negativePrompt);
    expect(originalProfiles[idTarget]!.variants).toEqual(targetBefore.variants);
    expect(originalProfiles[idTarget]!.references.length).toBe(targetBefore.references.length);
    expect(originalProfiles[idTarget]!.revision).toBe(targetBefore.revision);

    expect(originalProfiles[idSource]!.notes).toBe(sourceBefore.notes);
    expect(originalProfiles[idSource]!.negativePrompt).toBe(sourceBefore.negativePrompt);
    expect(originalProfiles[idSource]!.variants).toEqual(sourceBefore.variants);
    expect(originalProfiles[idSource]!.references.length).toBe(sourceBefore.references.length);
    expect(originalProfiles[idSource]!.revision).toBe(sourceBefore.revision);

    // Rollback prepared assets
    await rollbackPreparedVisualCanonMerge(prepared);
  });

  // Scenario T1: Metadata save failure cleans the new reference file
  it("Scenario T1: metadata save failure after reference file creation cleans the new file", async () => {
    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target" });
    const { reference: existingRef } = await addVisualReferenceImage(tempDir, slug, idTarget, {
      data: DUMMY_PNG,
      role: "front",
      ext: "png",
    });
    expect(await exists(existingRef.imagePath)).toBe(true);

    const storyDir = join(tempDir, "stories", slug);
    const entityDir = join(storyPaths(tempDir, slug, 1).visualProfilesDirectory, idTarget);

    // Make story directory read-only so saving metadata fails, but entityDir is writable
    await chmod(storyDir, 0o555);

    try {
      await expect(
        addVisualReferenceImage(tempDir, slug, idTarget, {
          data: DUMMY_PNG,
          role: "side",
          ext: "png",
        })
      ).rejects.toThrow();

      // Existing reference preserved
      expect(await exists(existingRef.imagePath)).toBe(true);

      // Restore permission to inspect
      await chmod(storyDir, 0o777);
      const profiles = await loadVisualProfiles(tempDir, slug);
      expect(profiles[idTarget]?.references.length).toBe(1);

      // Verify no orphaned reference files were left in entityDir
      const filesInEntityDir = await fsPromises.readdir(entityDir);
      expect(filesInEntityDir.length).toBe(1);
      expect(filesInEntityDir[0]).toBe(basename(existingRef.imagePath));
    } finally {
      await chmod(storyDir, 0o777);
    }
  });

  // Scenario T2: Cleanup failure after metadata save failure preserves primary metadata error and logs observable sanitized warning
  it("Scenario T2: cleanup failure after metadata save failure preserves primary metadata error and logs observable sanitized warning", async () => {
    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target" });
    const { reference: existingRef } = await addVisualReferenceImage(tempDir, slug, idTarget, {
      data: DUMMY_PNG,
      role: "front",
      ext: "png",
    });
    expect(await exists(existingRef.imagePath)).toBe(true);

    const storyDir = join(tempDir, "stories", slug);
    // Make story directory read-only so saving metadata fails, but entityDir is writable
    await chmod(storyDir, 0o555);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cleanupSpy = vi
      .spyOn(assetsModule, "removeControlledVisualReferenceFile")
      .mockRejectedValueOnce(new Error("Simulated disk failure unlinking reference file"));

    try {
      const err = await addVisualReferenceImage(tempDir, slug, idTarget, {
        data: DUMMY_PNG,
        role: "expression_sheet",
        ext: "png",
      }).catch((e) => e);

      // Controlled cleanup helper was called with exact identifiers
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(cleanupSpy).toHaveBeenCalledWith(tempDir, slug, idTarget, expect.stringMatching(/^ref_/), "png");

      // Primary metadata error is preserved
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).cause).toBeDefined();
      expect(((err as StorageError).cause as NodeJS.ErrnoException).code).toBe("EACCES");

      // Observable warning was logged with safe identifiers and error details, NOT absolute path
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warningMessage = String(warnSpy.mock.calls[0]?.[0]);
      expect(warningMessage).toContain("[VisualCanon] Failed to clean up orphan reference asset");
      expect(warningMessage).toContain(`story='${slug}'`);
      expect(warningMessage).toContain(`entity='${idTarget}'`);
      expect(warningMessage).toContain("extension='png'");
      expect(warningMessage).toContain("Simulated disk failure unlinking reference file");

      // Absolute filesystem path must NOT be leaked in the warning
      expect(warningMessage).not.toContain(tempDir);
      expect(warningMessage).not.toContain("/stories/");
    } finally {
      cleanupSpy.mockRestore();
      warnSpy.mockRestore();
      await chmod(storyDir, 0o777);
    }
  });

  // Scenario U: Style Sheet format adheres to PNG-only ImageProvider contract
  it("Scenario U: Style Sheet format adheres to PNG-only ImageProvider contract", async () => {
    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target Character" });

    const pngProvider: ImageProvider = {
      name: "png-provider",
      version: "1.0",
      validateConfiguration: async () => {},
      generate: async () => ({
        data: DUMMY_PNG,
        mimeType: "image/png",
      }),
    };

    const result = await generateStyleSheet(tempDir, slug, idTarget, pngProvider, story);
    expect(result.reference.imagePath.endsWith(".png")).toBe(true);
    expect(result.reference.role).toBe("expression_sheet");
  });

  // Scenario V1: Missing Art Direction loads defaults
  it("Scenario V1: missing Art Direction loads defaults", async () => {
    const artDirection = await loadStoryArtDirection(tempDir, slug);
    expect(artDirection.activePresetId).toBe("preset_main_style");
    expect(artDirection.presets.length).toBeGreaterThan(0);
    expect(artDirection.presets[0]?.artStyle).toBe("Manhwa");
  });

  // Scenario V2: Invalid persisted Art Direction throws instead of silently defaulting, and does not overwrite
  it("Scenario V2: invalid persisted Art Direction throws instead of silently defaulting, and does not overwrite", async () => {
    const artDirectionPath = storyPaths(tempDir, slug, 1).artDirection;
    const corruptedContent = JSON.stringify({ corrupted: true, presets: "not an array" });
    await writeFile(artDirectionPath, corruptedContent, "utf8");

    await expect(loadStoryArtDirection(tempDir, slug)).rejects.toThrow(
      `Saved Art Direction for story '${slug}' is invalid and could not be loaded`
    );

    const fileOnDisk = await readFile(artDirectionPath, "utf8");
    expect(fileOnDisk).toBe(corruptedContent);
  });

  // Scenario W1: Missing Visual Profiles returns empty record
  it("Scenario W1: missing Visual Profiles returns empty record", async () => {
    const profiles = await loadVisualProfiles(tempDir, slug);
    expect(profiles).toEqual({});
  });

  // Scenario W2: Valid Visual Profiles loads correctly
  it("Scenario W2: valid Visual Profiles loads correctly", async () => {
    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Valid Entity" });
    const profiles = await loadVisualProfiles(tempDir, slug);
    expect(profiles[idTarget]?.appearance).toBe("Valid Entity");
  });

  // Scenario W3: Invalid persisted Visual Profiles throws actionable error and does not overwrite
  it("Scenario W3: invalid persisted Visual Profiles throws actionable error and does not overwrite", async () => {
    const profilesPath = storyPaths(tempDir, slug, 1).visualProfiles;
    const corruptedContent = JSON.stringify({ [idTarget]: { corrupted: true, invalidStructure: 123 } });
    await writeFile(profilesPath, corruptedContent, "utf8");

    await expect(loadVisualProfiles(tempDir, slug)).rejects.toThrow(
      `Saved Visual Profiles for story '${slug}' are invalid and could not be loaded`
    );

    // Corrupted file on disk must remain untouched
    const fileOnDisk = await readFile(profilesPath, "utf8");
    expect(fileOnDisk).toBe(corruptedContent);

    // Mutating operation must reject and not overwrite corrupted file
    await expect(
      updateVisualProfile(tempDir, slug, idTarget, { appearance: "Attempted Overwrite" })
    ).rejects.toThrow(`Saved Visual Profiles for story '${slug}' are invalid and could not be loaded`);

    const fileAfterAttempt = await readFile(profilesPath, "utf8");
    expect(fileAfterAttempt).toBe(corruptedContent);
  });

  // Scenario X: ENOENT cleanup remains benign while real filesystem inspection/removal errors remain observable
  it("Scenario X: ENOENT cleanup remains benign while real filesystem inspection/removal errors remain observable", async () => {
    const missingResult = await deleteControlledVisualReferenceFiles(tempDir, slug, idTarget, "ref_nonexistent");
    expect(missingResult.wasMissing).toBe(true);
    expect(missingResult.deletedCount).toBe(0);
    expect(missingResult.errors).toEqual([]);

    const targetDir = join(storyPaths(tempDir, slug, 1).visualProfilesDirectory, idTarget);
    await mkdir(targetDir, { recursive: true });
    const testFilePath = join(targetDir, "ref_test_locked.png");
    await writeFile(testFilePath, DUMMY_PNG);

    // Make targetDir read-only so rm fails with EACCES
    await chmod(targetDir, 0o555);
    try {
      const errorResult = await deleteControlledVisualReferenceFiles(tempDir, slug, idTarget, "ref_test_locked");
      expect(errorResult.errors.length).toBeGreaterThan(0);
      expect(errorResult.errors.some((e) => e.code === "EACCES")).toBe(true);
    } finally {
      await chmod(targetDir, 0o777);
    }
  });
});
