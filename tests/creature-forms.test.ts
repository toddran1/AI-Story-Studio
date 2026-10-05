import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalEntitySchema, emptyStoryBible } from "../src/domain/story-bible.js";
import { visualProfileSchema } from "../src/domain/visual-profile.js";
import { sceneSchema, type Scene } from "../src/scenes/types.js";
import { sceneArtworkContentState } from "../src/scenes/editable-state.js";
import { planScenes } from "../src/scenes/planner.js";
import { resolveVisualCanonPrompt } from "../src/visual-canon/resolver.js";
import { inspectArtworkVisualPreflightForScenes } from "../src/visual-canon/preflight.js";
import { prepareCreatureForms } from "../src/visual-canon/creature-forms.js";
import { proposeAppearanceChanges } from "../src/visual-canon/appearance-changes.js";
import { loadVisualProfiles, saveVisualProfiles, addVisualReferenceImage, generateStyleSheet, approveVisualReference, deleteVisualReferenceImage } from "../src/visual-canon/profiles.js";
import { createDefaultArtDirection } from "../src/domain/art-direction.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import type { LLMProvider } from "../src/llm/provider.js";
import { testStory } from "./helpers.js";

const id = "ent_0123456789abcdef01234567";
const now = new Date().toISOString();
const entity = canonicalEntitySchema.parse({ id, type:"concept", sourceBucket:"creatures", visualIdentityKind:"template", canonicalName:"Goblins", firstAppearance:1,lastKnownAppearance:30 });
const bible = { ...emptyStoryBible(),canonicalEntities:[entity] };
const groups = [
  { id:"living",entity:"Goblins",label:"living goblins",state:"living" as const,count:3,appearance:"Green skin",excerpt:"Three living goblins" },
  { id:"zombie",entity:"Goblins",label:"zombie goblins",state:"zombie" as const,count:2,appearance:"Gray rotting flesh",excerpt:"two zombie goblins" },
];
const scene = () => sceneSchema.parse({ id:"scene-001",summary:"Mixed creatures",startSeconds:0,endSeconds:10,characters:[],visualPrompt:"Three living goblins fight two zombie goblins",creatureGroups:groups });
const profile = () => visualProfileSchema.parse({ id:"goblins",entityId:id,visualType:"creature",creatureIdentity:"template",status:"approved",creature:{ anatomy:"Living green-skinned goblin" },createdAt:now,updatedAt:now,
  references:[{ id:"living-ref",entityId:id,role:"primary_reference",source:"uploaded",approved:true,imagePath:"living.png",createdAt:now },{ id:"zombie-ref",entityId:id,role:"primary_reference",source:"uploaded",approved:true,imagePath:"zombie.png",createdAt:now }],
  creatureForms:[{ id:"living-form",name:"Living",state:"living",status:"approved",appearance:"Green skin, alive",referenceIds:["living-ref"] },{ id:"zombie-form",name:"Zombie",state:"zombie",status:"approved",appearance:"Gray rotting flesh",referenceIds:["zombie-ref"] }],
});
const resolve = (s:Scene,p=profile()) => resolveVisualCanonPrompt({ scene:s,story:testStory(),bible,artDirection:createDefaultArtDirection("illustration").presets[0]!,visualProfiles:{ [id]:p },chapter:20 });

