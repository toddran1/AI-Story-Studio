import { VisualWorkflowJob } from "../apps/web/src/VisualWorkflowJob.js";
/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { MotionAssetPanel } from "../apps/web/src/MotionAssetPanel.js";
import { VideoTreatmentEditor } from "../apps/web/src/VideoTreatmentEditor.js";
import { sceneSchema } from "../src/scenes/types.js";
const scene=sceneSchema.parse({id:"scene-001",startSeconds:0,endSeconds:10,summary:"A hall",visualPrompt:"Hall",artwork:{status:"complete",review:"approved",imageFingerprint:"source"}});
const list={version:1,assets:[],provider:null,recommended:true,startingFrameApproved:true};
let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);host=document.createElement("div");document.body.append(host);root=createRoot(host);localStorage.clear();});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function openPanel(){await act(async()=>{const panel=host.querySelector("details.motion-assets")! as HTMLDetailsElement;panel.open=true;panel.dispatchEvent(new Event("toggle"));});}
it("loads motion only when opened and offers local import while provider selection is pending",async()=>{
  const fetch=vi.fn(async()=>json(list));vi.stubGlobal("fetch",fetch);
  await act(async()=>root.render(<MotionAssetPanel slug="test" chapter={1} scene={scene}/>));expect(fetch).not.toHaveBeenCalled();await openPanel();expect(fetch).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("No image-to-video provider is configured");expect(host.textContent).toContain("Layered parallax");expect(host.querySelector('input[accept="video/mp4,.mp4"]')?.hasAttribute("disabled")).toBe(false);
});
it("locks motion creation until scene edits are saved",async()=>{
  vi.stubGlobal("fetch",vi.fn(async()=>json(list)));await act(async()=>root.render(<MotionAssetPanel slug="test" chapter={1} scene={scene} disabled/>));await openPanel();
  expect(host.textContent).toContain("Save scene edits");expect(host.querySelector('input[accept="video/mp4,.mp4"]')?.hasAttribute("disabled")).toBe(true);
});
it("keeps framing controls through treatment normalization",async()=>{
  const changed=vi.fn();await act(async()=>root.render(<VideoTreatmentEditor scene={scene} hasNext onChange={changed}/>));
  const framing=[...host.querySelectorAll("select")].find(select=>[...select.options].some(option=>option.textContent==="Keep full artwork visible"))!;
  await act(async()=>{framing.value="contain";framing.dispatchEvent(new Event("change",{bubbles:true}));});expect(changed).toHaveBeenCalledWith({framing:{fit:"contain",focusX:.5,focusY:.5}});
});
it("ignores a previous chapter's delayed motion list",async()=>{
  let finish!:(response:Response)=>void;vi.stubGlobal("fetch",vi.fn(async(_url,init)=>{const body=JSON.parse(String(init?.body));return body.chapter===1?new Promise<Response>(resolve=>{finish=resolve;}):json({...list,recommended:false});}));
  await act(async()=>root.render(<MotionAssetPanel slug="race" chapter={1} scene={scene}/>));await openPanel();
  await act(async()=>root.render(<MotionAssetPanel slug="race" chapter={2} scene={scene}/>));await act(async()=>finish(json({...list,recommended:true})));
  expect(host.textContent).not.toContain("This scene is marked as a major moment");
});
it("keeps use-still available when a selected clip's source is missing",async()=>{
  const id="mov_12345678-1234-1234-1234-123456789abc";const calls:string[]=[];
  vi.stubGlobal("fetch",vi.fn(async(url)=>{calls.push(String(url));return json({...list,selectedId:id,sourceError:"Starting image is missing",startingFrameApproved:false});}));
  await act(async()=>root.render(<MotionAssetPanel slug="test" chapter={1} scene={scene}/>));await openPanel();const button=[...host.querySelectorAll("button")].find(button=>button.textContent==="Use still artwork")!;
  expect(button.disabled).toBe(false);expect(host.textContent).toContain("Starting image is missing");await act(async()=>button.click());expect(calls.some(url=>url.endsWith("/select"))).toBe(true);
});

it("refreshes motion after a saved narrative edit on the same scene",async()=>{
  let calls=0;vi.stubGlobal("fetch",vi.fn(async()=>json({...list,recommended:++calls===1})));
  await act(async()=>root.render(<MotionAssetPanel slug="test" chapter={1} scene={scene}/>));await openPanel();expect(calls).toBe(1);
  await act(async()=>root.render(<MotionAssetPanel slug="test" chapter={1} scene={{...scene,visualPrompt:"The hall burns"}}/>));expect(calls).toBe(2);expect(host.textContent).not.toContain("This scene is marked as a major moment");
  expect(host.querySelector('input[type="number"]')?.getAttribute("value")).toBe("4");expect(host.textContent).toContain("Parallax duration");
});
it("does not run the old chapter's refresh callback after selection's delayed reload",async()=>{
  let finish!:(response:Response)=>void;let lists=0;const changed=vi.fn();vi.stubGlobal("fetch",vi.fn(async(url)=>{
    if(String(url).endsWith("/select"))return json({});
    lists++;if(lists===2)return new Promise<Response>(resolve=>{finish=resolve;});
    return json({...list,selectedId:"mov_12345678-1234-1234-1234-123456789abc"});
  }));
  await act(async()=>root.render(<MotionAssetPanel slug="test" chapter={1} scene={scene} onChange={changed}/>));await openPanel();
  await act(async()=>[...host.querySelectorAll("button")].find(button=>button.textContent==="Use still artwork")!.click());
  await act(async()=>root.render(<MotionAssetPanel slug="test" chapter={2} scene={scene} onChange={changed}/>));await act(async()=>finish(json(list)));expect(changed).not.toHaveBeenCalled();
});

it("shows completed sample reviews in the progress bar without requiring batch outcomes",async()=>{
  const job={id:"job",story:"test",type:"visualWorkflow",status:"running",progress:{stage:"motion-check",index:2,completed:2,total:3}};
  await act(async()=>root.render(<VisualWorkflowJob job={job as any}/>));expect(host.querySelector("progress")?.value).toBe(2);
});
