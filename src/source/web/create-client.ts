import { resolve } from "node:path";
import { Environment } from "../../config/env.js";
import { FileHttpCache } from "./cache.js";
import { WebHttpClient } from "./http-client.js";

export function createWebHttpClient(root: string, env: Environment) {
  return new WebHttpClient({
    timeoutMs: env.WEB_REQUEST_TIMEOUT_MS, requestDelayMs: env.WEB_REQUEST_DELAY_MS,
    maxResponseBytes: env.WEB_MAX_RESPONSE_BYTES, maxRetries: env.WEB_MAX_RETRIES, maintainCookies: true,
    allowedHosts: [
      "fanqienovel.com", "www.fanqienovel.com", "ixdzs8.com", "www.ixdzs8.com", "*.ixdzs8.com", "shuhaige.net", "www.shuhaige.net", "m.shuhaige.net", "*.shuhaige.net",
      "biquge5.com", "www.biquge5.com", "fsshu.com", "www.fsshu.com", "xbiquge345.com", "www.xbiquge345.com",
      "tianyabooks.com", "www.tianyabooks.com",
    ], cache: env.WEB_CACHE_DIR ? new FileHttpCache(resolve(root, env.WEB_CACHE_DIR)) : undefined,
  });
}
