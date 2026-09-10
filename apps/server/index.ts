#!/usr/bin/env node
import { createServer } from "node:http";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { createApiHandler } from "./api.js";
import { StudioOperations } from "./operations.js";
import { logger } from "../../src/utils/logger.js";
import { randomUUID } from "node:crypto";
import { assertQueueSchema, createDatabasePool } from "../../src/queue/database.js";
import { PostgresQueueRepository } from "../../src/queue/repository.js";
import { ProductionQueueService } from "../../src/queue/production-service.js";
import { ProductionWorker } from "../../src/queue/worker.js";

const env = loadEnvironment(); const root = resolveStudioRoot(env); const host = "127.0.0.1"; const port = env.WEB_PORT;
const pool = env.DATABASE_URL ? createDatabasePool(env.DATABASE_URL) : undefined;
if (pool) await assertQueueSchema(pool);
const repository = pool ? new PostgresQueueRepository(pool, env.QUEUE_EVENT_RETENTION_DAYS) : undefined;
const queue = repository ? new ProductionQueueService(root, env, repository) : undefined;
const worker = queue ? new ProductionWorker(repository!, queue, { workerId: `web-${process.pid}-${randomUUID()}`, pollMs: env.QUEUE_POLL_MS, leaseMs: env.QUEUE_LEASE_MS, providerSpacingMs: env.PROVIDER_MIN_SPACING_MS }) : undefined;
const operations = new StudioOperations(root, env, undefined, { queue }); const api = createApiHandler(operations);
if (worker) await worker.start(); else logger.warn({ event: "queue.disabled", message: "DATABASE_URL is not configured; production web jobs use the legacy in-memory runner" });
const development = process.argv.includes("--dev");
const vite = development ? await import("vite").then(({ createServer }) => createServer({ server: { host, middlewareMode: true, ws: { host, port: 24678 } }, appType: "spa" })) : undefined;

const server = createServer(async (request, response) => {
  try {
    if (await api(request, response)) return;
    if (vite) return vite.middlewares(request, response, () => { response.writeHead(404); response.end("Not found"); });
    response.writeHead(404); response.end("Run npm run web for the local studio interface.");
  } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
});
server.on("error", (error) => { logger.error({ event: "web.server.failed", host, port, error: error.message }); process.exitCode = 1; void Promise.all([operations.close(), worker?.stop(), pool?.end(), vite?.close()]).catch(() => undefined); });
server.listen(port, host, () => process.stdout.write(`AI Story Studio is running at http://localhost:${port}\nData root: ${root}\n`));

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return; shuttingDown = true; operations.jobs.pauseAll();
  void Promise.all([operations.close(), worker?.stop(), pool?.end(), vite?.close()]).catch((error) => logger.error({ event: "web.server.cleanup_failed", error: error instanceof Error ? error.message : String(error) }));
  server.close();
};
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
