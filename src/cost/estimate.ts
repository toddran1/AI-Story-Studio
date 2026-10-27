import type { Story } from "../domain/story.js";
import { pricingFor } from "./pricing.js";
import { ProductionPlan } from "../production/types.js";

export type CostEstimate = { classification:"historical"|"unknown"|"exact"; estimatedUsd?:number; lowUsd?:number; highUsd?:number; confidence:"high"|"medium"|"low"; assumptions:string[]; unknownStages:string[]; breakdown:Array<{stage:string;required:number;estimatedUsd?:number;basis:string}> };
const providerStages = new Set(["translation", "narration", "qa", "storyBible", "scenePlanning", "tts", "artwork"]);
export function estimatePlanCost(plan:ProductionPlan,analytics:{dimensions:Array<{stage:string;requests:number;costUsd:number|string;provider?:string;model?:string;effort?:string}>},story?: Pick<Story,"pipeline"|"artwork">):CostEstimate{
  const breakdown:CostEstimate["breakdown"]=[],unknownStages:string[]=[];let total=0,known=0;
  for(const [stage,count] of Object.entries(plan.counts)){if(!count.required||!providerStages.has(stage))continue;const config = story ? stage === "artwork" ? story.artwork : story.pipeline[stage === "scenePlanning" ? "scenePlanner" : stage as keyof Story["pipeline"]] : undefined;
    if (config && stage === "tts" && pricingFor(config.provider,config.model)?.utf8BytesPerMillion === 0) { known++; breakdown.push({stage,required:count.required,estimatedUsd:0,basis:"Published zero-rate speech model"}); continue; }
    const effort = config && "effort" in config ? config.effort : undefined;
    const history=analytics.dimensions.filter(item=>item.stage===stage&&Number(item.costUsd)>0&&(!config || item.provider===config.provider && item.model===config.model && (["tts","artwork"].includes(stage) || item.effort===(effort??"provider_default"))));const requests=history.reduce((sum,item)=>sum+Number(item.requests),0),cost=history.reduce((sum,item)=>sum+Number(item.costUsd),0);if(!requests){unknownStages.push(stage);breakdown.push({stage,required:count.required,basis:"No priced history"});continue;}const estimate=cost/requests*count.required;total+=estimate;known++;breakdown.push({stage,required:count.required,estimatedUsd:estimate,basis:`Historical average across ${requests} request${requests===1?"":"s"}`});}
  if(!known)return{classification:"unknown",confidence:"low",assumptions:["No priced usage history is available for the required stages."],unknownStages,breakdown};
  total=Math.round(total*1e9)/1e9;const confidence=unknownStages.length?"low":analytics.dimensions.reduce((sum,item)=>sum+Number(item.requests),0)>=20?"high":"medium";return{classification:"historical",estimatedUsd:total,lowUsd:total*.75,highUsd:total*1.35,confidence,assumptions:["Uses this story's recorded average cost per provider request; configured model and effort must match when supplied.","Range is directional; output length, retries, and provider billing can vary.","Cached stages in the production plan are excluded."],unknownStages,breakdown};
}
