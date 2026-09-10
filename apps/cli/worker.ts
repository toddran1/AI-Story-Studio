#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { loadEnvironment } from "../../src/config/env.js";
import { assertQueueSchema, createDatabasePool } from "../../src/queue/database.js";
import { ProductionQueueService } from "../../src/queue/production-service.js";
import { PostgresQueueRepository } from "../../src/queue/repository.js";
import { ProductionWorker } from "../../src/queue/worker.js";

const env=loadEnvironment();if(!env.DATABASE_URL)throw new Error("DATABASE_URL is required for the production worker");const pool=createDatabasePool(env.DATABASE_URL);await assertQueueSchema(pool);const repository=new PostgresQueueRepository(pool,env.QUEUE_EVENT_RETENTION_DAYS);const service=new ProductionQueueService(process.cwd(),env,repository);const worker=new ProductionWorker(repository,service,{workerId:`cli-${process.pid}-${randomUUID()}`,pollMs:env.QUEUE_POLL_MS,leaseMs:env.QUEUE_LEASE_MS,providerSpacingMs:env.PROVIDER_MIN_SPACING_MS});await worker.start();process.stdout.write("Durable production worker started. Press Ctrl+C to stop after the current safe unit.\n");const stop=async()=>{await worker.stop();await pool.end();process.exit(0)};process.once("SIGINT",()=>void stop());process.once("SIGTERM",()=>void stop());