describe("scene-scoped creature forms",()=>{
  it("uses different counts, features and references for simultaneous groups of one template",()=>{
    const result=resolve(scene());
    expect(result.resolvedEntities).toHaveLength(2);
    expect(result.prompt).toContain("3 living goblins");expect(result.prompt).toContain("2 zombie goblins");
    expect(result.resolvedEntities[0]?.references?.map(ref=>ref.id)).toEqual(["living-ref"]);
    expect(result.resolvedEntities[1]?.references?.map(ref=>ref.id)).toEqual(["zombie-ref"]);
    expect(result.resolvedEntities[1]?.description).not.toContain("Living green-skinned");
    expect(Object.keys(result.entityVisualFingerprints)).toHaveLength(2);
    const edited={ ...scene(),creatureGroups:groups.map(group=>({ ...group,count:4 })) };
    expect(sceneArtworkContentState(edited)).not.toEqual(sceneArtworkContentState(scene()));
    expect(resolve(edited).resolvedPromptFingerprint).not.toBe(result.resolvedPromptFingerprint);
  });
  it("honors disabled creature references and explicit fallback despite a missing form ID", () => {
    const s = scene(); s.creatureGroups![1]!.formId = "missing-form";
    expect(() => resolve(s)).toThrow("approved zombie form");
    const options = { scene: s, story: testStory(), bible, artDirection: createDefaultArtDirection("illustration").presets[0]!, visualProfiles: { [id]: profile() }, chapter: 20 };
    const fallback = resolveVisualCanonPrompt({ ...options, allowUnprofiledEntityIds: [id] });
    expect(fallback.resolvedEntities.every(entity => !entity.hasApprovedProfile)).toBe(true);
    expect(fallback.prompt).toContain("Gray rotting flesh");
    s.direction = sceneSchema.parse({ ...s, direction: { useCreatureReferences: false } }).direction;
    expect(() => resolve(s)).not.toThrow();
  });
  it("does not infer exact counts and rejects duplicate group IDs and unknown creatures",()=>{
    const unspecified={ ...scene(),creatureGroups:[{ ...groups[0]!,count:undefined }] };
    expect(resolve(unspecified).prompt).toContain("Unspecified number of");
    expect(()=>sceneSchema.parse({ ...scene(),creatureGroups:[groups[0],groups[0]] })).toThrow("unique");
    expect(()=>resolve({ ...scene(),creatureGroups:[{ ...groups[0]!,entity:"Unknown species" }] })).toThrow("canonical creature");
  });
  it("reuses a named individual's approved transformation era without requiring another creature form",async()=>{
    const dragon={ ...entity,canonicalName:"Drake",visualIdentityKind:"individual" as const };
    const namedBible={ ...bible,canonicalEntities:[dragon] };
    const namedProfile=visualProfileSchema.parse({ ...profile(),creatureIdentity:"individual",creatureForms:[],appearanceEras:[{ id:"bone",name:"Bone dragon",creatureState:"skeleton",startChapter:10,status:"approved",appearance:"Undead bone dragon",referenceIds:["zombie-ref"] }] });
    const skeletonScene={ ...scene(),creatureGroups:[{ ...groups[1]!,entity:"Drake",state:"skeleton" as const,count:1,label:"Drake",appearance:"An undead bone dragon" }] };
    const result=resolveVisualCanonPrompt({ scene:skeletonScene,story:testStory(),bible:namedBible,artDirection:createDefaultArtDirection("illustration").presets[0]!,visualProfiles:{ [id]:namedProfile },chapter:20 });
    expect(result.resolvedEntities[0]?.references?.map(ref=>ref.id)).toEqual(["zombie-ref"]);
    expect(result.resolvedEntities[0]?.appearanceEra?.id).toBe("bone");
    const report=await inspectArtworkVisualPreflightForScenes({ root:"/tmp",slug:"test",candidates:[{ id:"20:scene-001",scene:skeletonScene,chapter:20 }],context:{ bible:namedBible,visualProfiles:{ [id]:namedProfile } } });
    expect(report.ready).toBe(true);
  });
  it("never applies a template-wide appearance era and isolates unapproved forms",()=>{
    const changed={ ...profile(),appearanceEras:[{ id:"global",name:"Incorrect global change",startChapter:2,status:"approved" as const,appearance:"All goblins become skeletons",visualPrompt:"",referenceIds:[] }] };
    expect(resolve({ ...scene(),creatureGroups:undefined,characters:["Goblins"] },changed).prompt).not.toContain("All goblins become skeletons");
    expect(proposeAppearanceChanges(entity,changed)).toEqual([]);
    const drafted={ ...profile(),creatureForms:profile().creatureForms!.map(form=>form.state==="zombie" ? { ...form,status:"draft" as const,appearance:"Unapproved design" } : form) };
    const result=resolve(scene(),drafted);
    expect(result.resolvedEntities[1]?.references).toBeUndefined();expect(result.prompt).not.toContain("Unapproved design");expect(result.resolvedEntities[1]?.description).not.toContain("Living green-skinned");
  });
  it("requests form review during preflight and rejects ambiguous or mismatched approved selections",async()=>{
    const drafted={ ...profile(),creatureForms:profile().creatureForms!.map(form=>form.state==="zombie" ? { ...form,status:"draft" as const } : form) };
    const report=await inspectArtworkVisualPreflightForScenes({ root:"/tmp",slug:"test",candidates:[{ id:"scene-001",scene:scene() }],context:{ bible,visualProfiles:{ [id]:drafted } } });
    expect(report.ready).toBe(false);expect(report.requiresDecision[0]?.missingCreatureForms).toEqual(["zombie goblins (zombie)"]);
    expect(()=>resolve({ ...scene(),creatureGroups:[{ ...groups[1]!,formId:"living-form" }] })).toThrow("approved zombie form");
    const ambiguous={ ...profile(),creatureForms:[...profile().creatureForms!,{ ...profile().creatureForms![1]!,id:"another-zombie" }] };
    expect(()=>resolve(scene(),ambiguous)).toThrow("several approved");
  });
  it("prepares forms idempotently and generates, assigns, approves and deletes only a selected form reference",async()=>{
    const root=await mkdtemp(join(tmpdir(),"creature-forms-"));const story=testStory();
    try {
      await atomicWriteJson(storyPaths(root,story.slug,1).bible,bible);
      await prepareCreatureForms(root,story.slug,bible,[scene()]);const first=await loadVisualProfiles(root,story.slug);
      expect(first[id]?.creatureForms).toHaveLength(2);expect(first[id]?.status).toBe("draft");
      await prepareCreatureForms(root,story.slug,bible,[scene()]);expect(await loadVisualProfiles(root,story.slug)).toEqual(first);
      first[id]!.creatureForms![1]!.appearance="Gray rotting goblin, no green living skin";await saveVisualProfiles(root,story.slug,first);
      const base=await addVisualReferenceImage(root,story.slug,id,{ data:Buffer.from("living"),role:"primary_reference",approved:true });
      let prompt="";const provider={ name:"fake",validateConfiguration:async()=>{},generate:vi.fn(async(input:{ prompt:string })=>{ prompt=input.prompt;return { data:Buffer.from("zombie"),mimeType:"image/png" }; }) };
      const generated=await generateStyleSheet(root,story.slug,id,provider as any,story,{ creatureFormId:"form_zombie" });
      expect(prompt).toContain("Gray rotting goblin");expect(generated.reference.approved).toBe(false);expect(generated.reference.provenance?.creatureFormId).toBe("form_zombie");expect(generated.reference.replacesReferenceId).toBeUndefined();
      const approved=await approveVisualReference(root,story.slug,id,generated.reference.id,true,"form_zombie");
      expect(approved.status).toBe("approved");expect(approved.creatureForms?.find(form=>form.id==="form_zombie")?.status).toBe("approved");expect(approved.references.find(ref=>ref.id===base.reference.id)?.role).toBe("primary_reference");
      await expect(approveVisualReference(root,story.slug,id,base.reference.id,true,"form_zombie")).rejects.toThrow("not assigned");
      const deleted=await deleteVisualReferenceImage(root,story.slug,id,generated.reference.id);expect(deleted.profile.creatureForms?.find(form=>form.id==="form_zombie")?.referenceIds).toEqual([]);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it("filters unsupported scene groups at the LLM boundary using exact narration excerpts",async()=>{
    const planned={ scenes:[{ ...scene(),creatureGroups:[...groups,{ ...groups[1]!,id:"invented",excerpt:"A skeletal goblin emerged" }] }] };
    const provider={ validateConfiguration:async()=>{},generateStructured:async()=>({ value:planned,usage:{} }) } as unknown as LLMProvider;
    const story=testStory();const result=await planScenes(provider,story.pipeline.scenePlanner,{ chapter:1,narration:"Three living goblins fight two zombie goblins.",durationSeconds:10,bible,settings:story.scenes });
    expect(result.value.scenes[0]?.creatureGroups).toHaveLength(2);
  });
});
