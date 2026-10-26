import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { FfmpegMotionTools } from "../src/video/motion-tools.js";
import { FfmpegVideoProcessor } from "../src/video/renderer.js";
import { videoSettingsSchema } from "../src/video/config.js";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
const ffmpeg=process.env.FFMPEG_PATH||"ffmpeg", ffprobe=process.env.FFPROBE_PATH||"ffprobe";
const available=[ffmpeg,ffprobe].every(command=>spawnSync(command,["-version"],{stdio:"ignore"}).status===0);
function generate(args:string[]) { const result=spawnSync(ffmpeg,["-hide_banner","-loglevel","error","-y",...args],{encoding:"utf8"});if(result.status!==0)throw new Error(result.stderr); }
it.skipIf(!available)("normalizes a silent motion clip, samples it, and holds its ending through a mixed-scene dissolve",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"motion-ffmpeg-"));try{
    const raw=join(directory,"raw.mp4"),clip=join(directory,"clip.mp4"),image=join(directory,"still.png"),audio=join(directory,"narration.m4a");
    generate(["-f","lavfi","-i","testsrc2=s=160x90:r=24:d=2","-c:v","libx264","-pix_fmt","yuv420p",raw]);
    generate(["-f","lavfi","-i","color=c=blue:s=160x90","-frames:v","1",image]);
    generate(["-f","lavfi","-i","sine=frequency=440:duration=8","-c:a","aac",audio]);
    const tools=new FfmpegMotionTools();const normalized=await tools.normalize(raw,clip,640,360);expect(normalized).toMatchObject({durationSeconds:2,width:640,height:360});
    const frames=[0,1,2].map(i=>join(directory,`sample-${i}.png`));await tools.frames(clip,2,frames);for(const path of frames)expect(await fileFingerprint(path)).toBeTruthy();
    const settings=videoSettingsSchema.parse({width:640,height:360,fps:24,introDurationSeconds:0,subtitleMode:"none",motion:{mode:"scene_aware",intensity:"subtle"}});
    const probe=await new FfmpegVideoProcessor().render({audio,audioDurationSeconds:8,storyTitle:"Fixture",chapterLabel:"Chapter",sceneArtwork:[{path:image,durationSeconds:5,clip:{path:clip,durationSeconds:2}},{path:image,durationSeconds:3,motionContext:{characters:[],importance:"standard",sequence:{id:"hall",beat:"establishing",positions:[]}}}]},join(directory,"final.mp4"),settings);
    expect(probe).toMatchObject({videoCodec:"h264",audioCodec:"aac",width:640,height:360});expect(probe.durationSeconds).toBeCloseTo(8,1);
  }finally{await rm(directory,{recursive:true,force:true});}
},30_000);
it.skipIf(!available)("renders aligned transparent foreground and clean background layers as a bounded local parallax clip",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"parallax-ffmpeg-"));try{
    const bg=join(directory,"bg.png"),fg=join(directory,"fg.png"),output=join(directory,"out.mp4");
    generate(["-f","lavfi","-i","color=c=blue:s=160x90","-frames:v","1",bg]);
    generate(["-f","lavfi","-i","color=c=black@0:s=160x90,format=rgba,drawbox=x=60:y=10:w=40:h=70:color=red@1:t=fill","-frames:v","1",fg]);
    const tools=new FfmpegMotionTools();await tools.parallax(bg,fg,output,2,640,360);expect(await tools.probe(output)).toMatchObject({durationSeconds:2,width:640,height:360});
  }finally{await rm(directory,{recursive:true,force:true});}
},30_000);
