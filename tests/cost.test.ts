import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateCost, pricingFor } from "../src/cost/pricing.js";
import { estimatePlanCost } from "../src/cost/estimate.js";
import { PostgresUsageRepository } from "../src/cost/repository.js";
import { TrackedLLMProvider, withUsageScope } from "../src/cost/context.js";
import { DatabasePool } from "../src/queue/database.js";
import { LLMProvider } from "../src/llm/provider.js";

describe("cost calculation",()=>{
  it("prices cached and uncached token usage without double charging cached input",()=>{expect(calculateCost(pricingFor("openai","gpt-5.6-terra"),{inputTokens:1_000_000,cachedInputTokens:250_000,outputTokens:100_000})).toBe(2.75);});
  it("prices Fish by actual UTF-8 bytes and keeps unknown models unavailable",()=>{expect(calculateCost(pricingFor("fish","s2-pro"),{inputUtf8Bytes:2_000_000})).toBe(30);expect(pricingFor("openai","private-fine-tune")).toBeUndefined();expect(calculateCost(undefined,{inputTokens:50})).toBeUndefined();});
  it("prices images by requested quality and size",()=>{expect(calculateCost(pricingFor("openai","gpt-image-1",{quality:"medium",size:"1536x1024"}),{imageCount:2})).toBe(.126);});
  it("builds transparent historical estimates, preserves unknown provider stages, and ignores local work",()=>{const plan:any={counts:{translation:{required:3,reusable:2},tts:{required:2,reusable:3},audioMastering:{required:4,reusable:1}},stages:["translation","tts","audioMastering"]};const result=estimatePlanCost(plan,{dimensions:[{stage:"translation",requests:10,costUsd:2}]});expect(result).toMatchObject({classification:"historical",estimatedUsd:.6,unknownStages:["tts"]});expect(result.breakdown.map(item=>item.stage)).not.toContain("audioMastering");expect(result.assumptions.join(" ")).toMatch(/Cached stages/);});
});

describe("durable usage ledger",()=>{const database=new PGlite();let repository:PostgresUsageRepository;let root:string;
  beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),"cost-ledger-"));await database.exec(await readFile("migrations/001_durable_production_queue.sql","utf8"));await database.exec(await readFile("migrations/003_provider_usage.sql","utf8"));const adapter={query:(text:string,values?:unknown[])=>database.query(text,values)};repository=new PostgresUsageRepository(adapter as unknown as DatabasePool,root);});afterAll(()=>database.close());
  it("captures real provider usage, persists price snapshots, and deduplicates request IDs",async()=>{const provider:LLMProvider={name:"openai",validateConfiguration:async()=>undefined,generateText:async()=>({text:"ok",usage:{inputTokens:1000,cachedTokens:200,outputTokens:100,requestId:"req_cost_1"}}),generateStructured:async(request)=>({value:request.schema.parse({}),usage:{requestId:"req_cost_1"}})};const tracked=new TrackedLLMProvider(provider,repository);await withUsageScope({story:"ledger-story",chapter:7,stage:"translation"},()=>tracked.generateText({model:"gpt-5.6-terra",instructions:"Translate",input:"你好"}));await withUsageScope({story:"ledger-story",chapter:7,stage:"translation"},()=>tracked.generateText({model:"gpt-5.6-terra",instructions:"Translate",input:"你好"}));const records=await repository.list({story:"ledger-story"});expect(records.total).toBe(1);expect(records.items[0]).toMatchObject({inputTokens:1000,cachedInputTokens:200,outputTokens:100,success:true,costStatus:"calculated"});expect(records.items[0]?.pricing?.priceId).toContain("gpt-5.6-terra");});
  it("records failures without inventing token usage or cost",async()=>{const provider:LLMProvider={name:"openai",validateConfiguration:async()=>undefined,generateText:async()=>{throw new Error("boom")},generateStructured:async()=>{throw new Error("boom")}};const tracked=new TrackedLLMProvider(provider,repository);await expect(withUsageScope({story:"ledger-story",chapter:8,stage:"qa"},()=>tracked.generateText({model:"unknown",instructions:"",input:"x"}))).rejects.toThrow("boom");const row=(await repository.list({story:"ledger-story",chapterFrom:8})).items[0]!;expect(row).toMatchObject({success:false,costStatus:"unavailable"});expect(row.inputTokens).toBeUndefined();expect(row.costUsd).toBeUndefined();});
});
