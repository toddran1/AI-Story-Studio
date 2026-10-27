import { renderStoredChapterVideo } from "../src/video/chapter-video.js";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testStory } from "./helpers.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { emptyStoryBible } from "../src/domain/story-bible.js";
import { sceneSchema, sceneManifestSchema, sceneVideoTreatmentSchema } from "../src/scenes/types.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths, sceneImagePath } from "../src/storage/paths.js";
import { readVisualCheckImage, VISUAL_CHECK_CATEGORIES } from "../src/artwork/visual-check.js";
import { validPngFingerprint } from "../src/artwork/generator.js";
import { buildVideoPresentationTimeline, buildSceneMotionFilter } from "../src/video/presentation.js";
import { buildVideoArgs } from "../src/video/renderer.js";
import { resolveSceneMotion, sceneMotionContext } from "../src/video/scene-motion.js";
import { FfmpegMotionTools, MOTION_SAMPLE_VERSION } from "../src/video/motion-tools.js";
import { MotionAssetService, type MotionContext } from "../src/video/motion-service.js";
import { selectedMotionAsset, motionAssetPaths, motionAssetBinding, loadMotionAssets, saveMotionAssets, type MotionClipProvider } from "../src/video/motion-assets.js";
import type { LLMProvider } from "../src/llm/provider.js";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const MP4 = Buffer.from("0000ftypfake-motion");
class FakeMotionTools extends FfmpegMotionTools {
  calls = 0;
  override async normalize(_source: string, output: string, width: number, height: number) { this.calls++; await atomicWrite(output, MP4); return { durationSeconds: 4, width, height }; }
  override async frames(_video: string, _duration: number, paths: string[]) { for (const path of paths) await atomicWrite(path, PNG); }
  override async parallax(_bg: string, _fg: string, output: string, durationSeconds: number, width: number, height: number) { this.calls++; await atomicWrite(output, MP4); return { durationSeconds, width, height }; }
}
async function fixture(provider?: MotionClipProvider) {
  const root = await mkdtemp(join(tmpdir(), "motion-test-")); const story = testStory(); story.video.width=640; story.video.height=360;
  const paths = storyPaths(root, story.slug, 1), now = new Date().toISOString();
  const scene = sceneSchema.parse({ id: "scene-001", startSeconds: 0, endSeconds: 10, summary: "Moonlit hall", visualPrompt: "An empty hall under moonlight", location: "Hall", artwork: { status: "complete", review: "approved" } });
  const manifest = sceneManifestSchema.parse({ version: 1, chapter: 1, durationSeconds: 10, scenes: [scene], planningFingerprint: "fake", planner: { provider: "openai", model: "fake", promptVersion: "fake" }, createdAt: now, updatedAt: now });
  const target = { chapter: 1, sceneId: scene.id };
  await atomicWriteJson(paths.storyConfig, story); await atomicWriteJson(paths.bible, emptyStoryBible());
  const imagePath=sceneImagePath(root,story.slug,1,scene.id); await atomicWrite(imagePath,PNG); scene.artwork.imageFingerprint=await validPngFingerprint(imagePath); manifest.scenes[0]=scene;
  await atomicWriteJson(paths.scenesManifest,manifest);
  await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({ chapter: 1, sourceLanguage: "zh-CN", outputLanguage: "en-US", counts: { originalCharacters: 0, englishWords: 0, narrationWords: 0 }, createdAt: now, updatedAt: now, stages: Object.fromEntries(["ingestion", "translation", "narration", "storyBible", "tts"].map(stage => [stage, { status: "pending" }])) }));
  const tools=new FakeMotionTools(); let checks=0; let mismatch=false;
  const qa:LLMProvider={name:"openai",supportsImageInputs:true,async validateConfiguration(){},async generateText(){throw new Error("Not used");},async generateStructured(request){checks++; return {value:request.schema.parse({summary:mismatch?"Sword should be absent":"Matches",...Object.fromEntries(VISUAL_CHECK_CATEGORIES.map(category=>[category,{status:mismatch&&category==="equipment"?"mismatch":"match",observation:"Visible facts inspected"}]))})};}};
  const context=async():Promise<MotionContext>=>{const image=await readVisualCheckImage(imagePath);return {scene,story,imagePath,imageFingerprint:image.fingerprint,expected:scene.visualPrompt,images:[image.image]};};
  const service=new MotionAssetService(root,context,()=>qa,tools,provider);
  return {root,story,scene,manifest,paths,target,tools,service,checks:()=>checks,setMismatch:(value:boolean)=>{mismatch=value;},save:()=>atomicWriteJson(paths.scenesManifest,{...manifest,scenes:[scene]})};
}
describe("scene-aware video",()=>{
  it("uses scene beats and screen direction while honoring explicit motion",()=>{
    const scenes=[
      sceneSchema.parse({id:"scene-001",startSeconds:0,endSeconds:5,summary:"Talk",visualPrompt:"Two people converse",characters:["Mara","Leo"],sequence:{id:"a",beat:"interaction"}}),
      sceneSchema.parse({id:"scene-002",startSeconds:5,endSeconds:10,summary:"React",visualPrompt:"A quiet reaction",sequence:{id:"a",beat:"reaction"}}),
      sceneSchema.parse({id:"scene-003",startSeconds:10,endSeconds:15,summary:"Walk",visualPrompt:"Mara walks left",sequence:{id:"a",beat:"action",positions:[{name:"Mara",position:"left",facing:"left",movement:"walks toward the doorway"}]}}),
    ];
    const settings={...testStory().video,motion:{mode:"scene_aware" as const,intensity:"subtle" as const}};
    const timeline=buildVideoPresentationTimeline(scenes.map(scene=>({durationSeconds:5,motionContext:sceneMotionContext(scene)})),settings);
    expect(timeline.scenes.map(s=>s.motion)).toEqual(["still","zoom_in","pan_left"]);
    expect(timeline.scenes.every(s=>s.framing.fit==="contain")).toBe(true);
    expect(timeline.scenes[0]?.reason).toContain("eyelines");
    expect(resolveSceneMotion({...sceneMotionContext(scenes[1]!),direction:{...scenes[1]!.direction!,shotType:"extreme_close_up"}}).motion).toBe("still");
    expect(buildVideoPresentationTimeline([{durationSeconds:5,motionContext:sceneMotionContext(scenes[0]!),videoTreatment:{motion:"zoom_out"}}],settings).scenes[0]?.motion).toBe("zoom_out");
  });
  it("reserves safe border for movement and validates framing coordinates",()=>{
    const filter=buildSceneMotionFilter({mode:"pan_right",width:640,height:360,fps:24,durationSeconds:5,intensity:"subtle",framing:{fit:"contain",focusX:.5,focusY:.5}});
    expect(filter).toContain("force_original_aspect_ratio=decrease,pad=640:360");expect(filter).toContain("zoompan");
    expect(()=>sceneVideoTreatmentSchema.parse({framing:{fit:"cover",focusX:2}})).toThrow();
    expect(buildSceneMotionFilter({mode:"still",width:640,height:360,fps:24,durationSeconds:5,intensity:"subtle",framing:{fit:"cover",focusX:0,focusY:1}})).toContain("crop=640:360:(iw-ow)*0:(ih-oh)*1");
  });
  it("plays selected clips once, holds intro and ending, and maps only mastered audio",()=>{
    const story=testStory();const args=buildVideoArgs({audio:"narration.mp3",storyTitle:"Book",chapterLabel:"Chapter 1",audioDurationSeconds:10,sceneArtwork:[{path:"still.png",durationSeconds:10,clip:{path:"selected.mp4",durationSeconds:4}}]},"out.mp4",story.video);
    const cover=buildVideoArgs({audio:"narration.mp3",storyTitle:"Book",chapterLabel:"Chapter",audioDurationSeconds:10,cover:"cover.png"},"out.mp4",{...story.video,motion:{mode:"scene_aware",intensity:"subtle"}}).join(" ");expect(cover).toContain("force_original_aspect_ratio=decrease,pad=");
    expect(args.slice(0,2)).toEqual(["-i","selected.mp4"]);expect(args).not.toContain("-stream_loop");
    const graph=args[args.indexOf("-filter_complex")+1]!;expect(graph).toContain("tpad=start_mode=clone:start_duration=3:stop_mode=clone");expect(graph).toContain("[1:a]");expect(graph).not.toContain("[0:a]");expect(args).toContain("13");
  });
});
describe("selective motion candidates",()=>{
  it("imports without selecting or modifying the approved still",async()=>{const f=await fixture();try{
    const original=await readFile(sceneImagePath(f.root,f.story.slug,1,f.scene.id));const asset=await f.service.importClip(f.story.slug,f.target,MP4);
    expect(asset).toMatchObject({review:"unreviewed",checks:[],durationSeconds:4,origin:"import"});expect((await loadMotionAssets(f.root,f.story.slug,f.target)).selectedId).toBeUndefined();expect(await readFile(sceneImagePath(f.root,f.story.slug,1,f.scene.id))).toEqual(original);expect(f.checks()).toBe(0);
    await expect(f.service.select(f.story.slug,f.target,asset.id)).rejects.toThrow("checks");
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("routes selected motion into chapter rendering and invalidates reuse when switched back to a still",async()=>{const f=await fixture();try{
    f.story.video.subtitleMode="none";await atomicWriteJson(f.paths.storyConfig,f.story);
    await atomicWrite(f.paths.audio,"mastered-audio");
    const chapter=chapterSchema.parse(JSON.parse(await readFile(f.paths.chapterMeta,"utf8")));chapter.audio={durationSeconds:10,codec:"mp3",container:"mp3"};chapter.stages.audioMastering={status:"complete",outputFingerprint:await fileFingerprint(f.paths.audio)};await atomicWriteJson(f.paths.chapterMeta,chapter);
    const asset=await f.service.importClip(f.story.slug,f.target,MP4);await f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{});await f.service.select(f.story.slug,f.target,asset.id);
    let calls=0;const inputs:Array<{sceneArtwork?:Array<{clip?:{path:string}}> }>=[];
    const processor={version:"fake-video",async render(input:any,output:string,settings:any){calls++;inputs.push(input);await atomicWrite(output,`video-${calls}`);return {durationSeconds:13,width:settings.width,height:settings.height,videoCodec:"h264",audioCodec:"aac",container:"mp4"};}};
    expect((await renderStoredChapterVideo({root:f.root,story:f.story,chapter:1,processor})).reused).toBe(false);expect(inputs[0]?.sceneArtwork?.[0]?.clip?.path).toContain(asset.id);
    expect((await renderStoredChapterVideo({root:f.root,story:f.story,chapter:1,processor})).reused).toBe(true);
    await f.service.select(f.story.slug,f.target);expect((await renderStoredChapterVideo({root:f.root,story:f.story,chapter:1,processor})).reused).toBe(false);expect(inputs[1]?.sceneArtwork?.[0]?.clip).toBeUndefined();expect(calls).toBe(2);
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("removes unpublished media when candidate manifest validation fails",async()=>{const f=await fixture();try{
    f.tools.normalize=async (_source,output,width,height)=>{await atomicWrite(output,MP4);return {durationSeconds:99,width,height};};
    await expect(f.service.importClip(f.story.slug,f.target,MP4)).rejects.toThrow();
    expect((await loadMotionAssets(f.root,f.story.slug,f.target)).assets).toHaveLength(0);
    expect(await readdir(motionAssetPaths(f.root,f.story.slug,f.target).directory)).toEqual([]);
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("requires source approval and rejects invalid MP4 uploads",async()=>{const f=await fixture();try{
    await expect(f.service.importClip(f.story.slug,f.target,Buffer.from("not MP4"))).rejects.toThrow("MP4");f.scene.artwork.review="unreviewed";await f.save();await expect(f.service.importClip(f.story.slug,f.target,MP4)).rejects.toThrow("human-approved");expect(f.tools.calls).toBe(0);
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("checks three frames, reuses reviews, approves explicitly, and detects corrupt selected output",async()=>{const f=await fixture();try{
    const asset=await f.service.importClip(f.story.slug,f.target,MP4);await f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{});expect(f.checks()).toBe(3);
    await f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{});expect(f.checks()).toBe(3);
    await f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{},true);expect(f.checks()).toBe(6);
    await f.service.select(f.story.slug,f.target,asset.id);expect(await selectedMotionAsset(f.root,f.story.slug,f.target,f.scene)).toMatchObject({id:asset.id,durationSeconds:4});
    await atomicWrite(motionAssetPaths(f.root,f.story.slug,f.target,asset.id).video,"changed");await expect(selectedMotionAsset(f.root,f.story.slug,f.target,f.scene)).rejects.toThrow("damaged");
    await f.service.select(f.story.slug,f.target);expect(await selectedMotionAsset(f.root,f.story.slug,f.target,f.scene)).toBeUndefined();
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("does not mix old samples into a paused forced recheck or retain its approval",async()=>{const f=await fixture();try{
    const asset=await f.service.importClip(f.story.slug,f.target,MP4);await f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{});await f.service.select(f.story.slug,f.target,asset.id);
    const paused=await f.service.check(f.story.slug,f.target,asset.id,()=>f.checks()===4,()=>{},true);expect(paused).toMatchObject({status:"paused",checked:1});
    const pending=(await loadMotionAssets(f.root,f.story.slug,f.target)).assets[0]!;expect(pending.checks).toHaveLength(1);expect(pending.review).toBe("unreviewed");
    const metadata=chapterSchema.parse(JSON.parse(await readFile(f.paths.chapterMeta,"utf8")));expect(metadata.stages.video.staleReason).toContain("needs review");
    await expect(f.service.select(f.story.slug,f.target,asset.id)).rejects.toThrow("checks");
    await f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{});expect(f.checks()).toBe(6);await f.service.select(f.story.slug,f.target,asset.id);
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("keeps approved motion usable when rendering derives timing from a different mastered duration",async()=>{const f=await fixture();try{
    f.story.video.subtitleMode="none";await atomicWriteJson(f.paths.storyConfig,f.story);await atomicWrite(f.paths.audio,"mastered-audio");
    const chapter=chapterSchema.parse(JSON.parse(await readFile(f.paths.chapterMeta,"utf8")));chapter.audio={durationSeconds:20,codec:"mp3",container:"mp3"};chapter.stages.audioMastering={status:"complete",outputFingerprint:await fileFingerprint(f.paths.audio)};await atomicWriteJson(f.paths.chapterMeta,chapter);
    const asset=await f.service.importClip(f.story.slug,f.target,MP4);await f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{});await f.service.select(f.story.slug,f.target,asset.id);
    let duration=0;const processor={version:"fake",async render(input:any,output:string,settings:any){duration=input.sceneArtwork[0].durationSeconds;expect(input.sceneArtwork[0].clip.path).toContain(asset.id);await atomicWrite(output,"video-retimed");return {durationSeconds:23,width:settings.width,height:settings.height,videoCodec:"h264",audioCodec:"aac",container:"mp4"};}};
    await renderStoredChapterVideo({root:f.root,story:f.story,chapter:1,processor});expect(duration).toBe(20);expect(f.scene.endSeconds).toBe(10);
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("reports an altered starting file as unavailable before another local operation is attempted",async()=>{const f=await fixture();try{
    const path=sceneImagePath(f.root,f.story.slug,1,f.scene.id);await atomicWrite(path,Buffer.concat([PNG,Buffer.from("altered")]));const listed=await f.service.list(f.story.slug,f.target);expect(listed.startingFrameApproved).toBe(false);expect(listed.sourceError).toContain("changed");
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("refreshes older cached sample sets before their approved clip can be reused",async()=>{const f=await fixture();try{
    const asset=await f.service.importClip(f.story.slug,f.target,MP4);await f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{});await f.service.select(f.story.slug,f.target,asset.id);
    const old=await loadMotionAssets(f.root,f.story.slug,f.target);delete old.assets[0]!.samplingVersion;await saveMotionAssets(f.root,f.story.slug,f.target,old);
    expect((await f.service.list(f.story.slug,f.target)).assets[0]!.stale).toBe(true);await expect(selectedMotionAsset(f.root,f.story.slug,f.target,f.scene)).rejects.toThrow("current continuity");
    await f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{});expect(f.checks()).toBe(6);expect((await loadMotionAssets(f.root,f.story.slug,f.target)).assets[0]?.samplingVersion).toBe(MOTION_SAMPLE_VERSION);await f.service.select(f.story.slug,f.target,asset.id);
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("prevents approval of mismatches and pauses between paid checks",async()=>{const f=await fixture();try{
    const asset=await f.service.importClip(f.story.slug,f.target,MP4);const paused=await f.service.check(f.story.slug,f.target,asset.id,()=>f.checks()===1,()=>{});expect(paused).toMatchObject({status:"paused",checked:1});
    f.setMismatch(true);await f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{});expect(f.checks()).toBe(3);await expect(f.service.select(f.story.slug,f.target,asset.id)).rejects.toThrow("mismatches");
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("invalidates clips for narrative changes but not camera treatment edits",async()=>{const f=await fixture();try{
    const binding=await motionAssetBinding(f.root,f.story.slug,f.target,f.scene);f.scene.videoTreatment={motion:"still"};expect(await motionAssetBinding(f.root,f.story.slug,f.target,f.scene)).toBe(binding);
    const asset=await f.service.importClip(f.story.slug,f.target,MP4);await f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{});await f.service.select(f.story.slug,f.target,asset.id);
    f.scene.visualPrompt="A hall on fire";await f.save();expect((await f.service.list(f.story.slug,f.target)).assets[0]?.stale).toBe(true);await expect(selectedMotionAsset(f.root,f.story.slug,f.target,f.scene)).rejects.toThrow("current continuity");
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("does not rebind a clip to a different approved starting image",async()=>{const f=await fixture();try{
    const asset=await f.service.importClip(f.story.slug,f.target,MP4);const imagePath=sceneImagePath(f.root,f.story.slug,1,f.scene.id);await atomicWrite(imagePath,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEfQHzx5tC9AAAAABJRU5ErkJggg==","base64"));f.scene.artwork.imageFingerprint=await validPngFingerprint(imagePath);expect(f.scene.artwork.imageFingerprint).toBeTruthy();await f.save();await expect(f.service.check(f.story.slug,f.target,asset.id,()=>false,()=>{})).rejects.toThrow("starting image changed");expect(f.checks()).toBe(0);
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("creates local parallax from aligned PNG layers and requires transparency",async()=>{const f=await fixture();try{
    const asset=await f.service.parallax(f.story.slug,f.target,PNG,PNG,4);expect(asset).toMatchObject({kind:"parallax",origin:"local",review:"unreviewed"});const opaque=Buffer.from(PNG);opaque[25]=2;await expect(f.service.parallax(f.story.slug,f.target,PNG,opaque,4)).rejects.toThrow("alpha channel");expect(f.checks()).toBe(0);
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("binds generation to its preview and pauses before the provider call",async()=>{let calls=0;const provider:MotionClipProvider={name:"fake",version:"1",async generate(request){calls++;expect(request.prompt).toContain("approved starting frame");expect(request.source).toEqual(PNG);return {data:MP4};}};const f=await fixture(provider);try{
    const input={model:"configured-video-model",instruction:"A slight change in moonlight",durationSeconds:4,allowanceUsd:2};const plan=await f.service.planGeneration(f.story.slug,f.target,input);
    expect(await f.service.generate(f.story.slug,f.target,input,plan.fingerprint,()=>true)).toMatchObject({status:"paused"});expect(calls).toBe(0);
    await expect(f.service.generate(f.story.slug,f.target,input,"stale",()=>false)).rejects.toThrow("changed after preview");expect(calls).toBe(0);
    expect(await f.service.generate(f.story.slug,f.target,input,plan.fingerprint,()=>false)).toMatchObject({status:"completed",requests:1,reservedUsd:2,asset:{origin:"provider",review:"unreviewed"}});expect(calls).toBe(1);
  }finally{await rm(f.root,{recursive:true,force:true});}});
  it("leaves provider selection explicit when no adapter is configured",async()=>{const f=await fixture();try{await expect(f.service.planGeneration(f.story.slug,f.target,{model:"model",instruction:"Move"})).rejects.toThrow("No image-to-video provider");}finally{await rm(f.root,{recursive:true,force:true});}});
});
