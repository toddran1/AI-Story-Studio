import { resolve } from "node:path";
import { Environment } from "../../config/env.js";
import { FileHttpCache } from "./cache.js";
import { WebHttpClient } from "./http-client.js";

export function createWebHttpClient(root: string, env: Environment) {
  return new WebHttpClient({
    timeoutMs: env.WEB_REQUEST_TIMEOUT_MS, requestDelayMs: env.WEB_REQUEST_DELAY_MS,
    maxResponseBytes: env.WEB_MAX_RESPONSE_BYTES, maxRetries: env.WEB_MAX_RETRIES,
    allowedHosts: ["fanqienovel.com", "www.fanqienovel.com"], cache: env.WEB_CACHE_DIR ? new FileHttpCache(resolve(root, env.WEB_CACHE_DIR)) : undefined,
  });
}
