#!/usr/bin/env node
import { loadEnvironment } from "../../src/config/env.js";
import { assertQueueSchema, createDatabasePool } from "../../src/queue/database.js";
import { ProductionQueueService } from "../../src/queue/production-service.js";
import { PostgresQueueRepository } from "../../src/queue/repository.js";

const args=parse(process.argv.slice(2));const env=loadEnvironment();if(!env.DATABASE_URL)throw new Error("DATABASE_URL is required for durable queue submissions");const pool=createDatabasePool(env.DATABASE_URL);try{await assertQueueSchema(pool);const repository=new PostgresQueueRepository(pool,env.QUEUE_EVENT_RETENTION_DAYS);const service=new ProductionQueueService(process.cwd(),env,repository);const job=await service.submit(args.story,{from:args.from,to:args.to,profile:args.profile,outputs:args.outputs});process.stdout.write(`Queued ${job.id}: ${job.story} Chapters ${job.from}–${job.to} (${job.totalItems} chapters require work)\n`);}finally{await pool.end();}
function parse(values:string[]){const value=(name:string)=>{const i=values.indexOf(name);return i>=0?values[i+1]:undefined};const story=value("--story");const from=Number(value("--from"));const to=Number(value("--to"));if(!story||!Number.isInteger(from)||!Number.isInteger(to))throw new Error("Usage: npm run story:queue -- --story <slug> --from <n> --to <n> [--profile <name>]");const output=value("--output");return{story,from,to,profile:value("--profile"),outputs:output?(output==="all"?["audiobook","video"]:[output]):undefined};}
