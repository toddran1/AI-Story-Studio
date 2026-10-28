import { Agent, fetch } from "undici";

// The SDK's request deadline does not replace the socket connection deadline.
// Share the pool across provider instances without changing other providers.
export const OPENAI_CONNECT_TIMEOUT_MS = 30_000;
const dispatcher = new Agent({ connectTimeout: OPENAI_CONNECT_TIMEOUT_MS, autoSelectFamily: true });

export const openAiTransport = {
  fetch: fetch as unknown as typeof globalThis.fetch,
  fetchOptions: { dispatcher },
};
