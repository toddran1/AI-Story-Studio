import { PassThrough, Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { it, expect, vi } from "vitest";
import { createApiHandler } from "../apps/server/api.js";
import type { StudioOperations } from "../apps/server/operations.js";
async function request(operations:Record<string,unknown>,action:string,data:Buffer|string,headers:Record<string,string>={}) {
  const req=Object.assign(Readable.from([data]),{method:"POST",url:`/api/stories/demo/video-workflow/motion/${action}`,headers:{host:"localhost:3000","content-type":"application/json",...headers}});
  let status=0;const res=Object.assign(new PassThrough(),{writeHead(code:number){status=code;}});res.resume();
  const handled=await createApiHandler(operations as unknown as StudioOperations)(req as unknown as IncomingMessage,res as unknown as ServerResponse);
  return {status,handled};
}
it("accepts binary MP4 uploads and passes only their validated target header to the operation",async()=>{
  const importSceneMotion=vi.fn(async()=>({id:"job"}));const target={chapter:1,sceneId:"scene-001"},data=Buffer.from("0000ftypfixture");
  const result=await request({importSceneMotion},"import",data,{"content-type":"application/octet-stream","x-motion-target":encodeURIComponent(JSON.stringify(target))});expect(result.status).toBe(202);expect(importSceneMotion).toHaveBeenCalledWith("demo",target,data);
});
it("routes motion list and selection independently",async()=>{
  const listSceneMotion=vi.fn(async()=>({assets:[]})),selectSceneMotion=vi.fn(async()=>({selectedId:undefined}));
  const target={chapter:1,sceneId:"scene-001"};expect((await request({listSceneMotion},"list",JSON.stringify(target))).status).toBe(200);
  expect((await request({selectSceneMotion},"select",JSON.stringify({target}))).status).toBe(200);expect(selectSceneMotion).toHaveBeenCalledWith("demo",{target});
});
it("does not turn an unsupported POST to the file endpoint into a still-selection mutation",async()=>{
  const selectSceneMotion=vi.fn();const result=await request({selectSceneMotion},"file",JSON.stringify({target:{chapter:1,sceneId:"scene-001"}}));expect(result.status).toBe(404);expect(selectSceneMotion).not.toHaveBeenCalled();
});
