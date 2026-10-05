import { describe, expect, it } from "vitest";
import { resolveVisualCanonPrompt } from "../src/visual-canon/resolver.js";
import { createDefaultArtDirection } from "../src/domain/art-direction.js";
import { canonicalEntitySchema, emptyStoryBible } from "../src/domain/story-bible.js";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { sceneSchema } from "../src/scenes/types.js";
import { testStory } from "./helpers.js";
const id = "ent_111111111111111111111111";
function resolve(adultContent: boolean, named = false, editorial = false) {
  const story = testStory(); story.artwork.adultContent = adultContent;
  const bible = emptyStoryBible();
  if (named) bible.canonicalEntities.push(canonicalEntitySchema.parse({ id, type: "character", canonicalName: "Mara", description: "An adult woman with a slim build and waist-length braided hair", firstAppearance: 1, lastKnownAppearance: 1 }));
  const scene = sceneSchema.parse({ id: "scene-001", startSeconds: 0, endSeconds: 10, summary: "Adults at a market", visualPrompt: "A crowd of adult men and women at a market", characters: named ? ["Mara"] : [] });
  return resolveVisualCanonPrompt({ scene, story, bible, visualProfiles: editorial ? { [id]: visualProfileSchema.parse({ id: "mara", entityId: id, visualType: "character", status: "draft", character: { figure: "smaller" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) } : {}, artDirection: createDefaultArtDirection("illustration").presets[0]!, chapter: 1 });
}
describe("generic and fallback character design", () => {
  it("includes face and hair variety for unnamed crowds without requiring profiles", () => {
    const result = resolve(false);
    expect(result.prompt).toContain("GENERIC AND FALLBACK CHARACTER VARIETY");
    expect(result.prompt).toContain("unnamed people and background crowds");
    expect(result.prompt).toContain("jaw/chin"); expect(result.prompt).toContain("hair length, texture");
    expect(result.prompt).not.toContain("DD/E-cup");
  });
  it("gates mature fallback styling on book settings and clearly adult, unspecified figures", () => {
    const result = resolve(true);
    expect(result.prompt).toContain("ADULT FEMALE FALLBACK FIGURE");
    expect(result.prompt).toContain("curvaceous with a full bust, hips, and big round butt");
    expect(result.prompt).toContain("DD/E-cup");
    expect(result.prompt).toContain("depict her as an adult aged 21 or older");
    expect(result.prompt).toContain("Explicit ages and youth cues always override the default");
    expect(result.prompt).toContain("Never apply mature body styling to minors");
    expect(result.prompt).toContain("Preserve any established figure, manual figure choice or source-backed build");
  });
  it("keeps an editorial figure choice in fallback prompts", () => {
    expect(resolve(true, true, true).prompt).toContain("EDITORIAL BODY CHOICE: smaller");
  });
  it("retains named fallback facts and fingerprints the mature-setting change", () => {
    const result = resolve(true, true);
    expect(result.resolvedEntities[0]?.groundingMode).toBe("story_bible_fallback");
    expect(result.prompt).toContain("slim build and waist-length braided hair");
    expect(result.resolvedPromptFingerprint).not.toBe(resolve(false, true).resolvedPromptFingerprint);
  });
});
