import { expect, it } from "vitest";
import { characterFigureTrait, referenceFigureRequirement } from "../src/visual-canon/figure-guidance.js";
it("shares selected figure settings and resolves build conflicts in reference requirements", () => {
  const character = { gender: "female", apparentAge: "29", figure: "larger" as const, build: "Compact, lean and athletic" };
  expect(characterFigureTrait(character, true)).toContain("DD cup or E cup");
  expect(referenceFigureRequirement(character, true)).toContain("clothed front, three-quarter, side and back");
  expect(referenceFigureRequirement(character, true)).toContain("preserve its face/hair");
  expect(characterFigureTrait({ ...character, figure: "normal" }, true)).toContain("D cup");
});
it("excludes minors, disabled mature styling, males and smaller figure settings", () => {
  const character = { gender: "female", apparentAge: "29", figure: "larger" as const };
  expect(characterFigureTrait(character, false)).toBeUndefined();
  for (const apparentAge of ["16", "16 years old", "17-year-old", "about 16", "teenager", "child"]) expect(referenceFigureRequirement({ ...character, apparentAge }, true)).toBeUndefined();
  expect(characterFigureTrait({ ...character, gender: "male" }, true)).toBeUndefined();
  expect(characterFigureTrait({ ...character, figure: "smaller" }, true)).toBeUndefined();
  expect(characterFigureTrait({ ...character, apparentAge: undefined }, true)).toContain("Figure:");
});

it("applies the displayed normal default to saved female profiles without a figure selection", () => {
  const character = { gender: "female", apparentAge: "20", build: "Petite, compact build." };
  expect(characterFigureTrait(character, true)).toBe(characterFigureTrait({ ...character, figure: "normal" }, true));
  expect(referenceFigureRequirement(character, true)).toContain("REQUIRED EDITORIAL FIGURE — normal:");
  expect(referenceFigureRequirement(character, true)).toContain("D cup");
  expect(referenceFigureRequirement({ ...character, figure: "smaller" }, true)).toBeUndefined();
  expect(referenceFigureRequirement({ ...character, apparentAge: "16" }, true)).toBeUndefined();
  expect(referenceFigureRequirement(character, false)).toBeUndefined();
});
