import { ElevenLabsMusicProvider } from "./elevenlabs.js";
import type { MusicGenerationProvider } from "./types.js";

export function musicProviderRegistry(environment: NodeJS.ProcessEnv = process.env): MusicGenerationProvider[] {
  return environment.ELEVENLABS_API_KEY ? [new ElevenLabsMusicProvider(environment.ELEVENLABS_API_KEY)] : [];
}
export function musicProviderCatalog(environment: NodeJS.ProcessEnv = process.env) {
  return [
    { id: "elevenlabs", displayName: "ElevenLabs Music", configured: Boolean(environment.ELEVENLABS_API_KEY), available: true, models: ["music_v1", "music_v2", "music_v2_5"], capabilities: new ElevenLabsMusicProvider("").capabilities(), guidance: "Set ELEVENLABS_API_KEY on the server. Music API access requires a paid ElevenLabs plan." },
    { id: "suno", displayName: "Suno", configured: Boolean(environment.SUNO_API_KEY), available: false, models: [], capabilities: { generation: false, asyncGeneration: false, instrumentalControl: false, durationControl: false, loopingControl: false, structuredComposition: false, searchCatalog: false, commercialUseMetadata: false }, guidance: "Suno's developer platform is sign-in gated; this integration needs an accessible official endpoint contract before it can be enabled." },
  ];
}
