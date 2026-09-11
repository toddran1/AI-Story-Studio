import { describe, expect, it } from "vitest";
import { deliveryInstructions, narrationDeliveryProfile, stripDeliveryCues } from "../src/narration/tts-direction.js";

describe("model-aware narration delivery", () => {
  it("uses the same S2 profile for paid and free S2.1 Pro", () => {
    expect(narrationDeliveryProfile("fish", "s2.1-pro")).toMatchObject({ id: "fish-s2", cueSyntax: "brackets" });
    expect(narrationDeliveryProfile("fish", "s2.1-pro-free")).toMatchObject({ id: "fish-s2", cueSyntax: "brackets" });
    expect(deliveryInstructions("fish", "s2.1-pro-free", "English")).toMatch(/Fish Audio S2/);
  });

  it("preserves reader-facing bracketed story text while removing controlled S2 directions", () => {
    const script = "[sad] The [System] announced the result. [pause] She left.";
    expect(stripDeliveryCues(script, "fish", "s2.1-pro")).toBe("The [System] announced the result. She left.");
  });

  it("uses legacy parenthesized directions only for S1", () => {
    expect(narrationDeliveryProfile("fish", "s1")).toMatchObject({ id: "fish-s1", cueSyntax: "parentheses" });
    expect(stripDeliveryCues("(sad) Hello. [sad] Keep this.", "fish", "s1")).toBe("Hello. [sad] Keep this.");
    expect(narrationDeliveryProfile("future-provider", "s2.1-pro")).toMatchObject({ id: "plain", cueSyntax: "none" });
  });
});
