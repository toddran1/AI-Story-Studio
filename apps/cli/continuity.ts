#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { getContinuityReview } from "../server/catalog.js";
import { StudioOperations } from "../server/operations.js";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { loadImportedChapters } from "../../src/source/importer.js";
import { withStoryLock } from "../../src/storage/story-lock.js";
import { analyzeAndPersistContinuity } from "../../src/story-bible/continuity.js";
import { rebuildStoryBibleBeforeChapter } from "../../src/story-bible/rebuild.js";

export type ContinuityCommand={action:"analyze"|"list";story:string;status?:string}|{action:"show";story:string;id:string}|{action:"resolve";story:string;id:string;resolution:"kept_existing"|"intentional"|"corrected";note?:string};
export function parseContinuityArgs(values:string[]):ContinuityCommand { if(values[0]==="--story") values=["analyze",values[1]!]; const [action,story,id,...rest]=values; if(!action||!story||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(story))throw new Error("A valid story slug is required"); if(action==="analyze")return{action,story}; if(action==="list"){const status=rest[0]==="--status"?rest[1]:undefined;if(rest.length&&(!status||rest.length!==2))throw new Error("List accepts [--status open|resolved]");return{action,story,status};}if(action==="show"){if(!id||rest.length)throw new Error("Show requires a finding ID");return{action,story,id};}if(action==="resolve"){const index=rest.indexOf("--action"),value=index<0?undefined:rest[index+1],map={"keep-canonical":"kept_existing",intentional:"intentional","correct-bible":"corrected"} as const;const noteIndex=rest.indexOf("--note");if(!id||!value||!(value in map)||rest.length!==2+(noteIndex>=0?2:0))throw new Error("Resolve requires --action keep-canonical|intentional|correct-bible [--note text]");return{action,story,id,resolution:map[value as keyof typeof map],note:noteIndex>=0?rest[noteIndex+1]:undefined};}throw new Error(`Unknown continuity action: ${action}`); }
async function main() {
  const command = parseContinuityArgs(process.argv.slice(2)); const env=loadEnvironment(); const root = resolveStudioRoot(env); const operations=new StudioOperations(root,env);
  try { await runContinuityCommand(command,{root,operations,stdout:text=>process.stdout.write(text)}); } finally { await operations.close(); }
}
export async function runContinuityCommand(command:ContinuityCommand,d:{root:string;operations:Pick<StudioOperations,"resolveContinuity">;stdout:(text:string)=>unknown}) {
  if(command.action==="list") { const review=await getContinuityReview(d.root,command.story,command.status); d.stdout(review.findings.length?review.findings.map(item=>`${item.id}\t${item.status}\t${item.type}\t${item.explanation}`).join("\n")+"\n":"No continuity findings.\n"); return; }
  if(command.action==="show") { const review=await getContinuityReview(d.root,command.story); const finding=review.findings.find(item=>item.id===command.id); if(!finding)throw new Error("Continuity finding was not found"); d.stdout(JSON.stringify(finding,null,2)+"\n"); return; }
  if(command.action==="resolve") { d.stdout(JSON.stringify(await d.operations.resolveContinuity(command.story,command.id,{resolution:command.resolution,note:command.note}),null,2)+"\n"); return; }
  const story=command.story;
  await withStoryLock(d.root, story, "continuity analysis", async () => {
    const chapters = (await loadImportedChapters(d.root, story)).chapters.map((item) => item.chapter).sort((a, b) => a - b); const last = chapters.at(-1);
    if (!last) throw new Error(`Story '${story}' has no imported chapters`);
    const bible = await rebuildStoryBibleBeforeChapter(d.root, story, last + 1); const result = await analyzeAndPersistContinuity(d.root, story, bible, last);
    d.stdout(`Analyzed through Chapter ${result.document.analyzedThroughChapter}: ${result.document.findings.filter((item) => item.status === "open").length} open finding(s), ${result.document.findings.length} recorded.\n`);
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch((error)=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
