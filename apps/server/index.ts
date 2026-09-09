#!/usr/bin/env node
import { createServer } from "node:http";
import { loadEnvironment } from "../../src/config/env.js";
import { createApiHandler } from "./api.js";
import { StudioOperations } from "./operations.js";

const root = process.cwd(); const host = "127.0.0.1"; const port = Number(process.env.WEB_PORT ?? 3000);
const operations = new StudioOperations(root, loadEnvironment()); const api = createApiHandler(operations);
const development = process.argv.includes("--dev");
const vite = development ? await import("vite").then(({ createServer }) => createServer({ server: { host, middlewareMode: true, ws: { host, port: 24678 } }, appType: "spa" })) : undefined;

const server = createServer(async (request, response) => {
  try {
    if (await api(request, response)) return;
    if (vite) return vite.middlewares(request, response, () => { response.writeHead(404); response.end("Not found"); });
    response.writeHead(404); response.end("Run npm run web for the local studio interface.");
  } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
});
server.listen(port, host, () => process.stdout.write(`AI Story Studio is running at http://localhost:${port}\n`));
