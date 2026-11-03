/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ActivityDock, activityJobForChapter, useActivityJobs } from "../apps/web/src/ActivityDock.js";
import type { Job } from "../apps/web/src/api.js";
const first: Job = { id: "one", story: "a", type: "audio", status: "running", scope: { chapters: [1] } };
const second: Job = { id: "two", story: "b", type: "video", status: "running", scope: { from: 4, to: 7 } };
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("shows concurrent books, hides without losing work, and restores each card", async () => {
  const render = () => <ActivityDock jobs={[first,second]} titles={{a:"Book A",b:"Book B"}} renderJob={(job,hide) => <button onClick={hide}>Hide {job.id}</button>}/>;
  await act(async () => root.render(render())); expect(host.querySelectorAll(".activity-card")).toHaveLength(2); expect(host.textContent).toContain("2 active"); expect(host.textContent).toContain("Book A"); expect(host.textContent).toContain("Ch. 4–7");
  await act(async () => (Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Hide one")!).click()); expect(host.querySelectorAll(".activity-card")).toHaveLength(1);
  await act(async () => (Array.from(host.querySelectorAll("button")).find(button => button.textContent?.startsWith("Show all"))!).click()); expect(host.querySelectorAll(".activity-card")).toHaveLength(2);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Hide activity panel"]')!.click()); expect(host.querySelectorAll(".activity-card")).toHaveLength(0);
  await act(async () => (Array.from(host.querySelectorAll("button")).find(button => button.textContent?.startsWith("Show all"))!).click()); expect(host.querySelectorAll(".activity-card")).toHaveLength(2);
});
it("filters chapter actions by book and reserved chapters", () => {
  expect(activityJobForChapter([first, second],"a",2)).toBeUndefined(); expect(activityJobForChapter([first, second],"b",5)?.id).toBe("two"); expect(activityJobForChapter([{...first,status:"cancelled"}],"a",1)).toBeUndefined();
});
it("keeps all job states when polling and emits one completion event without remounting its consumer", async () => {
  vi.useFakeTimers(); let jobs = [first, second]; let mounts = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({jobs}),{headers:{"content-type":"application/json"}})));
  const finished = vi.fn(); window.addEventListener("studio:job-finished", finished);
  let update!: ReturnType<typeof useActivityJobs>["update"];
  function Probe(){ const activity = useActivityJobs(); update=activity.update; return <p>{activity.jobs.map(job=>`${job.id}:${job.status}`).join(" ")}</p>; }
  try {
    await act(async()=>{ mounts++; root.render(<Probe/>); }); expect(host.textContent).toContain("one:running"); expect(host.textContent).toContain("two:running");
    jobs=[{...first,status:"completed"}, second]; await act(async()=>{await vi.advanceTimersByTimeAsync(2000);}); expect(host.textContent).toContain("one:completed"); expect(host.textContent).toContain("two:running"); expect(finished).toHaveBeenCalledTimes(1);
    await act(async()=>update(first)); expect(host.textContent).toContain("one:completed"); expect(mounts).toBe(1);
    jobs=[...jobs,{id:"fast",story:"c",status:"completed",type:"visualWorkflow",createdAt:new Date().toISOString()}]; await act(async()=>{await vi.advanceTimersByTimeAsync(2000);}); expect(host.textContent).toContain("fast:completed");
  } finally {window.removeEventListener("studio:job-finished",finished);}
});
it("preserves a chapter editor draft when an unrelated job completes", async () => {
  const { App } = await import("../apps/web/src/App.js");
  const detail = {chapter:1,original:"原文",translation:"Saved translation",narration:"Saved narration",metadata:{stages:{translation:{status:"complete"},narration:{status:"complete"}}}};
  vi.stubGlobal("fetch",vi.fn(async (url:string)=>new Response(JSON.stringify(String(url).endsWith("/stories") ? {stories:[]} : String(url).endsWith("/jobs") ? {jobs:[]} : detail),{headers:{"content-type":"application/json"}})));
  window.history.replaceState({},"","/stories/a/chapters/1?tab=translation");
  await act(async()=>root.render(<App initialRoute={{page:"chapter",story:"a",chapter:1}}/>));
  const editor=host.querySelector<HTMLTextAreaElement>("textarea")!;expect(editor).not.toBeNull();
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(editor,"My unsaved correction");editor.dispatchEvent(new Event("input",{bubbles:true}));});
  expect(editor.value).toBe("My unsaved correction");
  await act(async()=>window.dispatchEvent(new CustomEvent("studio:job-finished",{detail:{...first,scope:{chapters:[2]},status:"completed"}})));
  expect(host.querySelector("textarea")).toBe(editor);expect(editor.value).toBe("My unsaved correction");
});
it("accepts a resumed queue job with a newer timestamp and ignores older progress", async()=>{
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({jobs:[]}),{headers:{"content-type":"application/json"}})));
  let update!:ReturnType<typeof useActivityJobs>["update"];
  const paused:Job={...first,status:"paused",updatedAt:"2026-11-03T18:00:00Z",payload:{queueJobId:"queue-one"}};
  function Probe(){const state=useActivityJobs(paused);update=state.update;return <p>{state.jobs[0]?.status}</p>;}
  await act(async()=>root.render(<Probe/>));
  await act(async()=>update({...paused,status:"running",updatedAt:"2026-11-03T18:00:01Z"}));expect(host.textContent).toBe("running");
  await act(async()=>update(paused));expect(host.textContent).toBe("running");
});
it("hides simultaneous completions without losing either dismissal",async()=>{
  await act(async()=>root.render(<ActivityDock jobs={[first,second]} titles={{}} renderJob={(job,hide)=><button onClick={hide}>Hide {job.id}</button>}/>));
  await act(async()=>{for(const button of Array.from(host.querySelectorAll(".activity-card button"))) (button as HTMLButtonElement).click();});
  expect(host.querySelectorAll(".activity-card")).toHaveLength(0);
});
