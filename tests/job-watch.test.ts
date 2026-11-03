/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchJob } from "../apps/web/src/job-watch.js";
import type { Job } from "../apps/web/src/api.js";
const cleanup: Array<()=>void> = [];
const running: Job = { id: "shared", story: "book", type: "stageExecution", status: "running" };
beforeEach(()=>{vi.useFakeTimers();});
afterEach(()=>{cleanup.splice(0).forEach(stop=>stop());vi.useRealTimers();vi.unstubAllGlobals();});
it("shares a short request between observers without opening a persistent stream",async()=>{
  const source=vi.fn();vi.stubGlobal("EventSource",source);let job=running;
  const fetch=vi.fn(async()=>Response.json(job));vi.stubGlobal("fetch",fetch);const a=vi.fn(),b=vi.fn();
  cleanup.push(watchJob("shared",a,vi.fn()),watchJob("shared",b,vi.fn()));await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);expect(a).toHaveBeenCalledTimes(1);expect(b).toHaveBeenCalledTimes(1);expect(source).not.toHaveBeenCalled();
  job={...running,status:"completed"};await vi.advanceTimersByTimeAsync(1000);expect(a).toHaveBeenLastCalledWith(job);expect(b).toHaveBeenLastCalledWith(job);
  await vi.advanceTimersByTimeAsync(10000);expect(fetch).toHaveBeenCalledTimes(2);
});
it("aborts an unused request and ignores its late response",async()=>{
  let finish!:(response:Response)=>void;let signal:AbortSignal;
  vi.stubGlobal("fetch",vi.fn((_url,init)=>{signal=init.signal;return new Promise<Response>(resolve=>{finish=resolve;});}));const update=vi.fn();
  const stop=watchJob("shared",update,vi.fn());cleanup.push(stop);stop();expect(signal!.aborted).toBe(true);finish(Response.json(running));await vi.advanceTimersByTimeAsync(0);expect(update).not.toHaveBeenCalled();
});
it("isolates one observer's failure limit from another observer",async()=>{
  const fetch=vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(Response.json({...running,status:"completed"}));vi.stubGlobal("fetch",fetch);
  const a=vi.fn(),b=vi.fn(),error=vi.fn();cleanup.push(watchJob("shared",a,error,{maxFailures:1}),watchJob("shared",b,vi.fn()));await vi.advanceTimersByTimeAsync(0);expect(error).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);expect(a).not.toHaveBeenCalled();expect(b).toHaveBeenCalledTimes(1);
});
it("bounds stalled progress requests and retries rather than keeping a connection forever",async()=>{
  let attempts=0;const fetch=vi.fn((_url,init)=>{attempts++;if(attempts>1)return Promise.resolve(Response.json({...running,status:"completed"}));return new Promise((_resolve,reject)=>init.signal.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError"))));});vi.stubGlobal("fetch",fetch);
  const update=vi.fn(),error=vi.fn();cleanup.push(watchJob("shared",update,error));await vi.advanceTimersByTimeAsync(15000);expect(error).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(2000);expect(update).toHaveBeenCalledTimes(1);
});
