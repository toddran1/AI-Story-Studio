import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalEntitySchema, emptyStoryBible, type VisualEvidence } from "../src/domain/story-bible.js";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { proposeAppearanceChanges, syncAppearanceChanges } from "../src/visual-canon/appearance-changes.js";
import { loadVisualProfiles, saveVisualProfiles } from "../src/visual-canon/profiles.js";
import { effectiveVisualProfile, resolveApprovedAppearanceEra } from "../src/visual-canon/resolver.js";

const entityId = "ent_0123456789abcdef01234567";
const entity = () => canonicalEntitySchema.parse({ id: entityId, type: "concept", sourceBucket: "creatures", canonicalName: "Dragon", firstAppearance: 1, lastKnownAppearance: 700 });
const profile = () => visualProfileSchema.parse({ id: "dragon", entityId, visualType: "creature", status: "approved", creature: { anatomy: "Living winged dragon with red flesh", armorFur: "red scales" }, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" });
function evidence(chapter: number, field: VisualEvidence["field"], value: string, patch: Partial<VisualEvidence> = {}): VisualEvidence {
  return { id: `ve_${String(chapter).padStart(22,"0")}${field === "creature.anatomy" ? "01" : "02"}`, chapter, field, value, normalizedValue: value.toLowerCase(), lastObservedChapter: chapter, confidence: .95, persistence: "changed", status: "current", source: "source_text", provenance: [{ chapter, excerpt: value, confidence: .95 }], ...patch };
}

describe("detected lasting appearance eras", () => {
  it("prepares a bone dragon era and preserves that form through later changes without activating drafts", () => {
    const dragon = { ...entity(), visualEvidence: [evidence(400,"creature.anatomy","Undead bone dragon with exposed skeleton and no flesh"), evidence(600,"creature.eyes","Blue glowing sockets")] };
    const eras = proposeAppearanceChanges(dragon, profile());
    expect(eras).toHaveLength(2);expect(eras[0]).toMatchObject({ startChapter:400, endChapter:599, status:"draft", referenceIds:[] });
    expect(eras[1]?.appearance).toContain("bone dragon");expect(eras[1]?.creature?.eyes).toBe("Blue glowing sockets");
    const drafted = { ...profile(), appearanceEras:eras };
    expect(resolveApprovedAppearanceEra(drafted,450)).toBeUndefined();
    const approved = { ...drafted, appearanceEras:eras.map(era => ({ ...era, status:"approved" as const })) };
    const current = effectiveVisualProfile(approved,resolveApprovedAppearanceEra(approved,650));
    expect(current.creature?.anatomy).toContain("bone dragon");expect(current.creature?.armorFur).toBeUndefined();
    expect(resolveApprovedAppearanceEra(approved,399)).toBeUndefined();
  });
  it("does not guess transformations from death, temporary details, low confidence, conflicts or dismissed evidence", () => {
    const dragon = { ...entity(), status:"dead" };
    expect(proposeAppearanceChanges(dragon,profile())).toEqual([]);
    for(const patch of [{ persistence:"temporary" as const },{ confidence:.6 },{ status:"conflict" as const }]) expect(proposeAppearanceChanges({ ...dragon, visualEvidence:[evidence(400,"creature.anatomy","Blood-covered dragon",patch)] },profile())).toEqual([]);
    const item=evidence(400,"creature.anatomy","Skeleton");
    expect(proposeAppearanceChanges({ ...dragon,visualEvidence:[item],visualEvidenceDecisions:[{ field:item.field,evidenceId:item.id,action:"dismiss",decidedAt:new Date().toISOString() }] },profile())).toEqual([]);
  });
  it("preserves manual eras and dismissals and ignores conflicting values in the same chapter", () => {
    const dragon={ ...entity(),visualEvidence:[evidence(400,"creature.anatomy","Bone dragon")] };
    const eras=proposeAppearanceChanges(dragon,profile());
    expect(proposeAppearanceChanges(dragon,{ ...profile(),appearanceEras:[{ ...eras[0]!,name:"Manually edited" }] })).toEqual([]);
    expect(proposeAppearanceChanges(dragon,{ ...profile(),dismissedAppearanceEraIds:[eras[0]!.id] })).toEqual([]);
    expect(proposeAppearanceChanges({ ...dragon,visualEvidence:[...dragon.visualEvidence,evidence(400,"creature.anatomy","Living dragon")] },profile())).toEqual([]);
  });
  it("automatically persists drafts once, preserves edits, and respects skip policy",async()=>{
    const root=await mkdtemp(join(tmpdir(),"appearance-changes-"));
    try {
      const dragon={ ...entity(),visualEvidence:[evidence(400,"creature.anatomy","Bone dragon")] };
      const bible={ ...emptyStoryBible(),canonicalEntities:[dragon] };
      await syncAppearanceChanges(root,"test",bible);const first=await loadVisualProfiles(root,"test");
      expect(first[entityId]?.appearanceEras).toHaveLength(1);
      await syncAppearanceChanges(root,"test",bible);expect(await loadVisualProfiles(root,"test")).toEqual(first);
      first[entityId]!.appearanceEras![0]!.name="My approved look";await saveVisualProfiles(root,"test",first);
      await syncAppearanceChanges(root,"test",bible);expect((await loadVisualProfiles(root,"test"))[entityId]?.appearanceEras?.[0]?.name).toBe("My approved look");
      await syncAppearanceChanges(root,"skip",{ ...bible,canonicalEntities:[{ ...dragon,visualProfilePolicy:{ mode:"skip" } }] });expect(await loadVisualProfiles(root,"skip")).toEqual({});
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it("flags changed source evidence without replacing an edited era or silently reapproving it", async () => {
    const root = await mkdtemp(join(tmpdir(), "appearance-reconcile-"));
    try {
      const dragon = { ...entity(), visualEvidence: [evidence(400, "creature.anatomy", "Bone dragon")] };
      const bible = { ...emptyStoryBible(), canonicalEntities: [dragon] };
      await syncAppearanceChanges(root, "test", bible);
      const saved = await loadVisualProfiles(root, "test");
      saved[entityId]!.appearanceEras![0]!.name = "My edited design";
      await saveVisualProfiles(root, "test", saved);
      dragon.visualEvidence[0]!.value = "Living dragon";
      await syncAppearanceChanges(root, "test", bible);
      const era = (await loadVisualProfiles(root, "test"))[entityId]?.appearanceEras?.[0];
      expect(era).toMatchObject({ name: "My edited design", detectedChange: { needsReview: true } });
      expect(era?.appearance).toContain("Bone dragon");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps approved draft-era references out of the base profile", () => {
    const p = profile(); const eras = proposeAppearanceChanges({ ...entity(), visualEvidence: [evidence(400,"creature.anatomy","Bone dragon")] }, p);
    p.appearanceEras = [{ ...eras[0]!, referenceIds: ["era"] }];
    p.references = [{ id: "era", entityId, imagePath: "era.png", approved: true, role: "primary_reference", source: "uploaded", createdAt: p.createdAt }];
    expect(effectiveVisualProfile(p, undefined).references).toEqual([]);
  });
  it("flags a later cumulative era when its inherited transformation evidence changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "appearance-inherited-"));
    try {
      const dragon = { ...entity(), visualEvidence: [evidence(400,"creature.anatomy","Bone dragon"), evidence(600,"creature.eyes","Blue sockets")] };
      const bible = { ...emptyStoryBible(), canonicalEntities: [dragon] };
      await syncAppearanceChanges(root, "test", bible);
      dragon.visualEvidence[0]!.value = "Living dragon";
      await syncAppearanceChanges(root, "test", bible);
      const eras = (await loadVisualProfiles(root, "test"))[entityId]!.appearanceEras!;
      expect(eras[1]!.detectedChange?.needsReview).toBe(true);
      expect(eras[1]!.creature?.anatomy).toBe("Bone dragon");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
