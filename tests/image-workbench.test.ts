import { atomicWriteJson, atomicWrite } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { sceneManifestSchema } from "../src/scenes/types.js";
import { parseImageChapterSelection } from "../src/scenes/chapter-selection.js";
import { resolveVisualContinuity, upsertVisualContinuityOverride, resolveChapterVisualContinuity } from "../src/visual-canon/continuity.js";
import { explainAppearance } from "../src/scenes/image-workbench.js";
import { backingArtworkVersion } from "../src/artwork/generator.js";
import { prepareArtworkRepair } from "../src/artwork/repair.js";
import { readCachedVisualCheck, visualCheckOutcome, visualCheckSchema, VISUAL_CHECK_CATEGORIES } from "../src/artwork/visual-check.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistChapterVisualContinuity, resolvePreviousVisualContinuity } from "../src/visual-canon/continuity.js";
import { describe, expect, it } from "vitest";
import { rankVisualReferences } from "../src/visual-canon/reference-selection.js";
import { visualReferenceImageSchema } from "../src/domain/visual-profile.js";
import { imageAutomationSchema, ImageRunBudget, storyboardFlags } from "../src/scenes/image-workbench.js";
import { sceneSchema } from "../src/scenes/types.js";
import { groupVisualSequences, sequencePrompt } from "../src/scenes/sequence.js";
import { normalizeSceneTiming } from "../src/scenes/timing.js";
import { testStory } from "./helpers.js";
const ref = (id: string, extra: Record<string,unknown> = {}) => visualReferenceImageSchema.parse({ id, entityId: "ent_0123456789abcdef01234567", imagePath: `${id}.png`, approved: true, createdAt: new Date().toISOString(), ...extra });
const scene = (id: string, extra: Record<string,unknown> = {}) => sceneSchema.parse({ id, summary: "They talk in the hall.", visualPrompt: "A conversation in the hall", location: "Hall", startSeconds: 0, endSeconds: 10, ...extra });
describe("image continuity desk", () => {
  it("selects historical, outfit and lighting references without exposing stored equipment or an inactive power", () => {
    const refs = [ref("identity", {role:"primary_reference"}), ref("future", {applicability:{fromChapter:50}}), ref("eyes", {applicability:{state:"activated"}}), ref("dress", {role:"outfit_sheet",applicability:{wardrobe:"blue dress"}}), ref("sword", {role:"equipment_reference",applicability:{locationVariant:"sword"}}), ref("night", {role:"environment_reference",applicability:{timeOfDay:"night"}})];
    const ranked = rankVisualReferences(refs,{chapter:5,wardrobe:"blue dress",timeOfDay:"night",activeState:false,text:"The sword is stored in a bag"});
    expect(ranked.filter(r=>r.eligible).map(r=>r.reference.id)).toEqual(["identity","dress","night"]);
    expect(rankVisualReferences(refs,{chapter:5,visibleEquipment:["sword"],activeState:true}).filter(r=>r.eligible).map(r=>r.reference.id)).toContain("sword");
    expect(rankVisualReferences(refs,{}).find(r=>r.reference.id==="future")?.eligible).toBe(false);
  });
  it("excludes location variants from other settings even when the passage mentions them", () => {
    const room=ref("bedroom",{role:"environment_reference",applicability:{locationVariant:"bedroom"}});
    expect(rankVisualReferences([room],{location:"Kitchen",text:"She left her bedroom and entered the kitchen."})[0]?.eligible).toBe(false);
    expect(rankVisualReferences([room],{location:"Upstairs bedroom"})[0]?.eligible).toBe(true);
    expect(rankVisualReferences([room],{text:"bedroom"})[0]?.eligible).toBe(false);
  });
  it("does not identify a manual original by comparing missing fingerprints", () => {
    const frame=scene("scene-001");
    frame.artwork.manuallyEdited=true;
    frame.artwork.versions=[{id:"v1",imageFingerprint:"candidate"} as never];
    expect(backingArtworkVersion(frame)).toBeUndefined();
    frame.artwork.imageFingerprint="candidate";
    expect(backingArtworkVersion(frame)?.id).toBe("v1");
    frame.artwork.manuallyEdited=false;
    frame.artwork.approvedVersionId="missing-approved-original";
    expect(backingArtworkVersion(frame)).toBeUndefined();
  });
  it("retains original ordering for equally ranked identity references", () => {
    expect(rankVisualReferences([ref("z",{role:"face_portrait"}),ref("a",{role:"face_portrait"})]).map(r=>r.reference.id)).toEqual(["z","a"]);
  });
  it("reserves before each attempt and stops at either limit", async () => {
    const ledger: unknown[]=[];
    const budget = new ImageRunBudget(imageAutomationSchema.parse({scope:{chapters:[1]},budgetUsd:1,maxRequests:2,imageAllowanceUsd:.4,checkAllowanceUsd:.2}),async state=>{ledger.push({...state});});
    await budget.reserve("image"); await budget.reserve("check");
    await expect(budget.reserve("image")).rejects.toThrow("limit");
    expect(ledger).toEqual([{requests:1,reservedUsd:.4},{requests:2,reservedUsd:.6}]);
  });
  it("groups continuous beats and exposes screen direction without inventing positions", () => {
    const scenes=groupVisualSequences([scene("scene-001"),scene("scene-002"),scene("scene-003",{location:"Street"})]);
    expect(scenes[0]!.sequence?.id).toBe(scenes[1]!.sequence?.id);
    expect(scenes[2]!.sequence?.id).not.toBe(scenes[0]!.sequence?.id);
    expect(scenes[0]!.sequence?.positions).toEqual([]);
    expect(sequencePrompt(scenes[1]!)).toContain("interaction frame");
    expect(storyboardFlags(scenes[1]!,scenes[0]!)).toEqual(expect.arrayContaining([expect.objectContaining({kind:"repetition"})]));
  });
  it("keeps repeated time facts in one sequence and starts a new sequence for an actual time change", () => {
    const result=groupVisualSequences([
      scene("scene-001",{visualChanges:{environment:{set:{timeOfDay:"night"}}}}),
      scene("scene-002",{visualChanges:{environment:{set:{timeOfDay:"Night"}}}}),
      scene("scene-003"),
      scene("scene-004",{visualChanges:{environment:{set:{timeOfDay:"dawn"}}}}),
    ]);
    expect(result[1]?.sequence?.id).toBe(result[0]?.sequence?.id);
    expect(result[2]?.sequence?.id).toBe(result[0]?.sequence?.id);
    expect(result[3]?.sequence?.id).not.toBe(result[0]?.sequence?.id);
  });
  it("keeps the ending instead of truncating a chapter to the ideal frame count", () => {
    const raw = [scene("scene-001"),scene("scene-002"),scene("scene-003",{summary:"The ending"})];
    const result=normalizeSceneTiming(raw,30,testStory().scenes);
    expect(result).toHaveLength(3); expect(result.at(-1)?.summary).toBe("The ending");
  });
  it("retains the supporting passage when an outfit carries into a later chapter", async () => {
    const root=await mkdtemp(join(tmpdir(),"image-source-facts-"));
    try {
      const first=scene("scene-001",{characters:["Mara"],narrationText:"Mara put on her blue coat.",visualChanges:{characters:[{name:"Mara",op:"enter",set:{wardrobe:"blue coat"}}]}});
      await persistChapterVisualContinuity({root,slug:"test",chapter:1,manifest:{chapter:1,scenes:[first]}});
      const second=scene("scene-001",{characters:["Mara"],narrationText:"She stepped outside."});
      await persistChapterVisualContinuity({root,slug:"test",chapter:2,manifest:{chapter:2,scenes:[second]}});
      const previous=await resolvePreviousVisualContinuity(root,"test",3);
      expect(Object.values(previous?.sourceFacts??{})).toEqual(expect.arrayContaining([expect.objectContaining({subject:"Mara",field:"wardrobe",chapter:1,passage:"Mara put on her blue coat."})]));
    }finally{await rm(root,{recursive:true,force:true});}
  });

  it("requires the exact active ability or transformation instead of any active power", () => {
    const eyes=ref("eyes",{applicability:{state:"activated",activationTrigger:"Blood vision"}});
    const form=ref("form",{applicability:{state:"transformed",activationTrigger:"Wolf form"}});
    expect(rankVisualReferences([eyes],{activeState:true,activeAbilities:["Healing"]})[0]?.eligible).toBe(false);
    expect(rankVisualReferences([eyes],{activeAbilities:["Blood vision"]})[0]?.eligible).toBe(true);
    expect(rankVisualReferences([form],{activeState:true,activeAbilities:["Wolf form"]})[0]?.eligible).toBe(false);
    expect(rankVisualReferences([form],{transformation:"Wolf form"})[0]?.eligible).toBe(true);
    expect(rankVisualReferences([ref("unlabelled",{applicability:{state:"activated"}})],{activeState:true})[0]?.eligible).toBe(false);
  });
  it("rejects unsafe chapter numbers before an increment loop can freeze the browser", () => {
    expect(()=>parseImageChapterSelection("9007199254740992")).toThrow("safe");
    expect(()=>parseImageChapterSelection("999999999999999999999999")).toThrow("safe");
    expect(parseImageChapterSelection("3,1-2,3")).toEqual([1,2,3]);
  });
  it("does not allow a text-only model to masquerade as an image-conditioned repair", async () => {
    const story=testStory(); story.artwork.model="gpt-image-1";
    const provider={name:"openai",version:"fake",capabilities:{supportsReferenceImages:true,maxReferenceImages:4,aspectRatios:["16:9" as const],models:[story.artwork.model],defaultModel:story.artwork.model},async validateConfiguration(){},async generate(){throw new Error("Must not run");}};
    await expect(prepareArtworkRepair(story,provider,"/not-read.png",{sourceVersionId:"v1",instruction:"Remove sword"},[],"Frame")).rejects.toThrow("cannot consume");
  });
  it("recomputes downstream handoffs after an earlier manifest changes and uses a newer unpersisted chapter", async () => {
    const root=await mkdtemp(join(tmpdir(),"image-handoff-freshness-"));
    const manifest=(chapter:number,scenes:ReturnType<typeof scene>[])=>sceneManifestSchema.parse({version:1,chapter,durationSeconds:10,planner:{provider:"fake",model:"fake",promptVersion:"fake"},planningFingerprint:"fake",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),scenes});
    try {
      const first=manifest(1,[scene("scene-001",{narrationText:"Mara wore a blue coat.",visualChanges:{characters:[{name:"Mara",op:"enter",set:{wardrobe:"blue coat"}}]}})]);
      const second=manifest(2,[scene("scene-001")]);
      for(const m of [first,second]){await atomicWriteJson(storyPaths(root,"test",m.chapter).scenesManifest,m);await persistChapterVisualContinuity({root,slug:"test",chapter:m.chapter,manifest:m});}
      expect((await resolvePreviousVisualContinuity(root,"test",3))?.state.characters[0]?.wardrobe).toBe("blue coat");
      first.scenes[0]!.visualChanges!.characters![0]!.set!.wardrobe="red coat";first.scenes[0]!.narrationText="Mara wore a red coat.";
      await atomicWriteJson(storyPaths(root,"test",1).scenesManifest,first);
      const current=await resolvePreviousVisualContinuity(root,"test",3);
      expect(current?.state.characters[0]?.wardrobe).toBe("red coat");
      expect(Object.values(current?.sourceFacts??{})).toEqual(expect.arrayContaining([expect.objectContaining({passage:"Mara wore a red coat."})]));
      const third=manifest(3,[scene("scene-001",{visualChanges:{characters:[{name:"Mara",op:"update",set:{wardrobe:"green coat"}}]}})]);
      await atomicWriteJson(storyPaths(root,"test",3).scenesManifest,third);
      expect((await resolvePreviousVisualContinuity(root,"test",4))?.state.characters[0]?.wardrobe).toBe("green coat");
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it("excludes disabled scenes from the final handoff and detects stale manual state without caller-supplied fingerprints", async () => {
    const root=await mkdtemp(join(tmpdir(),"image-disabled-state-"));
    try {
      const enabled=scene("scene-001",{narrationText:"Mara has a blue coat.",visualChanges:{characters:[{name:"Mara",op:"enter",set:{wardrobe:"blue coat"}}]}});
      const disabled=scene("scene-002",{disabled:true,visualChanges:{characters:[{name:"Mara",op:"update",set:{wardrobe:"bad future coat"}}]}});
      const result=await persistChapterVisualContinuity({root,slug:"test",chapter:1,manifest:{chapter:1,scenes:[enabled,disabled]}});
      expect(result.perScene).toHaveLength(1);expect(result.chapterEndState.characters[0]?.wardrobe).toBe("blue coat");
      await upsertVisualContinuityOverride({root,slug:"test",chapter:1,entry:{sceneId:enabled.id,sceneContentFingerprint:"obsolete",setState:{characters:[{name:"Mara",wardrobe:"obsolete manual coat"}]},revision:1,updatedAt:new Date().toISOString()}});
      const read=await resolveChapterVisualContinuity({root,slug:"test",chapter:1,manifest:{scenes:[enabled]}});
      expect(read.resolved.perScene[0]?.manualOverride?.stale).toBe(true);
      expect(read.resolved.chapterEndState.characters[0]?.wardrobe).toBe("blue coat");
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it("merges character updates that omit an ID and honors clears on re-entry", () => {
    const result=resolveVisualContinuity({scenes:[{id:"a",visualChanges:{characters:[{name:"Mara",entityId:"ent_0123456789abcdef01234567",op:"enter",set:{activeAbilities:["Blood vision"],wardrobe:"coat"}}]}},{id:"b",visualChanges:{characters:[{name:"Mara",op:"enter",clear:["activeAbilities"],set:{injuries:"cut hand"}}]}}]});
    expect(result.chapterEndState.characters).toHaveLength(1);
    expect(result.chapterEndState.characters[0]).toMatchObject({wardrobe:"coat",injuries:"cut hand"});
    expect(result.chapterEndState.characters[0]?.activeAbilities).toBeUndefined();
  });
  it("recovers corrupt cached reviews and refuses to call an entirely unreviewed image ready", async () => {
    const root=await mkdtemp(join(tmpdir(),"image-review-cache-"));
    try{await atomicWrite(join(root,"check.json"),"{ corrupt");expect(await readCachedVisualCheck(join(root,"check.json"))).toBeUndefined();}finally{await rm(root,{recursive:true,force:true});}
    const check=visualCheckSchema.parse({summary:"No visible evidence",...Object.fromEntries(VISUAL_CHECK_CATEGORIES.map(c=>[c,{status:"not_applicable",observation:"Not reviewed"}])),checkedAt:new Date().toISOString(),imageFingerprint:"fake",targetFingerprint:"fake",promptVersion:"fake",provider:"fake",model:"fake"});
    expect(visualCheckOutcome(check)).toBe("uncertain");
  });
  it("does not attribute editorial wardrobe overrides to the source narration", () => {
    const s=scene("scene-001",{narrationText:"Mara wore blue.",overrides:{wardrobeOverrides:{Mara:"red coat"}},visualChanges:{characters:[{name:"Mara",op:"enter",set:{wardrobe:"blue coat"}}]}});
    const resolved=resolveVisualContinuity({scenes:[{id:s.id,visualChanges:s.visualChanges}]}).perScene[0];
    expect(explainAppearance(s,resolved).find(f=>f.field==="wardrobe")).toMatchObject({value:"red coat",source:"Scene wardrobe override",passage:undefined});
  });

  it("does not carry a future handoff into a pinned opening flashback or the flashback outfit back into the present", () => {
    const result=resolveVisualContinuity({previousHandoff:{chapter:29,sceneId:"scene-001",state:{characters:[{name:"Mara",wardrobe:"future armor"}],objects:[]}},scenes:[{id:"past",appearanceChapter:2,visualChanges:{characters:[{name:"Mara",op:"enter",set:{wardrobe:"childhood coat"}}]}},{id:"present"}]});
    expect(result.perScene[0]?.startState.characters).toEqual([]);
    expect(result.perScene[1]?.endState.characters).toEqual([]);
    expect(result.perScene[1]?.changes?.transition).toBe("time_jump");
    expect(result.perScene[1]?.referenceDecision?.used).toBe(false);
  });

});
