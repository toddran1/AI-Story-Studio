#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { StudioOperations } from "../server/operations.js";
import { Job, JobManager } from "../server/job-manager.js";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";

function wait(jobs:JobManager,id:string):Promise<Job>{return new Promise((resolve,reject)=>{let stop:(()=>void)|undefined;const done=(job:Job)=>{if(["completed","failed","paused"].includes(job.status)){stop?.();resolve(job);}};stop=jobs.subscribe(id,done);if(!stop)reject(new Error("Voice preview job was not found"));});}
export async function runVoice(values:string[],ops:Pick<StudioOperations,"startVoicePreview"|"jobs">,stdout:(t:string)=>unknown){const [action,...rest]=values;if(action!=="preview")throw new Error("Usage: story:voice preview --story <slug> --text \"Test narration\" [--provider fish] [--model id] [--reference-id id] [--speed 1]");const option=(name:string)=>{const i=rest.indexOf(name);return i<0?undefined:rest[i+1];};const story=option("--story"),text=option("--text");if(!story||!text)throw new Error("Preview requires --story and --text");const speed=option("--speed");const job=ops.startVoicePreview(story,{text,provider:option("--provider"),model:option("--model"),referenceId:option("--reference-id"),speed:speed===undefined?undefined:Number(speed)});const result=await wait(ops.jobs,job.id);if(result.status!=="completed")throw new Error(result.error??"Voice preview did not complete");stdout(JSON.stringify(result.result,null,2)+"\n");}
async function main(){const env=loadEnvironment(),root=resolveStudioRoot(env),ops=new StudioOperations(root,env);try{await runVoice(process.argv.slice(2),ops,t=>process.stdout.write(t));}finally{await ops.close();}}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{process.stderr.write(`${e instanceof Error?e.message:String(e)}\n`);process.exitCode=1;});
