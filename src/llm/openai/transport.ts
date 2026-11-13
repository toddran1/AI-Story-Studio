import { Agent } from "undici";

// The SDK's request deadline does not replace the socket connection deadline.
// Share the pool across provider instances without changing other providers.
export const OPENAI_CONNECT_TIMEOUT_MS = 30_000;
const dispatcher = new Agent({ connectTimeout: OPENAI_CONNECT_TIMEOUT_MS, autoSelectFamily: true });

export const openAiTransport = {
  // Match the platform FormData used by the SDK for image edits.
  fetch: globalThis.fetch,
  fetchOptions: { dispatcher },
};
