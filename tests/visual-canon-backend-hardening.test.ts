import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { mkdtemp, rm, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
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
  prepareVisualCanonMerge,
  rollbackPreparedVisualCanonMerge,
} from "../src/visual-canon/profiles.js";
import * as profilesModule from "../src/visual-canon/profiles.js";
import * as canonicalModule from "../src/story-bible/canonical.js";
import * as granularityModule from "../src/story-bible/granularity.js";
import { ReconciliationError } from "../src/pipeline/errors.js";
import { readActivity } from "../src/studio/projects.js";
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

  // Scenario M: Visual Canon commit failure with failed Story Bible rollback throws structured ReconciliationError
  it("Scenario M: Visual Canon commit failure with failed Story Bible rollback throws structured ReconciliationError", async () => {
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
        reason: "Testing double failure",
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
    expect((recErr.rollbackError as Error)?.message).toBe("Undo canonical merge disk error");
    expect(recErr.message).toContain("rollback could not fully restore the previous state");
  });

  // Scenario M2: Visual Canon demote failure with failed restore throws structured ReconciliationError
  it("Scenario M2: Demote failure with failed restore throws structured ReconciliationError", async () => {
    const operations = new StudioOperations(tempDir, loadEnvironment({}));

    await updateVisualProfile(tempDir, slug, idTarget, { appearance: "Target Appearance" });

    const commitSpy = vi.spyOn(profilesModule, "commitVisualCanonDemote").mockRejectedValueOnce(
      new Error("Visual Canon demote write failed")
    );
    const restoreSpy = vi.spyOn(granularityModule, "restorePreDemoteStoryBible").mockRejectedValueOnce(
      new Error("Disk restore error")
    );

    let caughtError: any;
    try {
      await operations.demoteCanonicalEntity(slug, idTarget, {
        reason: "Testing demotion double failure",
      });
    } catch (err) {
      caughtError = err;
    } finally {
      commitSpy.mockRestore();
      restoreSpy.mockRestore();
    }

    expect(caughtError).toBeInstanceOf(ReconciliationError);
    const recErr = caughtError as ReconciliationError;
    expect(recErr.storySlug).toBe(slug);
    expect(recErr.targetEntityId).toBe(idTarget);
    expect(recErr.failedPhase).toBe("visual_canon_demote_rollback");
    expect((recErr.rollbackError as Error)?.message).toBe("Disk restore error");
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
});
