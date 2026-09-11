import { ConfigurationError, ProviderError } from "../../pipeline/errors.js";
import { TTSProvider } from "../provider.js";
import { TTSRequest } from "../types.js";
import { splitForTTS } from "../split-text.js";

export class FishAudioProvider implements TTSProvider {
  readonly name = "fish" as const;
  constructor(
    private readonly apiKey?: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 120_000,
    private readonly defaultReferenceId?: string,
  ) {}

  resolveReferenceId(referenceId?: string): string | undefined {
    return referenceId?.trim() || this.defaultReferenceId;
  }

  async validateConfiguration(): Promise<void> { if (!this.apiKey) throw new ConfigurationError("Missing required fish credential (FISH_AUDIO_API_KEY). Add it to .env."); }
  async synthesize(request: TTSRequest) {
    await this.validateConfiguration();
    const referenceId = this.resolveReferenceId(request.referenceId);
    const segments: Uint8Array[] = []; const requestIds: string[] = [];
    for (const text of splitForTTS(request.text, request.maxCharsPerRequest)) {
      let response: Response;
      try {
        response = await this.fetcher("https://api.fish.audio/v1/tts", {
          method: "POST",
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", model: request.model },
          body: JSON.stringify({ text, reference_id: referenceId, format: request.format, sample_rate: request.sampleRate,
            mp3_bitrate: request.bitrate, normalize: request.normalize, prosody: { speed: request.speed, volume: 0, normalize_loudness: true },
            ...fishS2Defaults(request.model) }),
        });
      } catch (error) { throw new ProviderError("Fish Audio network request failed", { cause: error }); }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1000); const cause = Object.assign(new Error(detail), { status: response.status, headers: response.headers });
        throw new ProviderError(`Fish Audio TTS failed (${response.status}): ${detail}`, { cause });
      }
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("trace-id");
      if (requestId) requestIds.push(requestId);
      const contentType = response.headers.get("content-type")?.toLowerCase();
      if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") throw new ProviderError(`Fish Audio returned unexpected content type: ${contentType}`);
      const audio = new Uint8Array(await response.arrayBuffer());
      if (!audio.length) throw new ProviderError("Fish Audio returned an empty audio response");
      segments.push(audio);
    }
    const length = segments.reduce((sum, segment) => sum + segment.length, 0);
    const audio = new Uint8Array(length); let offset = 0;
    for (const segment of segments) { audio.set(segment, offset); offset += segment.length; }
    return { audio, segments, requestIds };
  }
}

/** Documented S2/S2.1 production defaults. Other/unknown models retain the portable request shape. */
function fishS2Defaults(model: string) {
  if (!new Set(["s2-pro", "s2.1-pro", "s2.1-pro-free"]).has(model.trim().toLowerCase())) return {};
  return { temperature: 0.7, top_p: 0.7, chunk_length: 300, latency: "normal", max_new_tokens: 1024,
    repetition_penalty: 1.2, min_chunk_length: 50, condition_on_previous_chunks: true, early_stop_threshold: 1 };
}
