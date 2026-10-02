import { describe, expect, it, vi } from "vitest";
import { PassThrough, Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { inspectNovelProvider } from "../src/source/novel-inspection.js";
import type { NovelSourceProvider } from "../src/source/novel-provider.js";
import type { SourceInspectionProgress } from "../src/source/types.js";
import { createApiHandler } from "../apps/server/api.js";
import type { StudioOperations } from "../apps/server/operations.js";
import { streamSourceInspection } from "../apps/server/source-inspection-stream.js";
import { inspectSourceWithProgress } from "../apps/web/src/source-inspection.js";
import { SourceInspectionModal } from "../apps/web/src/SourceInspectionModal.js";

function fakeProvider() {
  const provider: NovelSourceProvider = {
    id:"test", displayName:"Test", capabilities:{search:false,download:true,authentication:"none"}, supportsUrl:()=>true,search:async()=>[],
    getBook:async()=>({provider:"test",bookId:"1",title:"Book",url:"https://test.example/book/1"}),
    getChapterList:async()=>[470,471].map(n=>({provider:"test",bookId:"1",chapterId:String(n*100),chapter:n,title:`第${n}章`,url:`https://test.example/${n}`})),
    getChapter:async(ref)=>({...ref,text:"正文".repeat(100),contentLocated:true,retrievedAt:new Date().toISOString()}),
    validateChapter:()=>({status:"COMPLETE",evidence:{extractedCharacters:200,contentContainerFound:true,indicators:[],reasons:["Valid"]}}),
  }; return provider;
}
function responseRecorder() {
  const chunks: Buffer[] = []; const response = Object.assign(new PassThrough(),{writeHead:vi.fn(),flushHeaders:vi.fn()});
  response.on("data",chunk=>chunks.push(Buffer.from(chunk)));
  return {response:response as unknown as ServerResponse, text:()=>Buffer.concat(chunks).toString()};
}

describe("source inspection progress", () => {
  it("reports real chapter numbers separately from positions in the selected range", async () => {
    const progress: SourceInspectionProgress[]=[];
    const result=await inspectNovelProvider(fakeProvider(),"https://test.example/book/1",{from:470,to:471,onProgress:p=>progress.push(p)},"test");
    expect(result.chapters).toHaveLength(2);
    expect(progress.filter(p=>p.phase==="chapters")).toEqual([
      expect.objectContaining({chapter:470,current:1,total:2,completed:0}),expect.objectContaining({chapter:470,current:1,total:2,completed:1}),
      expect.objectContaining({chapter:471,current:2,total:2,completed:1}),expect.objectContaining({chapter:471,current:2,total:2,completed:2}),
    ]);
  });
  it("counts rejected chapters and stops after a disconnected request", async () => {
    const provider=fakeProvider(); provider.getChapter=vi.fn(async()=>{throw new Error("Unavailable");}); const progress:SourceInspectionProgress[]=[];
    const result=await inspectNovelProvider(provider,"url",{onProgress:p=>progress.push(p),from:470,to:471},"test");
    expect(result.warnings).toHaveLength(2);expect(progress.at(-1)).toMatchObject({completed:2,total:2});
    const controller=new AbortController();
    await expect(inspectNovelProvider(fakeProvider(),"url",{from:470,to:471,signal:controller.signal,onProgress:p=>{if(p.phase==="chapters"&&p.completed===1)controller.abort();}},"test")).rejects.toThrow();
  });
  it("streams the existing inspection endpoint while retaining JSON compatibility", async () => {
    const result={id:"preview-id",chapterCount:1,chapters:[],warnings:[]};
    const inspectSource=vi.fn(async (_input,_context,options)=>{options?.onProgress({phase:"chapters",chapter:470,current:470,total:1670,completed:469});return result;});
    const handler=createApiHandler({root:"/tmp",inspectSource} as unknown as StudioOperations);
    for(const streaming of [true,false]) {
      const req=Object.assign(Readable.from([JSON.stringify({url:"https://m.wfxs.tw/xiaoshuo/8076783/",from:1,to:1670})]),{method:"POST",url:"/api/stories/undead-disaster/source/inspect",headers:{host:"localhost:3000","content-type":"application/json",accept:streaming?"text/event-stream":"application/json"}});
      const recorded=responseRecorder();await handler(req as unknown as IncomingMessage,recorded.response);
      expect(recorded.response.writeHead).toHaveBeenCalledWith(200,expect.objectContaining({"content-type":expect.stringContaining(streaming?"text/event-stream":"application/json")}));
      if(streaming) {expect(recorded.text()).toContain('event: progress\ndata: {"phase":"chapters","chapter":470');expect(recorded.text()).toContain('event: result');}
      else expect(JSON.parse(recorded.text())).toEqual(result);
    }
  });
  it("sends failures through the stream and aborts acquisition when the client disconnects", async () => {
    const recorded=responseRecorder();await streamSourceInspection(recorded.response,async()=>{throw new Error("Challenge required");},error=>({error:(error as Error).message}));
    expect(recorded.text()).toContain('event: error\ndata: {"error":"Challenge required"}');
    const disconnected=responseRecorder();let signal:AbortSignal|undefined;let finish!:()=>void;
    const running=streamSourceInspection(disconnected.response,async(options)=>{signal=options.signal;await new Promise<void>(resolve=>{finish=resolve;});return {};},()=>({}));
    disconnected.response.emit("close");expect(signal?.aborted).toBe(true);finish();await running;expect(disconnected.text()).not.toContain("event: result");
  });
  it("parses split stream frames and multibyte titles, then returns the preview", async () => {
    const wire=': heartbeat\n\nevent: progress\ndata: {"phase":"chapters","chapter":470,"current":470,"completed":469,"total":1670,"title":"第470章"}\n\nevent: result\ndata: {"id":"preview"}\n\n';
    const bytes=new TextEncoder().encode(wire);const progress:SourceInspectionProgress[]=[];
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}}),{headers:{"content-type":"text/event-stream"}})));
    try {expect(await inspectSourceWithProgress("/inspect",{method:"POST"},p=>progress.push(p))).toEqual({id:"preview"});expect(progress[0]).toMatchObject({chapter:470,current:470,title:"第470章"});}finally{vi.unstubAllGlobals();}
  });
  it.each([
    ['event: error\ndata: {"error":"WFXS challenge required"}\n\n',/WFXS challenge required/],
    [': heartbeat\n\n',/connection closed before the preview/],
  ])("surfaces streamed errors and interrupted connections",async(wire,message)=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(wire,{headers:{"content-type":"text/event-stream"}})));
    try{await expect(inspectSourceWithProgress("/inspect",{},()=>{})).rejects.toThrow(message);}finally{vi.unstubAllGlobals();}
  });
  it("renders the current chapter, real progress bar, directory phase and recoverable failure",()=>{
    const html=renderToStaticMarkup(createElement(SourceInspectionModal,{progress:{phase:"chapters",current:470,chapter:470,total:1670,completed:469},onClose:()=>{}}));
    expect(html).toContain("Inspecting chapter 470 of 1670");expect(html).toContain('max="1670" value="469"');expect(html).toContain("28%");expect(html).toContain("until you import");
    const loading=renderToStaticMarkup(createElement(SourceInspectionModal,{progress:{phase:"directory",pagesChecked:12},onClose:()=>{}}));expect(loading).toContain("12 pages checked");expect(loading).not.toContain('value="');
    const failure=renderToStaticMarkup(createElement(SourceInspectionModal,{progress:{phase:"chapters"},error:"Challenge required",onClose:()=>{}}));expect(failure).toContain("Challenge required");expect(failure).toContain(">Close</button>");expect(failure).not.toContain("<progress");
  });
  it("offers the source website and retry for browser challenges without embedding untrusted HTML",()=>{
    const props={progress:{phase:"metadata" as const},error:"The source website requires browser verification (403)",sourceUrl:"https://m.wfxs.tw/xiaoshuo/8076783/",onRetry:()=>{},onClose:()=>{}};
    const html=renderToStaticMarkup(createElement(SourceInspectionModal,props));
    expect(html).toContain('href="https://m.wfxs.tw/xiaoshuo/8076783/"');expect(html).toContain('rel="noopener noreferrer"');expect(html).toContain("Open source website");expect(html).toContain("Retry inspection");expect(html).toContain("separate session");expect(html).not.toContain("<iframe");
    for(const sourceUrl of ["javascript:alert(1)","https://user:password@m.wfxs.tw/"]) expect(renderToStaticMarkup(createElement(SourceInspectionModal,{...props,sourceUrl}))).not.toContain("Open source website");
    expect(renderToStaticMarkup(createElement(SourceInspectionModal,{...props,error:"Invalid chapter range"}))).not.toContain("Open source website");
  });
  it("includes the error code in the streamed failure frame", async () => {
    const failure=Object.assign(new Error("The source website requires browser verification (403)"),{code:"CHALLENGE_REQUIRED"});
    const handler=createApiHandler({root:"/tmp",inspectSource:vi.fn(async()=>{throw failure;})} as unknown as StudioOperations);
    const req=Object.assign(Readable.from([JSON.stringify({url:"https://m.wfxs.tw/xiaoshuo/8076783/"})]),{method:"POST",url:"/api/stories/undead-disaster/source/inspect",headers:{host:"localhost:3000","content-type":"application/json",accept:"text/event-stream"}});
    const recorded=responseRecorder();await handler(req as unknown as IncomingMessage,recorded.response);
    expect(recorded.text()).toContain('"status":500,"code":"CHALLENGE_REQUIRED"');
  });
  it("renders the guided verification buttons for browser challenges", () => {
    const html=renderToStaticMarkup(createElement(SourceInspectionModal,{progress:{phase:"metadata" as const},error:"The source website requires browser verification (403)",sourceUrl:"https://m.wfxs.tw/xiaoshuo/8076783/",onRetry:()=>{},onClose:()=>{}}));
    expect(html).toContain("Open verification window");expect(html).toContain("visible Chrome window");
    expect(html).not.toContain("I&#x27;ve cleared the challenge — retry"); // Only offered after the window opens.
    expect(html).toContain("Open source website");expect(html).toContain("Retry inspection");
  });
});
