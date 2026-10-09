import { describe, expect, it } from "vitest";
import { canonicalEntitySchema, canonicalRelationshipSchema, emptyStoryBible, type EntityType } from "../src/domain/story-bible.js";
import { detectContinuityFindings } from "../src/story-bible/continuity.js";

function fixture(targetType: EntityType, labels = ["owns", "possesses"]) {
  const ids = ["ent_" + "a".repeat(24), "ent_" + "b".repeat(24), "ent_" + "c".repeat(24)];
  const bible = emptyStoryBible();
  bible.canonicalEntities = ids.map((id, index) => canonicalEntitySchema.parse({ id, canonicalName: ["Qian Yi", "Xu Tianwang", targetType === "character" ? "Su Ming" : "Silver-grade Key"][index], type: index === 2 ? targetType : "character", firstAppearance: 1, lastKnownAppearance: 638 }));
  bible.canonicalRelationships = labels.map((type, index) => canonicalRelationshipSchema.parse({ id: "rel_" + String(index + 1).repeat(24), sourceEntityId: ids[index], targetEntityId: ids[2], type, startChapter: [244, 638][index], state: "current" }));
  return bible;
}
const ownershipFindings = (bible: ReturnType<typeof fixture>) => detectContinuityFindings(bible).filter(finding => finding.type === "ability_item_conflict");

describe("continuity ownership", () => {
  it("does not interpret Qian Yi's pursuit or Xu Tianwang's hostility as ownership", () => {
    const labels = ["Adversaries chasing and fighting each other over the Silver-grade Key", "Has been secretly seeking to kill him and is tasked by Lu Yingxiong with doing so."];
    expect(ownershipFindings(fixture("character", labels))).toEqual([]);
    expect(ownershipFindings(fixture("item", labels))).toEqual([]);
  });
  it.each(["character", "ability", "concept", "organization", "location", "other"] as const)("does not infer exclusive ownership of a %s", type => {
    expect(ownershipFindings(fixture(type))).toEqual([]);
  });
  it.each(["owns", "possesses", "has", " Owner Of ", "has_in_possession"])("detects explicit overlapping item ownership using %s", label => {
    const findings = ownershipFindings(fixture("item", [label, "owns"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ chapters: [244, 638], explanation: "Silver-grade Key has multiple current owners." });
  });
  it.each(["has seen", "has lost", "no longer owns", "does not possess", "previously possessed", "chases"])("ignores non-ownership label %s", label => {
    expect(ownershipFindings(fixture("item", [label, "owns"]))).toEqual([]);
  });
  it("does not flag historical ownership or a completed transfer", () => {
    const bible = fixture("item");
    bible.canonicalRelationships[0]!.state = "historical";
    expect(ownershipFindings(bible)).toEqual([]);
    bible.canonicalRelationships[0]!.state = "current";
    bible.canonicalRelationships[0]!.endChapter = 637;
    expect(ownershipFindings(bible)).toEqual([]);
    bible.canonicalRelationships[0]!.endChapter = 638;
    expect(ownershipFindings(bible)).toHaveLength(1);
  });
  it("does not flag repeated claims by the same owner", () => {
    const bible = fixture("item");
    bible.canonicalRelationships[1]!.sourceEntityId = bible.canonicalRelationships[0]!.sourceEntityId;
    expect(ownershipFindings(bible)).toEqual([]);
  });
});
