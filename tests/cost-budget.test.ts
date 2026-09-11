import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabasePool } from "../src/queue/database.js";
import { PostgresQueueRepository } from "../src/queue/repository.js";

describe("provider budget queue boundary",()=>{const database=new PGlite();let repository:PostgresQueueRepository;
  beforeAll(async()=>{await database.exec(await readFile("migrations/001_durable_production_queue.sql","utf8"));await database.exec(await readFile("migrations/002_queue_lease_fencing.sql","utf8"));const adapter={query:(text:string,values?:unknown[])=>database.query(text,values),connect:async()=>({query:(text:string,values?:unknown[])=>database.query(text,values),release:()=>undefined})};repository=new PostgresQueueRepository(adapter as unknown as DatabasePool);});afterAll(()=>database.close());
  it("returns a claimed chapter to pending and pauses the job without spending an attempt",async()=>{const job=await repository.createJob({story:"budget-story",input:{from:1,to:2,outputs:["audio"],refresh:false,maxProviderBudgetUsd:.01},plan:{},chapters:[{chapter:1},{chapter:2}],maxAttempts:3});const item=await repository.claimNext("budget-worker",60_000);expect(item).toBeTruthy();await repository.pauseForBudget(item!,"Budget reached");expect(await repository.getJob(job.id)).toMatchObject({status:"paused",pauseRequested:true});expect((await repository.listWorkItems(job.id,{page:1,pageSize:10})).items[0]).toMatchObject({status:"pending",attemptCount:0});});
});
