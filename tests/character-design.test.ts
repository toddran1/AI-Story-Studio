import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalEntitySchema, emptyStoryBible } from "../src/domain/story-bible.js";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { saveVisualProfiles, generateStyleSheet } from "../src/visual-canon/profiles.js";
import { proposeMissingVisualDetails, applyVisualProfileProposal } from "../src/visual-canon/completion.js";
import { characterDesignContext } from "../src/visual-canon/character-design.js";
import { planReferenceBatch } from "../src/visual-canon/reference-batch.js";
import type { LLMProvider } from "../src/llm/provider.js";
import { testStory, pngWithDims } from "./helpers.js";
const id = "ent_111111111111111111111111", otherId = "ent_222222222222222222222222";
const now = new Date().toISOString();
const entity = (id: string, name: string) => canonicalEntitySchema.parse({ id, type: "character", canonicalName: name, firstAppearance: 1, lastKnownAppearance: 1 });
const profile = (entityId: string) => visualProfileSchema.parse({ id: entityId, entityId, visualType: "character", createdAt: now, updatedAt: now });
describe("distinct character designs", () => {
  it("compares cast faces and hairstyles in proposals and sheets while protecting known traits", async () => {
    const root = await mkdtemp(join(tmpdir(), "character-design-"));
    try {
      const story = testStory(); story.artwork.outputResolution = "native";
      const bible = { ...emptyStoryBible(), canonicalEntities: [entity(id,"Haitao"), entity(otherId,"Xiaoming")] };
      const p = profile(id); p.character = { hairColor: "black" }; p.fieldProvenance = { "character.hairColor": { source: "manual_override", locked: true } };
      const other = profile(otherId); other.status = "approved"; other.character = { faceShape: "Narrow oval, small chin", hairstyle: "Short tousled curls, forward fringe" };
      await atomicWriteJson(storyPaths(root, story.slug, 1).bible, bible);
      await saveVisualProfiles(root, story.slug, { [id]: p, [otherId]: other });
      let request: any;
      const llm = { name: "openai", generateStructured: async (input: any) => { request = input; return { value: { values: [{ field: "character.faceShape", value: "Broad rectangular jaw, wide cheekbones, deep-set eyes, straight nose" }, { field: "character.hairstyle", value: "Long straight hair tied low, swept-back crown, exposed forehead" }, { field: "character.hairColor", value: "red" }], rationale: "Distinct silhouette" } }; } } as LLMProvider;
      const proposal = await proposeMissingVisualDetails(root, story.slug, bible, id, llm, story.pipeline.qa);
      expect(request.instructions).toContain("nose bridge/tip"); expect(request.instructions).toContain("short tousled/spiky");
      expect(JSON.parse(request.input).castDesigns[0]).toMatchObject({ name: "Xiaoming", hairStyle: other.character.hairstyle });
      expect(proposal.values["character.hairColor"]).toBeUndefined();
      await applyVisualProfileProposal(root, story.slug, bible, proposal, Object.keys(proposal.values));
      const images = { name: "openai", version: "fake", validateConfiguration: async () => {}, generate: async (input: any) => { request = input; return { data: pngWithDims(1,1), mimeType: "image/png" as const }; } };
      const plan = await planReferenceBatch(root, story, images, { selection: [{ entityId: id, kind: "profile" }] });
      const result = await generateStyleSheet(root, story.slug, id, images, story);
      expect(request.prompt).toContain("Broad rectangular jaw"); expect(request.prompt).toContain("Long straight hair tied low");
      expect(request.prompt).toContain("OTHER CAST DESIGNS"); expect(request.prompt).toContain("Xiaoming");
      expect(result.reference.provenance?.targetFingerprint).toBe(plan.entries[0]?.targetFingerprint);
      expect(result.reference.approved).toBe(false);
      expect((await planReferenceBatch(root, story, images, { selection: [{ entityId: id, kind: "profile" }] })).imageCount).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("bounds comparison context and excludes the current character", () => {
    const bible = emptyStoryBible(); const profiles: Record<string, ReturnType<typeof profile>> = {};
    for (let i = 1; i < 40; i++) { const key = `ent_${i.toString(16).padStart(24,"0")}`; bible.canonicalEntities.push(entity(key,`Cast ${i}`)); profiles[key] = profile(key); profiles[key]!.character = { hairstyle: "x".repeat(1000) }; }
    const current = bible.canonicalEntities[0]!.id;
    const context = characterDesignContext(bible, profiles, current);
    expect(context).toHaveLength(24); expect(context.some(item => item.entityId === current)).toBe(false);
    expect(context.every(item => item.hairStyle!.length === 600)).toBe(true);
  });
});
