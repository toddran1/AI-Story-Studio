import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadVisualProfiles,
  saveVisualProfiles,
  getVisualProfile,
  updateVisualProfile,
  canApproveVisualProfile,
  deleteVisualProfile,
  deleteVisualReferenceImage,
  addVisualReferenceImage,
  generateStyleSheet,
  approveVisualReference,
  handleEntityMerge,
  handleEntityDemote,
} from "../src/visual-canon/profiles.js";
import { applyVisualProfileProposal, inspectVisualProfile, proposeMissingVisualDetails, resolveVisualProfileConflict } from "../src/visual-canon/completion.js";
import {
  applyVisualProfileProposal,
  inspectVisualProfile,
  proposeMissingVisualDetails,
  resolveVisualProfileConflict,
  visualProfileProposalResponseSchema,
} from "../src/visual-canon/completion.js";
import { toOpenAiTextFormat } from "../src/llm/openai/openai.provider.js";
import { geminiJsonSchema } from "../src/llm/gemini/gemini.provider.js";
import { VisualEntityProfile } from "../src/domain/visual-profile.js";
import { storyPaths } from "../src/storage/paths.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { emptyStoryBible, canonicalEntitySchema } from "../src/domain/story-bible.js";

describe("Visual Entity Profiles", () => {
  let root: string;
  const slug = "test-story";
  const entityId = "ent_0123456789abcdef01234567";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "visual-profile-test-"));
    // Ensure story directory exists
    await atomicWriteJson(storyPaths(root, slug, 1).storyConfig, { slug, title: "Test Story" });
    const testBible = {
      ...emptyStoryBible(),
      canonicalEntities: [
        canonicalEntitySchema.parse({
          id: entityId,
          type: "character",
          canonicalName: "Test Character",
          aliases: [],
          description: "Test description",
          firstAppearance: 1,
          lastKnownAppearance: 1,
        }),
        canonicalEntitySchema.parse({ id: "ent_cccccccccccccccccccccccc", type: "location", canonicalName: "Necromancer Guild", aliases: [], description: "An ancient guild hall", firstAppearance: 1, lastKnownAppearance: 1 }),
        canonicalEntitySchema.parse({
          id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa",
          type: "character",
          canonicalName: "Target Hero",
          aliases: [],
          description: "Target description",
          firstAppearance: 1,
          lastKnownAppearance: 1,
        }),
        canonicalEntitySchema.parse({
          id: "ent_bbbbbbbbbbbbbbbbbbbbbbbb",
          type: "character",
          canonicalName: "Source Hero",
          aliases: [],
          description: "Source description",
          firstAppearance: 1,
          lastKnownAppearance: 1,
        }),
      ],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, testBible);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("loads empty profiles if visual-profiles.json does not exist", async () => {
    const profiles = await loadVisualProfiles(root, slug);
    expect(profiles).toEqual({});
  });

  it("creates a draft profile when querying a non-existent entity via updateVisualProfile", async () => {
    const nonExistent = await getVisualProfile(root, slug, entityId);
    expect(nonExistent).toBeUndefined();

    const profile = await updateVisualProfile(root, slug, entityId, {});
    expect(profile.entityId).toBe(entityId);
    expect(profile.status).toBe("draft");
    expect(profile.visualType).toBe("character");
    expect(profile.references).toEqual([]);
    expect(profile.revision).toBe(1);
  });

  it("updates and approves a visual profile", async () => {
    const initial = await updateVisualProfile(root, slug, entityId, {});
    expect(initial.status).toBe("draft");

    const updated = await updateVisualProfile(root, slug, entityId, {
      appearance: "A towering figure clad in midnight blue armor.",
      visualPrompt: "towering dark knight, midnight blue armor, glowing cyan visor",
      status: "approved",
      character: {
        apparentAge: "30s",
        hairColor: "silver",
        eyeColor: "cyan",
        defaultOutfit: "Midnight blue plate armor",
      },
    });

    expect(updated.status).toBe("approved");
    expect(updated.approvedAt).toBeDefined();
    expect(updated.character?.hairColor).toBe("silver");
    expect(updated.appearance).toBe("A towering figure clad in midnight blue armor.");
    expect(updated.revision).toBe(2);

    const reloaded = await getVisualProfile(root, slug, entityId);
    expect(reloaded).toBeDefined();
    expect(reloaded?.status).toBe("approved");
    expect(reloaded?.visualPrompt).toContain("towering dark knight");
  });

  it("approves partial profiles, preserves omissions and approval through edits, and permits returning to draft", async () => {
    const character = { apparentAge: "20s", gender: "male", height: "5'11\"", build: "lean", hairColor: "black", hairstyle: "short", eyeColor: "gray", defaultOutfit: "varsity jacket" };
    await updateVisualProfile(root, slug, entityId, { character });
    const approved = await updateVisualProfile(root, slug, entityId, { status: "approved" });
    expect(approved).toMatchObject({ status: "approved", character });
    expect(approved.approvedAt).toBeDefined();
    for (const key of ["skinTone", "faceShape", "scars", "tattoos", "accessories"]) expect(approved.character?.[key as keyof typeof approved.character]).toBeUndefined();
    const edited = await updateVisualProfile(root, slug, entityId, { character: { ...character, hairstyle: "long" } });
    expect(edited.status).toBe("approved");
    expect(edited.approvedAt).toBe(approved.approvedAt);
    expect(edited.revision).toBe(approved.revision + 1);
    const draft = await updateVisualProfile(root, slug, entityId, { status: "draft" });
    expect(draft.approvedAt).toBeUndefined();
  });

  it("requires only one meaningful visual identity source across entity types", async () => {
    const empty = await updateVisualProfile(root, slug, entityId, {});
    expect(canApproveVisualProfile(empty)).toBe(false);
    await expect(updateVisualProfile(root, slug, entityId, { status: "approved" })).rejects.toThrow("persistent visual detail");
    const locationId = "ent_cccccccccccccccccccccccc";
    const location = await updateVisualProfile(root, slug, locationId, { visualType: "location", location: { architecture: "brass dome", atmosphere: "hushed", colorPalette: "amber" }, status: "approved" });
    expect(location.status).toBe("approved");
    expect(location.approvedAt).toBeDefined();
  });

  it("allows an otherwise empty profile with an approved visual reference", async () => {
    await addVisualReferenceImage(root, slug, entityId, {
      role: "primary_reference", source: "uploaded", buffer: Buffer.from("reference"), approved: true,
    });
    const approved = await updateVisualProfile(root, slug, entityId, { status: "approved" });
    expect(approved.status).toBe("approved");
    expect(approved.appearance).toBe("");
    expect(approved.character).toEqual({});
  });

  it("adds and stores visual reference images", async () => {
    const pngBuffer = Buffer.from("fake-png-content");
    const { reference: ref } = await addVisualReferenceImage(root, slug, entityId, {
      role: "front",
      source: "uploaded",
      buffer: pngBuffer,
      approved: true,
      prompt: "front view portrait",
    });

    expect(ref.entityId).toBe(entityId);
    expect(ref.role).toBe("front");
    expect(ref.approved).toBe(true);
    expect(ref.imagePath).toContain(entityId);

    const profile = await getVisualProfile(root, slug, entityId);
    expect(profile?.references).toHaveLength(1);
    expect(profile?.references[0]?.id).toBe(ref.id);
  });

  it("generates a multi-view style sheet and attaches it to references", async () => {
    await updateVisualProfile(root, slug, entityId, {
      visualPrompt: "young sorcerer with raven hair and gold spectacles",
      appearance: "A lean young sorcerer with a composed expression.",
      character: {
        apparentAge: "18 years old", gender: "male", height: "5'11\"", build: "lean athletic",
        skinTone: "warm olive", faceShape: "angular", eyeColor: "smoky gray with a cold teal ring",
        hairColor: "ink-black with ash-gray tips", hairstyle: "short swept-back undercut", facialHair: "none",
        distinguishingFeatures: "a small mole beneath the left eye", scars: "a thin permanent scar on the right eyebrow",
        tattoos: "black warding sigil on the left forearm", defaultOutfit: "dark academy jacket and fitted trousers",
        shoes: "black leather combat boots", accessories: "gold spectacles and silver signet ring",
        weapons: "ebony necromancer staff", equipment: "etched bone talisman", additionalAppearanceNotes: "Always carries himself with precise posture.",
      },
    });

    let prompt = "";
    const fakeProvider = {
      name: "fake-image-provider",
      validateConfiguration: async () => {},
      generate: async (input: { prompt: string }) => {
        prompt = input.prompt;
        return ({
        data: Buffer.from("fake-style-sheet-bytes"),
        mimeType: "image/png",
        provider: "fake",
        model: "fake-v1",
        });
      },
    };

    const fakeStory: any = {
      slug,
      artwork: {
        provider: "openai",
        model: "dall-e-3",
        stylePrompt: "Cinematic anime style",
        quality: "high",
        size: "1024x1024",
        outputFormat: "png",
      },
    };

    const result = await generateStyleSheet(root, slug, entityId, fakeProvider as any, fakeStory);
    expect(result.reference.imagePath).toContain(entityId);
    expect(result.profile.references.some((r) => r.source === "style_sheet")).toBe(true);
    expect(result.reference.approved).toBe(false);
    expect(prompt).toContain("full-body front");
    expect(prompt).toContain("full-body three-quarter");
    expect(prompt).toContain("full-body side/profile");
    expect(prompt).toContain("full-body back");
    expect(prompt).toContain("head/face front");
    expect(prompt).toContain("IDENTITY CONSISTENCY");
    expect(prompt).toContain("cropped feet");
    expect(prompt).toContain("overlapping figures");
    expect(prompt).toContain("cinematic backgrounds");
    expect(prompt).toContain("HEIGHT: 5'11\"");
    expect(prompt).toContain("SKIN TONE: warm olive");
    expect(prompt).toContain("EYES: smoky gray with a cold teal ring");
    expect(prompt).toContain("HAIR: ink-black with ash-gray tips, short swept-back undercut");
    expect(prompt).toContain("SCARS / PERMANENT MARKS: a thin permanent scar on the right eyebrow");
    expect(prompt).toContain("TATTOOS: black warding sigil on the left forearm");
    expect(prompt).toContain("FOOTWEAR: black leather combat boots");
    expect(prompt).toContain("ACCESSORIES: gold spectacles and silver signet ring");
    expect(prompt).toContain("PERSISTENT EQUIPMENT: etched bone talisman");
    expect(prompt).toContain("DEFAULT COSTUME / WARDROBE: dark academy jacket and fitted trousers");
  });

  it("proposes only missing visual details and persists only selected acceptance", async () => {
    const bible = {
      ...emptyStoryBible(),
      canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "A necromancer with silver hair and blue eyes.", firstAppearance: 1, lastKnownAppearance: 1 })],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    await updateVisualProfile(root, slug, entityId, { character: { hairColor: "silver", eyeColor: "blue" } });
    let calls = 0;
    const provider = { name: "fake", validateConfiguration: async () => {}, generateText: async () => ({ text: "" }), generateStructured: async () => { calls++; return { value: { values: { "character.build": "lean athletic", "character.faceShape": "angular with a narrow jaw", "character.hairColor": "black" }, rationale: "Role-informed design" } }; } };
    const provider = {
      name: "fake",
      validateConfiguration: async () => {},
      generateText: async () => ({ text: "" }),
      generateStructured: async () => {
        calls++;
        return {
          value: {
            values: [
              { field: "character.build", value: "lean athletic" },
              { field: "character.faceShape", value: "angular with a narrow jaw" },
              { field: "character.hairColor", value: "black" },
            ],
            rationale: "Role-informed design",
          },
        };
      },
    };
    const proposal = await proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "fake" });
    expect(calls).toBe(1);
    expect(proposal.values).toMatchObject({ "character.build": "lean athletic", "character.faceShape": "angular with a narrow jaw" });
    expect(proposal.values["character.hairColor"]).toBeUndefined();
    expect((await getVisualProfile(root, slug, entityId))?.character?.build).toBeUndefined();
    const updated = await applyVisualProfileProposal(root, slug, bible, proposal, ["character.build"]);
    expect(updated.character?.build).toBe("lean athletic");
    expect(updated.character?.hairColor).toBe("silver");
    expect(updated.fieldProvenance?.["character.build"]?.source).toBe("ai_generated");
  });

  it("protects explicit canonical facts and locked manual visual fields", async () => {
    const bible = {
      ...emptyStoryBible(),
      canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "Hair: white. Eyes: violet.", firstAppearance: 1, lastKnownAppearance: 1 })],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    await updateVisualProfile(root, slug, entityId, { character: { eyeColor: "violet" }, fieldProvenance: { "character.eyeColor": { source: "user_edit", locked: true } } });
    const inspection = await inspectVisualProfile(root, slug, bible, entityId);
    expect(inspection.protectedFields).toContain("character.hairColor");
    expect(inspection.protectedFields).toContain("character.eyeColor");
    const provider = { name: "fake", generateStructured: async () => ({ value: { values: { "character.hairColor": "black", "character.eyeColor": "red", "character.build": "lean" }, rationale: "" } }) };
    const provider = {
      name: "fake",
      generateStructured: async () => ({
        value: {
          values: [
            { field: "character.hairColor", value: "black" },
            { field: "character.eyeColor", value: "red" },
            { field: "character.build", value: "lean" },
          ],
          rationale: "",
        },
      }),
    };
    const proposal = await proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "fake" }, { regenerate: true, fields: ["character.hairColor", "character.eyeColor", "character.build"] });
    expect(proposal.values).toEqual({ "character.build": "lean" });
  });

  it("keeps generated references in review until explicitly approved as primary", async () => {
    await updateVisualProfile(root, slug, entityId, { visualPrompt: "distinct necromancer" });
    const provider = { name: "fake-image-provider", validateConfiguration: async () => {}, generate: async () => ({ data: Buffer.from("image"), mimeType: "image/png", provider: "fake", model: "fake" }) };
    const story: any = { slug, artwork: { provider: "openai", model: "dall-e-3", aspectRatio: "1:1", quality: "high", size: "1024x1024", outputFormat: "png" } };
    const created = await generateStyleSheet(root, slug, entityId, provider as any, story);
    expect(created.reference.approved).toBe(false);
    const approved = await approveVisualReference(root, slug, entityId, created.reference.id, true);
    expect(approved.references.find((item) => item.id === created.reference.id)).toMatchObject({ approved: true, role: "primary_reference" });
  });

  it("retains primary reference lineage when a replacement is generated", async () => {
    await updateVisualProfile(root, slug, entityId, { visualPrompt: "distinct necromancer" });
    const provider = { name: "fake-image-provider", validateConfiguration: async () => {}, generate: async () => ({ data: Buffer.from("image"), mimeType: "image/png", provider: "fake", model: "fake" }) };
    const story: any = { slug, artwork: { provider: "openai", model: "dall-e-3", aspectRatio: "1:1", quality: "high", size: "1024x1024", outputFormat: "png" } };
    const v1 = await generateStyleSheet(root, slug, entityId, provider as any, story);
    await approveVisualReference(root, slug, entityId, v1.reference.id, true);
    const v2 = await generateStyleSheet(root, slug, entityId, provider as any, story);
    expect(v2.reference.replacesReferenceId).toBe(v1.reference.id);
    const promoted = await approveVisualReference(root, slug, entityId, v2.reference.id, true);
    expect(promoted.references.find((item) => item.id === v2.reference.id)?.role).toBe("primary_reference");
    expect(promoted.references.find((item) => item.id === v1.reference.id)).toMatchObject({ approved: true, role: "general_reference" });
  });

  it("deletes a reference and its controlled asset without promoting a descendant", async () => {
    const unapproved = await addVisualReferenceImage(root, slug, entityId, {
      role: "general_reference", source: "uploaded", buffer: Buffer.from("review-image"), approved: false,
    });
    const removedReviewReference = await deleteVisualReferenceImage(root, slug, entityId, unapproved.reference.id);
    expect(removedReviewReference.deleted).toBe(true);
    expect(removedReviewReference.profile.references).toEqual([]);
    await expect(access(unapproved.reference.imagePath)).rejects.toThrow();

    const first = await addVisualReferenceImage(root, slug, entityId, {
      role: "primary_reference", source: "uploaded", buffer: Buffer.from("primary-image"), approved: true,
    });
    const descendant = await addVisualReferenceImage(root, slug, entityId, {
      role: "front", source: "uploaded", buffer: Buffer.from("newer-image"), approved: true,
      replacesReferenceId: first.reference.id,
    });

    const deleted = await deleteVisualReferenceImage(root, slug, entityId, first.reference.id);
    expect(deleted.deleted).toBe(true);
    expect(deleted.profile.references).toHaveLength(1);
    expect(deleted.profile.references[0]).toMatchObject({ id: descendant.reference.id, replacesReferenceId: first.reference.id, role: "front" });
    expect(deleted.profile.references.some((reference) => reference.role === "primary_reference")).toBe(false);
    await expect(access(first.reference.imagePath)).rejects.toThrow();
    await expect(access(descendant.reference.imagePath)).resolves.toBeUndefined();
    expect((await deleteVisualReferenceImage(root, slug, entityId, first.reference.id)).deleted).toBe(false);
  });

  it("preserves an AI suggestion beside new source evidence until deliberately resolved", async () => {
    const bible = { ...emptyStoryBible(), canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "Hair: emerald green.", firstAppearance: 1, lastKnownAppearance: 1 })] };
    await updateVisualProfile(root, slug, entityId, { character: { hairColor: "brown" }, fieldProvenance: { "character.hairColor": { source: "ai_generated", locked: false } } });
    const inspection = await inspectVisualProfile(root, slug, bible, entityId);
    expect(inspection.conflicts).toHaveLength(1);
    expect(inspection.conflicts[0]).toMatchObject({ field: "character.hairColor", visualValue: "brown", status: "needs_review" });
    const resolved = await resolveVisualProfileConflict(root, slug, bible, entityId, inspection.conflicts[0]!.id, "accept_canonical");
    expect(resolved.character?.hairColor).toBe("emerald");
    expect(resolved.conflicts?.[0]).toMatchObject({ status: "resolved", resolution: "accept_canonical" });
    const repeated = await inspectVisualProfile(root, slug, bible, entityId);
    expect(repeated.conflicts.filter((item) => item.status === "needs_review")).toEqual([]);
    expect(repeated.conflicts).toHaveLength(1);
  });

  it("keeps a retained manual override resolved across repeated inspections", async () => {
    const bible = { ...emptyStoryBible(), canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "Hair Color: silver.", firstAppearance: 1, lastKnownAppearance: 1 })] };
    await updateVisualProfile(root, slug, entityId, { character: { hairColor: "brown" }, fieldProvenance: { "character.hairColor": { source: "ai_generated", locked: false } } });
    const conflict = (await inspectVisualProfile(root, slug, bible, entityId)).conflicts[0]!;
    await resolveVisualProfileConflict(root, slug, bible, entityId, conflict.id, "retain_manual_override");
    const firstRepeat = await inspectVisualProfile(root, slug, bible, entityId);
    const secondRepeat = await inspectVisualProfile(root, slug, bible, entityId);
    expect(firstRepeat.conflicts).toMatchObject([{ id: conflict.id, status: "resolved", resolution: "retain_manual_override" }]);
    expect(secondRepeat.conflicts.filter((item) => item.status === "needs_review")).toEqual([]);
  });

  it("finds later visual evidence without promoting temporary prose to canon", async () => {
    const bible = { ...emptyStoryBible(), canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: ["Tester"], description: "", firstAppearance: 1, lastKnownAppearance: 1, provenance: [{ chapter: 1, kind: "extraction" }] })] };
    await atomicWrite(storyPaths(root, slug, 1).english, `Test Character entered the room. ${"The corridor was quiet. ".repeat(70)}The guards put a battered suit of armor beside him. Much later, Tester looked up, his pale silver eyes glowed beneath his long black hair.`);
    const inspection = await inspectVisualProfile(root, slug, bible, entityId);
    const evidence = inspection.context.sourceEvidence as Array<{ text: string; visualSignalScore: number }>;
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.some((item) => item.text.includes("pale silver eyes"))).toBe(true);
    expect(evidence.length).toBeLessThanOrEqual(8);
    expect(inspection.protectedFields).not.toContain("character.defaultOutfit");
    expect(inspection.protectedFields).not.toContain("character.weapons");
  });

  it("uses only entity-relevant summaries and requires explicit regeneration fields", async () => {
    const bible = { ...emptyStoryBible(), chapterSummaries: { 1: "Test Character protects the guild.", 2: "An unrelated battle in another empire." }, canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "", firstAppearance: 1, lastKnownAppearance: 2 })] };
    const inspection = await inspectVisualProfile(root, slug, bible, entityId);
    expect((inspection.context.relevantStorySummaries as Array<{ chapter: number }>).map((item) => item.chapter)).toEqual([1]);
    const provider = { name: "fake", generateStructured: async () => ({ value: { values: {}, rationale: "" } }) };
    await expect(proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "fake" }, { regenerate: true })).rejects.toThrow("Choose one or more");
  });

  it("uses a persistent environment reference prompt for locations", async () => {
    const locationId = "ent_cccccccccccccccccccccccc";
    await updateVisualProfile(root, slug, locationId, { visualType: "location", character: { height: "9 feet", eyeColor: "red" }, location: { architecture: "black stone spires", recurringLandmarks: "a bone gate" } });
    let prompt = "";
    const provider = { name: "fake-image-provider", validateConfiguration: async () => {}, generate: async (input: { prompt: string }) => { prompt = input.prompt; return { data: Buffer.from("image"), mimeType: "image/png", provider: "fake", model: "fake" }; } };
    const story: any = { slug, artwork: { provider: "openai", model: "dall-e-3", aspectRatio: "1:1", quality: "high", size: "1024x1024", outputFormat: "png" } };
    const result = await generateStyleSheet(root, slug, locationId, provider as any, story);
    expect(result.reference.approved).toBe(false);
    expect(prompt).toContain("LOCATION REFERENCE");
    expect(prompt).not.toContain("CHARACTER MODEL SHEET");
    expect(prompt).not.toContain("HEIGHT: 9 feet");
    expect(prompt).not.toContain("EYES: red");
  });

  it("merges visual profiles when entities are merged", async () => {
    const targetId = "ent_aaaaaaaaaaaaaaaaaaaaaaaa";
    const sourceId = "ent_bbbbbbbbbbbbbbbbbbbbbbbb";

    await updateVisualProfile(root, slug, targetId, {
      appearance: "Main Hero appearance",
      visualPrompt: "hero prompt",
      status: "approved",
    });
    await updateVisualProfile(root, slug, sourceId, {
      appearance: "Alias appearance notes",
      notes: "Secondary info from alias",
      negativePrompt: "low quality",
    });

    await handleEntityMerge(root, slug, targetId, [sourceId]);

    const targetProfile = await getVisualProfile(root, slug, targetId);
    expect(targetProfile?.notes).toContain("Secondary info from alias");
    expect(targetProfile?.negativePrompt).toContain("low quality");

    const allProfiles = await loadVisualProfiles(root, slug);
    expect(sourceId in allProfiles).toBe(false);
  });

  it("demotes an approved profile to draft when demoted in Story Bible", async () => {
    await updateVisualProfile(root, slug, entityId, {
      status: "approved",
      appearance: "Canon creature description",
    });

    await handleEntityDemote(root, slug, entityId);

    const profile = await getVisualProfile(root, slug, entityId);
    expect(profile?.status).toBe("draft");
  });

  it("deletes a visual profile", async () => {
    await updateVisualProfile(root, slug, entityId, { appearance: "To be deleted" });
    const deleted = await deleteVisualProfile(root, slug, entityId);
    expect(deleted).toBe(true);

    const profiles = await loadVisualProfiles(root, slug);
    expect(entityId in profiles).toBe(false);
  });

  it("converts visualProfileProposalResponseSchema to OpenAI text format without propertyNames", () => {
    const formatted = toOpenAiTextFormat(visualProfileProposalResponseSchema, "visual_profile_completion");
    expect(formatted).toBeDefined();
    const serialized = JSON.stringify(formatted);
    expect(serialized).not.toContain("propertyNames");
    expect((formatted as any).name).toBe("visual_profile_completion");
    expect((formatted as any).strict).toBe(true);
    expect((formatted as any).schema.additionalProperties).toBe(false);
  });

  it("proposes missing visual details converting array response into dictionary", async () => {
    const bible = {
      ...emptyStoryBible(),
      canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "", firstAppearance: 1, lastKnownAppearance: 1 })],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    const provider = {
      name: "test-provider",
      validateConfiguration: async () => {},
      generateText: async () => ({ text: "" }),
      generateStructured: async () => ({
        value: {
          values: [
            { field: "character.skinTone", value: "pale" },
            { field: "character.hairColor", value: "silver" },
          ],
          rationale: "Character aesthetic proposal",
        },
      }),
    };
    const proposal = await proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "test-model" });
    expect(proposal.values).toEqual({
      "character.skinTone": "pale",
      "character.hairColor": "silver",
    });
    expect(proposal.rationale).toBe("Character aesthetic proposal");
    expect(proposal.provider).toBe("test-provider");
    expect(proposal.model).toBe("test-model");
  });

  it("drops unrequested and ineligible fields returned by the model", async () => {
    const bible = {
      ...emptyStoryBible(),
      canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "", firstAppearance: 1, lastKnownAppearance: 1 })],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    const provider = {
      name: "test-provider",
      validateConfiguration: async () => {},
      generateStructured: async () => ({
        value: {
          values: [
            { field: "character.skinTone", value: "pale" },
            { field: "character.nonexistentField", value: "invalid" },
            { field: "location.terrain", value: "mountains" },
            { field: "unrequested.extra", value: "extra" },
          ],
          rationale: "",
        },
      }),
    };
    const proposal = await proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "test-model" }, { fields: ["character.skinTone"] });
    expect(proposal.values).toEqual({ "character.skinTone": "pale" });
    expect(proposal.values["character.nonexistentField"]).toBeUndefined();
    expect(proposal.values["location.terrain"]).toBeUndefined();
    expect(proposal.values["unrequested.extra"]).toBeUndefined();
  });

  it("resolves duplicate fields in LLM response with first-valid-wins rule", async () => {
    const bible = {
      ...emptyStoryBible(),
      canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "", firstAppearance: 1, lastKnownAppearance: 1 })],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    const provider = {
      name: "test-provider",
      validateConfiguration: async () => {},
      generateStructured: async () => ({
        value: {
          values: [
            { field: "character.build", value: "athletic" },
            { field: "character.build", value: "slender" },
            { field: "character.skinTone", value: "tan" },
            { field: "character.skinTone", value: "pale" },
          ],
          rationale: "",
        },
      }),
    };
    const proposal = await proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "test-model" });
    expect(proposal.values["character.build"]).toBe("athletic");
    expect(proposal.values["character.skinTone"]).toBe("tan");
  });

  it("handles empty proposal array gracefully without crashing", async () => {
    const bible = {
      ...emptyStoryBible(),
      canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "", firstAppearance: 1, lastKnownAppearance: 1 })],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    const provider = {
      name: "test-provider",
      validateConfiguration: async () => {},
      generateStructured: async () => ({
        value: {
          values: [],
          rationale: "Nothing missing to propose",
        },
      }),
    };
    const proposal = await proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "test-model" });
    expect(proposal.values).toEqual({});
    expect(proposal.rationale).toBe("Nothing missing to propose");
  });

  it("prevents proposing or applying protected canonical fields", async () => {
    const bible = {
      ...emptyStoryBible(),
      canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "Skin Tone: bronze.", firstAppearance: 1, lastKnownAppearance: 1 })],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    await updateVisualProfile(root, slug, entityId, { character: { eyeColor: "amber" }, fieldProvenance: { "character.eyeColor": { source: "manual_override", locked: true } } });
    const inspection = await inspectVisualProfile(root, slug, bible, entityId);
    expect(inspection.protectedFields).toContain("character.skinTone");
    expect(inspection.protectedFields).toContain("character.eyeColor");

    const provider = {
      name: "test-provider",
      validateConfiguration: async () => {},
      generateStructured: async () => ({
        value: {
          values: [
            { field: "character.skinTone", value: "pale" },
            { field: "character.eyeColor", value: "blue" },
            { field: "character.height", value: "tall" },
          ],
          rationale: "",
        },
      }),
    };
    const proposal = await proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "test-model" });
    expect(proposal.values["character.skinTone"]).toBeUndefined();
    expect(proposal.values["character.eyeColor"]).toBeUndefined();
    expect(proposal.values["character.height"]).toBe("tall");

    const updated = await applyVisualProfileProposal(root, slug, bible, proposal, ["character.skinTone", "character.eyeColor", "character.height"]);
    expect(updated.character?.height).toBe("tall");
    expect(updated.character?.eyeColor).toBe("amber");
    expect(updated.character?.skinTone).toBeUndefined();
  });

  it("allows selecting and regenerating existing AI-generated visual fields", async () => {
    const bible = {
      ...emptyStoryBible(),
      canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "", firstAppearance: 1, lastKnownAppearance: 1 })],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    await updateVisualProfile(root, slug, entityId, {
      character: { build: "slender" },
      fieldProvenance: { "character.build": { source: "ai_generated", locked: false } },
    });
    const inspection = await inspectVisualProfile(root, slug, bible, entityId);
    const buildState = inspection.fields.find((f) => f.path === "character.build");
    expect(buildState?.regenerable).toBe(true);

    const provider = {
      name: "test-provider",
      validateConfiguration: async () => {},
      generateStructured: async () => ({
        value: {
          values: [{ field: "character.build", value: "muscular and broad" }],
          rationale: "Regenerated build",
        },
      }),
    };
    const proposal = await proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "test-model" }, { regenerate: true, fields: ["character.build"] });
    expect(proposal.values["character.build"]).toBe("muscular and broad");

    const updated = await applyVisualProfileProposal(root, slug, bible, proposal, ["character.build"]);
    expect(updated.character?.build).toBe("muscular and broad");
    expect(updated.fieldProvenance?.["character.build"]?.source).toBe("ai_generated");
  });

  it("preserves provenance, provider, model, and contextFingerprint upon applying proposal", async () => {
    const bible = {
      ...emptyStoryBible(),
      canonicalEntities: [canonicalEntitySchema.parse({ id: entityId, type: "character", canonicalName: "Test Character", aliases: [], description: "", firstAppearance: 1, lastKnownAppearance: 1 })],
    };
    await atomicWriteJson(storyPaths(root, slug, 1).bible, bible);
    await updateVisualProfile(root, slug, entityId, {});
    const provider = {
      name: "test-provider",
      validateConfiguration: async () => {},
      generateStructured: async () => ({
        value: {
          values: [{ field: "character.hairstyle", value: "braided" }],
          rationale: "Styling proposal",
        },
      }),
    };
    const proposal = await proposeMissingVisualDetails(root, slug, bible, entityId, provider as any, { provider: "openai", model: "gpt-4o" });
    const updated = await applyVisualProfileProposal(root, slug, bible, proposal, ["character.hairstyle"]);
    expect(updated.character?.hairstyle).toBe("braided");
    const prov = updated.fieldProvenance?.["character.hairstyle"];
    expect(prov).toBeDefined();
    expect(prov?.source).toBe("ai_generated");
    expect(prov?.locked).toBe(false);
    expect(prov?.provider).toBe("test-provider");
    expect(prov?.model).toBe("gpt-4o");
    expect(prov?.contextFingerprint).toBe(proposal.contextFingerprint);
  });

  it("validates cleanly with OpenAI, Gemini, and Kimi structured output expectations", () => {
    // 1. OpenAI format
    const openAiFormat = toOpenAiTextFormat(visualProfileProposalResponseSchema, "visual_profile_completion") as any;
    expect(openAiFormat.strict).toBe(true);
    expect(openAiFormat.name).toBe("visual_profile_completion");
    expect(openAiFormat.schema.additionalProperties).toBe(false);
    expect(openAiFormat.schema.required).toContain("values");
    expect(openAiFormat.schema.required).toContain("rationale");
    expect(JSON.stringify(openAiFormat)).not.toContain("propertyNames");

    // 2. Gemini format
    const geminiSchema = geminiJsonSchema(visualProfileProposalResponseSchema) as any;
    expect(geminiSchema.type).toBe("object");
    expect(geminiSchema.properties.values.type).toBe("array");
    expect(geminiSchema.properties.values.items.type).toBe("object");
    expect(geminiSchema.properties.values.items.properties.field.type).toBe("string");
    expect(geminiSchema.properties.values.items.properties.value.type).toBe("string");

    // 3. Kimi / Zod validation of compliant JSON payload
    const wirePayload = {
      values: [
        { field: "character.hairColor", value: "silver" },
        { field: "character.eyeColor", value: "violet" },
      ],
      rationale: "Validated structure",
    };
    const parsed = visualProfileProposalResponseSchema.parse(wirePayload);
    expect(parsed.values).toHaveLength(2);
    expect(parsed.values[0]?.field).toBe("character.hairColor");
    expect(parsed.rationale).toBe("Validated structure");
  });
});
