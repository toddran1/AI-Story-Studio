import { ConfigurationError, ProviderError } from "../../pipeline/errors.js";
import { TTSProvider } from "../provider.js";
import { TTSRequest } from "../types.js";
import { splitForTTS } from "../split-text.js";

export class FishAudioProvider implements TTSProvider {
  readonly name = "fish" as const;
  constructor(private readonly apiKey?: string, private readonly fetcher: typeof fetch = fetch) {}
  async validateConfiguration(): Promise<void> { if (!this.apiKey) throw new ConfigurationError("Missing required fish credential (FISH_AUDIO_API_KEY). Add it to .env."); }
  async synthesize(request: TTSRequest) {
    await this.validateConfiguration();
    const segments: Uint8Array[] = []; const requestIds: string[] = [];
    for (const text of splitForTTS(request.text, request.maxCharsPerRequest)) {
      let response: Response;
      try {
        response = await this.fetcher("https://api.fish.audio/v1/tts", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", model: request.model },
          body: JSON.stringify({ text, reference_id: request.referenceId, format: request.format, sample_rate: request.sampleRate,
            mp3_bitrate: request.bitrate, normalize: request.normalize, prosody: { speed: request.speed, volume: 0, normalize_loudness: true } }),
        });
      } catch (error) { throw new ProviderError("Fish Audio network request failed", { cause: error }); }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1000);
        throw new ProviderError(`Fish Audio TTS failed (${response.status}): ${detail}`);
      }
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("trace-id");
      if (requestId) requestIds.push(requestId);
      segments.push(new Uint8Array(await response.arrayBuffer()));
    }
    const length = segments.reduce((sum, segment) => sum + segment.length, 0);
    const audio = new Uint8Array(length); let offset = 0;
    for (const segment of segments) { audio.set(segment, offset); offset += segment.length; }
    return { audio, segments, requestIds };
  }
}
