import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { calculateCost, pricingFor } from "../src/cost/pricing.js";
import { TrackedLLMProvider, TrackedTTSProvider, withUsageScope } from "../src/cost/context.js";
import { PostgresUsageRepository } from "../src/cost/repository.js";
import { allUsageRecords, usageCsv } from "../src/cost/export.js";
import { OpenAIProvider } from "../src/llm/openai/openai.provider.js";
import { GeminiProvider } from "../src/llm/gemini/gemini.provider.js";
import type { DatabasePool } from "../src/queue/database.js";
import type { ProviderUsageRecord } from "../src/cost/types.js";
import { estimatePlanCost } from "../src/cost/estimate.js";
import { testStory } from "./helpers.js";

it("prices free Fish separately and covers the selectable OpenAI text models", () => {
  expect(calculateCost(pricingFor("fish", "s2.1-pro-free"), { inputUtf8Bytes: 1_000_000 })).toBe(0);
  expect(calculateCost(pricingFor("fish", "s2.1-pro"), { inputUtf8Bytes: 1_000_000 })).toBe(15);
  for (const model of ["gpt-6-sol","gpt-6-luna","gpt-6-astra","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna"]) expect(pricingFor("openai", model)).toBeDefined();
  expect(calculateCost(pricingFor("openai","gpt-6-luna"),{outputTokens:10})).toBeUndefined();
});
it("uses the published Gemini promotion boundary and actual image tokens", () => {
  expect(pricingFor("gemini","gemini-3.8-flash",undefined,new Date("2026-12-31T23:59:59Z"))?.outputPerMillion).toBe(3.75);
  expect(pricingFor("gemini","gemini-3.8-flash",undefined,new Date("2027-01-01T00:00:00Z"))?.outputPerMillion).toBe(7.5);
  const image = pricingFor("openai","gpt-image-2.5-flare",{quality:"medium",size:"1536x1024"});
  expect(calculateCost(image,{imageCount:1})).toBeUndefined();
  expect(calculateCost(image,{inputTextTokens:1000,inputImageTokens:2000,outputTokens:1000})).toBe(.051);
  expect(calculateCost(image,{inputTextTokens:1000,inputImageTokens:2000,outputTokens:1000,cachedInputTokens:200})).toBeUndefined();
  expect(calculateCost(pricingFor("gemini","gemini-3.1-flash-image"),{inputTextTokens:1000,inputImageTokens:0,outputTokens:1200,outputImageTokens:1120})).toBe(.06794);
});
it("does not mix effort/model histories for a newly configured production plan", () => {
  const story=testStory();story.pipeline.storyBible={provider:"openai",model:"gpt-6-luna",effort:"high"};
  const plan:any={counts:{storyBible:{required:1,reusable:0}},stages:["storyBible"]};
  const analytics={dimensions:[{stage:"storyBible",provider:"openai",model:"gpt-6-luna",effort:"low",requests:1,costUsd:.1}]};
  expect(estimatePlanCost(plan,analytics,story).classification).toBe("unknown");
});

describe("cost audit persistence", () => {
  const db=new PGlite();let root:string,repository:PostgresUsageRepository;
  beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),"cost-audit-"));for(const file of ["001_durable_production_queue.sql","003_provider_usage.sql"])await db.exec(await readFile(`migrations/${file}`,"utf8"));repository=new PostgresUsageRepository({query:(sql:string,values?:unknown[])=>db.query(sql,values)} as unknown as DatabasePool,root);});
  afterAll(async()=>{await db.close();await rm(root,{recursive:true,force:true});});
  it("includes Gemini thoughts once, records effort, and filters/groups the ledger",async()=>{
    const provider=new GeminiProvider("fake");
    Object.assign(provider,{client:{interactions:{create:async()=>({id:"gemini_audit",output_text:"ok",usage:{total_input_tokens:100,total_output_tokens:20,total_thought_tokens:30}})}}});
    await withUsageScope({story:"audit",chapter:1,stage:"qa"},()=>new TrackedLLMProvider(provider,repository).generateText({model:"gemini-3.8-flash",input:"x",instructions:"x",effort:"low"}));
    const row=(await repository.list({story:"audit",effort:"low"})).items[0]!;
    expect(row).toMatchObject({outputTokens:50,reasoningTokens:30,effort:"low",costUsd:.0002625,costStatus:"calculated"});
    expect(row.durationMs).toBeGreaterThanOrEqual(0);
    const result=await repository.summary({story:"audit",effort:"low"});
    expect(result.summary).toMatchObject({reasoningTokens:30,reasoningReportedRequests:1,ttsInputUtf8Bytes:0});
    expect(result.dimensions[0]).toMatchObject({effort:"low"});
    expect((await repository.list({story:"audit",effort:"high"})).total).toBe(0);
    expect((await repository.list({story:"audit",effort:"not_recorded"})).total).toBe(0);
  });
  it("retains billable OpenAI usage when returned JSON fails local parsing",async()=>{
    const provider=new OpenAIProvider("fake");
    Object.assign(provider,{client:{responses:{create:async()=>({id:"bad_json_audit",output_text:"broken json",usage:{input_tokens:100,output_tokens:50,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:30}}})}}});
    await expect(withUsageScope({story:"audit",chapter:2,stage:"storyBible"},()=>new TrackedLLMProvider(provider,repository).generateStructured({model:"gpt-6-luna",input:"x",instructions:"x",schemaName:"test",schema:z.object({ok:z.boolean()})}))).rejects.toThrow();
    const row=(await repository.list({story:"audit",chapterFrom:2})).items[0]!;
    expect(row).toMatchObject({success:false,inputTokens:100,outputTokens:50,reasoningTokens:30,costUsd:.000035,costStatus:"calculated",requestId:"bad_json_audit",effort:"provider_default"});
    expect((await repository.summary({story:"audit",effort:"provider_default"})).summary.failed).toBe(1);
  });
  it("does not invent a Fish charge for an unreported failed request",async()=>{
    const provider={name:"fish" as const,validateConfiguration:async()=>{},synthesize:async()=>{throw new Error("timeout");}};
    await expect(withUsageScope({story:"audit",chapter:3,stage:"tts"},()=>new TrackedTTSProvider(provider,repository).synthesize({text:"hello",model:"s2.1-pro",speed:1,format:"mp3",sampleRate:44100,bitrate:128,normalize:true,maxCharsPerRequest:1750}))).rejects.toThrow("timeout");
    expect((await repository.list({story:"audit",chapterFrom:3})).items[0]).toMatchObject({success:false,costStatus:"unavailable",costUnavailableReason:expect.stringContaining("billable usage")});
    expect((await repository.list({story:"audit",chapterFrom:3})).items[0]?.costUsd).toBeUndefined();
  });
  it("exports every page and retains effort, reasoning and zero costs in CSV",async()=>{
    const row=(await repository.list({story:"audit"})).items[0]!;
    const fake={list:async(filters:any)=>({items:filters.page===1?Array.from({length:200},()=>row):[{...row,effort:"high",costUsd:0} as ProviderUsageRecord],pages:2})};
    const rows=await allUsageRecords(fake,{});expect(rows).toHaveLength(201);
    const csv=usageCsv(rows);expect(csv.split("\n")).toHaveLength(202);expect(csv).toContain("reasoningTokens");expect(csv).toContain('"high"');expect(csv).toContain('"0"');
  });
});
