import type { MusicGenerationProvider, MusicGenerationRequest, MusicGenerationResult } from "./types.js";

export class ElevenLabsMusicProvider implements MusicGenerationProvider {
  readonly id = "elevenlabs"; readonly displayName = "ElevenLabs Music";
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}
  capabilities() { return { generation: true, asyncGeneration: false, instrumentalControl: true, durationControl: true, loopingControl: false, structuredComposition: true, searchCatalog: false, commercialUseMetadata: false, maxDurationSeconds: 600 }; }
  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    const model = request.model ?? "music_v2_5";
    if (!["music_v1", "music_v2", "music_v2_5"].includes(model)) throw new Error("Unsupported ElevenLabs music model");
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
      const response = await this.fetcher("https://api.elevenlabs.io/v1/music?output_format=auto", { method: "POST", headers: { "xi-api-key": this.apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ prompt: request.prompt, music_length_ms: request.durationSeconds ? request.durationSeconds * 1000 : undefined, model_id: model, force_instrumental: request.instrumental }), signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 429 ? "ElevenLabs Music rate limit reached. Try again later." : response.status === 402 ? "ElevenLabs Music requires available paid credits." : response.status === 401 || response.status === 403 ? "ElevenLabs Music credentials or plan do not permit generation." : response.status === 422 ? "ElevenLabs Music rejected this prompt or request. Edit the prompt and retry." : `ElevenLabs Music request failed (${response.status}).`);
      const size = Number(response.headers.get("content-length") ?? "0"); if (size > 100_000_000) throw new Error("Generated music exceeds the 100 MB limit");
      if (!response.body) throw new Error("ElevenLabs Music returned no audio"); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 100_000_000) throw new Error("Generated music exceeds the 100 MB limit"); chunks.push(value); } } finally { await reader.cancel().catch(() => undefined); }
      const audio = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; } if (!audio.length) throw new Error("Generated music is empty");
      return { audio, providerGenerationId: response.headers.get("song-id") ?? undefined, model };
    } catch (error) { if (controller.signal.aborted) throw new Error("ElevenLabs Music generation timed out."); throw error; }
    finally { clearTimeout(timeout); }
  }
}
