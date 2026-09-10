import { FfmpegAudiobookProcessor } from "../audio/audiobook.js";
import { Environment } from "../config/env.js";
import { loadStory } from "../config/load-config.js";
import { createPipelineRuntime } from "../pipeline/create-pipeline.js";
import { planProduction, ProductionDependencies, runProduction } from "../production/orchestrator.js";
import { ProductionPlan, productionForceSchema } from "../production/types.js";
import { refreshProductionRange } from "../production/refresh.js";
import { loadImportedChapters } from "../source/importer.js";
import { SourceProviderRegistry } from "../source/registry.js";
import { createWebHttpClient } from "../source/web/create-client.js";
import { storyPaths } from "../storage/paths.js";
import { withStoryLock } from "../storage/story-lock.js";
import { FfmpegVideoProcessor } from "../video/renderer.js";
import { FfmpegVideoExportProcessor } from "../video/video-export.js";
import { PostgresQueueRepository } from "./repository.js";
import { QueueExecutor } from "./worker.js";
import { QueueJob, QueueSubmission, QueueWorkItem, queueSubmissionSchema } from "./types.js";
import { alignmentConfig, createAlignmentEngine } from "../alignment/config.js";

export class ProductionQueueService implements QueueExecutor {
  private readonly runtime; private readonly registry; private readonly video = new FfmpegVideoProcessor(); private readonly videoExport = new FfmpegVideoExportProcessor(); private readonly audiobook = new FfmpegAudiobookProcessor(); private readonly alignConfig; private readonly aligner;
  constructor(private readonly root:string,private readonly env:Environment,readonly repository:PostgresQueueRepository){this.runtime=createPipelineRuntime(env);this.registry=new SourceProviderRegistry(undefined,createWebHttpClient(root,env));this.alignConfig=alignmentConfig(env,root);this.aligner=createAlignmentEngine(this.alignConfig);}

  async submit(storySlug:string,raw:unknown){const input=queueSubmissionSchema.parse(raw);const story=await loadStory(storyPaths(this.root,storySlug,1).storyConfig);const dependencies={loadChapters:async()=>(await loadImportedChapters(this.root,storySlug)).chapters,refresh:(from:number,to:number)=>refreshProductionRange({root:this.root,story,from,to,registry:this.registry})};const {plan}=await planProduction({root:this.root,story,...input,dryRun:false},dependencies);return this.repository.createJob({story:storySlug,input,plan,chapters:plan.requiredChapters.map(chapter=>({chapter,providers:requiredProviders(story,plan,chapter)})),maxAttempts:this.env.QUEUE_MAX_ATTEMPTS});}

  async execute(item:QueueWorkItem,job:QueueJob,progress:(stage:string,status?:string)=>void){return withStoryLock(this.root,job.story,`durable production job ${job.id}`,async()=>{const story=await loadStory(storyPaths(this.root,job.story,item.chapter).storyConfig);const input=queueSubmissionSchema.parse(job.options);const selectedForce=productionForceSchema.safeParse(forceAlias(item.currentStage));const force=selectedForce.success?selectedForce.data:input.force;const planned=await planProduction({root:this.root,story,...input,force,from:item.chapter,to:item.chapter,refresh:false,dryRun:true},{loadChapters:async()=>(await loadImportedChapters(this.root,job.story)).chapters});if(!planned.plan.requiredChapters.includes(item.chapter)){progress("artifacts","reused");return{reused:true as const};}const result=await runProduction({root:this.root,story,...input,force,from:item.chapter,to:item.chapter,refresh:false,deferExports:true,resume:true,propagateChapterErrors:true,onProgress:event=>{if(event.type==="production.stage"&&typeof event.stage==="string")progress(event.stage,typeof event.status==="string"?event.status:undefined);} },this.dependencies(story,job.story));const chapter=result.manifest.chapters[String(item.chapter)];if(!chapter)throw new Error(`Production did not report Chapter ${item.chapter}`);return{reused:result.manifest.summary.newStages===0,qaStatus:chapter.qa};});}

  async finalize(job:QueueJob,progress:(stage:string,status?:string)=>void){return withStoryLock(this.root,job.story,`durable production finalization ${job.id}`,async()=>{const story=await loadStory(storyPaths(this.root,job.story,1).storyConfig);const input=queueSubmissionSchema.parse(job.options);const result=await runProduction({root:this.root,story,...input,refresh:false,resume:false,onProgress:event=>{if(event.type==="production.export.started"&&typeof event.stage==="string")progress(event.stage);if(event.type==="production.export.completed"&&typeof event.stage==="string")progress(event.stage,"completed");}},this.dependencies(story,job.story));if(result.manifest.summary.failed||result.manifest.summary.needsReview){const issue=result.manifest.failures.at(-1);throw new Error(issue?.message??"Production finalization found invalid chapter artifacts");}return{};});}

  private dependencies(story:Awaited<ReturnType<typeof loadStory>>,slug:string):ProductionDependencies{return{pipeline:this.runtime.pipeline,loadChapters:async()=>(await loadImportedChapters(this.root,slug)).chapters,refresh:(from,to)=>refreshProductionRange({root:this.root,story,from,to,registry:this.registry}),scenePlanner:this.runtime.router.forStage(story.pipeline.scenePlanner),image:this.runtime.images.forName(story.artwork.provider),video:this.video,videoExport:this.videoExport,audiobook:this.audiobook,alignmentConfig:this.alignConfig,alignmentEngine:this.aligner};}
}

function requiredProviders(story:Awaited<ReturnType<typeof loadStory>>,plan:ProductionPlan,chapter:number){const providers=new Set<string>();const stages=new Set(plan.chapterRequirements[String(chapter)]??[]);if(stages.has("translation"))providers.add(story.pipeline.translation.provider);if(stages.has("narration"))providers.add(story.pipeline.narration.provider);if(stages.has("qa"))providers.add(story.pipeline.qa.provider);if(stages.has("storyBible"))providers.add(story.pipeline.storyBible.provider);if(stages.has("scenePlanning"))providers.add(story.pipeline.scenePlanner.provider);if(stages.has("tts"))providers.add(story.pipeline.tts.provider);if(stages.has("artwork"))providers.add(story.artwork.provider==="openai"?"image":story.artwork.provider);return[...providers];}
function forceAlias(stage?:string){return({storyBible:"story-bible",audioMastering:"audio",scenePlanning:"scenes",videoExport:"video-export"} as Record<string,string>)[stage??""]??stage;}
