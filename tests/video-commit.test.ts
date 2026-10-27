import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitRenderedVideo } from "../src/video/commit.js";
import { atomicWrite } from "../src/storage/atomic-write.js";
import { fileFingerprint } from "../src/utils/file-fingerprint.js";
it("preserves the prior video if a renderer produced an empty replacement",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"video-commit-"));try{const output=join(directory,"video.mp4"),staged=join(directory,"staged.mp4");await atomicWrite(output,"previous accepted video");await atomicWrite(staged,Buffer.alloc(0));let saved=false;
    await expect(commitRenderedVideo(staged,output,async()=>{saved=true;})).rejects.toThrow("empty");expect(saved).toBe(false);expect(await readFile(output,"utf8")).toBe("previous accepted video");
  }finally{await rm(directory,{recursive:true,force:true});}
});
it("restores the previous video if metadata cannot commit",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"video-commit-"));try{const output=join(directory,"video.mp4"),staged=join(directory,"staged.mp4");await atomicWrite(output,"previous accepted video");await atomicWrite(staged,"new video");
    await expect(commitRenderedVideo(staged,output,async()=>{throw new Error("metadata write failed");})).rejects.toThrow("metadata write failed");expect(await readFile(output,"utf8")).toBe("previous accepted video");
  }finally{await rm(directory,{recursive:true,force:true});}
});
it("commits the new file and its measured fingerprint together",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"video-commit-"));try{const output=join(directory,"video.mp4"),staged=join(directory,"staged.mp4");await atomicWrite(output,"old");await atomicWrite(staged,"new");const expected=await fileFingerprint(staged);
    const result=await commitRenderedVideo(staged,output,async fingerprint=>{expect(await readFile(output,"utf8")).toBe("new");expect(fingerprint).toBe(expected);return "saved";});expect(result).toBe("saved");
  }finally{await rm(directory,{recursive:true,force:true});}
});
