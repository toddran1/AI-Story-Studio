import { describe, expect, it } from "vitest";
import { normalizeCharacterAppearance, isConditionalVisualObservation } from "../src/visual-canon/appearance-policy.js";
import { resolveVisualContinuity, renderSceneContinuity } from "../src/visual-canon/continuity.js";

describe("narrative appearance", () => {
  it("separates activation rules from baseline without inventing an eye color", () => {
    const character = { eyeColor: "Black and red when activating her skill", hairColor: "Blonde" };
    const normalized = normalizeCharacterAppearance(character);
    expect(normalized?.eyeColor).toBeUndefined();
    expect(normalized?.conditionalAppearance).toContain(character.eyeColor);
    expect(normalized?.hairColor).toBe("Blonde");
    expect(character.eyeColor).toContain("Black");
    expect(normalizeCharacterAppearance({ eyeColor: "Brown" })?.eyeColor).toBe("Brown");
  });

  it("recognizes old activated observations from their source excerpt", () => {
    expect(isConditionalVisualObservation({ field: "character.eyeColor", value: "black and red", provenance: [{ excerpt: "When activating her skill, her eyes turned black and red." }] })).toBe(true);
    expect(isConditionalVisualObservation({ field: "character.eyeColor", value: "normally brown", excerpt: "When activating her skill, her eyes turned red." })).toBe(false);
  });

  it("carries outfits while clearing activated features and visible weapons", () => {
    const result = resolveVisualContinuity({ scenes: [
      { id: "a", visualChanges: { characters: [{ name: "Lucine", op: "enter", set: { wardrobe: "blue dress", activeAbilities: ["red eyes"], visibleEquipment: ["drawn sword"] } }] } },
      { id: "b", visualChanges: { characters: [{ name: "Lucine", op: "update", clear: ["activeAbilities", "visibleEquipment"] }] } },
    ] });
    const frame = result.perScene[1]!;
    expect(frame.endState.characters[0]?.wardrobe).toBe("blue dress");
    expect(frame.endState.characters[0]?.activeAbilities).toBeUndefined();
    expect(renderSceneContinuity(frame)).not.toContain("red eyes");
    expect(renderSceneContinuity(frame)).not.toContain("drawn sword");
    expect(renderSceneContinuity(frame)).toContain("explicitly cleared");
  });

  it("does not carry future wardrobe into a historical beat", () => {
    const result = resolveVisualContinuity({ scenes: [
      { id: "later", appearanceChapter: 20, visualChanges: { characters: [{ name: "Lucine", op: "enter", set: { wardrobe: "future armor" } }] } },
      { id: "earlier", appearanceChapter: 3 },
    ] });
    expect(result.perScene[1]!.endState.characters).toEqual([]);
  });
});
