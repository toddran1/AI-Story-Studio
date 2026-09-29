import { describe, expect, it } from "vitest";
import { normalizeVisualProposalValue } from "../src/visual-canon/fields.js";

describe("restricted Visual Profile proposals", () => {
  it("accepts whole-year ages and rejects descriptions, ranges, and decimals", () => {
    expect(normalizeVisualProposalValue("character.apparentAge", " 028 ")).toBe("28");
    for (const value of ["late twenties", "28 years old", "20-30", "28.5", "-1", "", "999999999999999999999"]) {
      expect(normalizeVisualProposalValue("character.apparentAge", value)).toBeUndefined();
    }
  });
  it("accepts only dropdown gender options and keeps figure manual", () => {
    expect(normalizeVisualProposalValue("character.gender", "Female")).toBe("female");
    expect(normalizeVisualProposalValue("character.gender", "male")).toBe("male");
    expect(normalizeVisualProposalValue("character.gender", "female; elegant presentation")).toBeUndefined();
    expect(normalizeVisualProposalValue("character.figure", "normal")).toBeUndefined();
  });
});
