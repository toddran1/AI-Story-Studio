import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioError } from "../pipeline/errors.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { FfmpegTools } from "../audio/ffmpeg.js";
import { TTSProvider } from "./provider.js";
import { TTSRequest, TTSResult } from "./types.js";
import { summarizeQuality } from "./quality-guard.js";

import { z } from "zod";

export const CENSOR_AUDIO_VERSION = "censor-tone-v2";
export const CENSOR_BLEEP_MARKER = "[CENSOR_BLEEP]" as const;
export const censorToneConfig = {
  frequencyHz: 1000,
  minimumDurationSeconds: 0.25,
  maximumDurationSeconds: 0.55,
  charactersPerSecond: 40,
  volume: 0.55,
  fadeSeconds: 0.012,
  speechBoundaryPunctuation: ",",
} as const;

export type CensorSegment = { kind: "speech"; text: string } | { kind: "censor"; marker: typeof CENSOR_BLEEP_MARKER; original: string; durationSeconds: number };

export const censorManifestItemSchema = z.union([
  z.object({ kind: z.literal("speech"), speechIndex: z.number().int().min(0) }),
  z.object({ kind: z.literal("tone"), durationSeconds: z.number().positive(), original: z.string() }),
]);
export type CensorManifestItem = z.infer<typeof censorManifestItemSchema>;

export const censorManifestSchema = z.object({
  version: z.literal(1),
  items: z.array(censorManifestItemSchema),
});
export type CensorManifest = z.infer<typeof censorManifestSchema>;

export type CensorAssembly = TTSResult & {
  assembled?: boolean;
  censor?: { segments: number; durationSeconds: number };
  censorManifest?: CensorManifest;
};

// Kept separate from narration rewriting: this is an audio-only segmentation
// rule and deliberately leaves the stored manuscript untouched.
const strongWord = /(?<![\p{L}\p{N}_])(?:motherfuck(?:ers?|ing|ed|s)?|fuck(?:ers?|ing|ed|s)?|bitch(?:es|ing|y|s)?|bullshit(?:ting|ted|s)?|shitheads?|shitting|shitty|shits?|cunts?)(?![\p{L}\p{N}_])/giu;

export function planCensoredSpeech(text: string): CensorSegment[] {
  const segments: CensorSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(strongWord)) {
    const start = match.index ?? 0;
    const speech = text.slice(cursor, start).trim();
    if (speech) segments.push({ kind: "speech", text: speech });
    const original = match[0];
    segments.push({ kind: "censor", marker: CENSOR_BLEEP_MARKER, original, durationSeconds: censorDuration(original) });
    // A tone already supplies the interruption/pause implied by punctuation.
    // Consume punctuation directly following the censored word so a provider is
    // never asked to synthesize a meaningless standalone "." or "!" chunk.
    const afterWord = start + original.length;
    const punctuation = /^(?:[,.!?;:。！？；：]+\s*)/.exec(text.slice(afterWord));
    cursor = afterWord + (punctuation?.[0].length ?? 0);
  }
  const tail = text.slice(cursor).trim();
  if (tail) segments.push({ kind: "speech", text: tail });
  return segments;
}

export function censorDuration(word: string, config = censorToneConfig): number {
  return clamp(config.minimumDurationSeconds, config.maximumDurationSeconds, 0.25 + [...word].length / config.charactersPerSecond);
}

export function buildCensorToneArgs(output: string, request: Pick<TTSRequest, "sampleRate" | "bitrate">, durationSeconds: number, config = censorToneConfig): string[] {
  const fade = Math.min(config.fadeSeconds, durationSeconds / 4);
  const fadeOutStart = Math.max(0, durationSeconds - fade);
  return ["-f", "lavfi", "-i", `sine=frequency=${config.frequencyHz}:sample_rate=${request.sampleRate}:duration=${durationSeconds}`,
    "-af", `afade=t=in:st=0:d=${fade},afade=t=out:st=${fadeOutStart}:d=${fade},volume=${config.volume}`,
    "-ac", "2", "-ar", String(request.sampleRate), "-c:a", "libmp3lame", "-b:a", `${request.bitrate}k`, output];
}

export function buildCensorConcatArgs(manifest: string, output: string, request: Pick<TTSRequest, "sampleRate" | "bitrate">): string[] {
  return ["-f", "concat", "-safe", "0", "-i", manifest, "-ar", String(request.sampleRate), "-ac", "2", "-c:a", "libmp3lame", "-b:a", `${request.bitrate}k`, output];
}

export interface CensorAudioService {
  readonly version: string;
  synthesize(provider: TTSProvider, request: TTSRequest): Promise<CensorAssembly>;
  reassemble?(segmentsDir: string, manifest: CensorManifest, output: string, request: Pick<TTSRequest, "sampleRate" | "bitrate">): Promise<void>;
}

export class FfmpegCensorAudioService implements CensorAudioService {
  readonly version = CENSOR_AUDIO_VERSION;
  constructor(private readonly tools = new FfmpegTools()) {}

  async synthesize(provider: TTSProvider, request: TTSRequest): Promise<CensorAssembly> {
    if (!request.bleepStrongProfanity) return provider.synthesize(request);
    const plan = planCensoredSpeech(request.text);
    const censored = plan.filter((segment): segment is Extract<CensorSegment, { kind: "censor" }> => segment.kind === "censor");
    if (!censored.length) return provider.synthesize(request);
    await this.tools.validateAvailability();
    const directory = await mkdtemp(join(tmpdir(), "ai-story-censor-"));
    const files: string[] = [];
    const segments: Uint8Array[] = [];
    const speechSegments: Uint8Array[] = [];
    const speechSegmentTexts: string[] = [];
    const censorManifest: CensorManifest = { version: 1, items: [] };
    const requestIds: string[] = [];
    let providerRequests = 0;
    let generatedCharacters = 0;
    let generatedUtf8Bytes = 0;
    const qualitySegments: import("./quality-guard.js").TtsSegmentQuality[] = [];
    try {
      for (const [index, segment] of plan.entries()) {
        if (segment.kind === "speech") {
          const speechText = speechForSynthesis(plan, index);
          const result = await provider.synthesize({ ...request, text: speechText, bleepStrongProfanity: false });
          requestIds.push(...(result.requestIds ?? []));
          providerRequests += result.providerRequests ?? result.segments.length;
          generatedCharacters += result.generatedCharacters ?? [...speechText].length;
          generatedUtf8Bytes += result.generatedUtf8Bytes ?? Buffer.byteLength(speechText);
          for (const q of result.quality?.segments ?? []) qualitySegments.push({ ...q, index: qualitySegments.length });
          const segmentList = result.segments.length ? result.segments : [result.audio];
          const textList = result.segmentTexts?.length === segmentList.length ? result.segmentTexts : [speechText];
          for (let i = 0; i < segmentList.length; i++) {
            const audio = segmentList[i]!;
            const text = textList[i]!;
            const speechIndex = speechSegments.length;
            speechSegments.push(audio);
            speechSegmentTexts.push(text);
            censorManifest.items.push({ kind: "speech", speechIndex });
            const path = join(directory, `${String(files.length + 1).padStart(4, "0")}.mp3`);
            await atomicWrite(path, audio);
            files.push(path);
            segments.push(audio);
          }
        } else {
          censorManifest.items.push({ kind: "tone", durationSeconds: segment.durationSeconds, original: segment.original });
          const path = join(directory, `${String(files.length + 1).padStart(4, "0")}.mp3`);
          await this.tools.ffmpeg(buildCensorToneArgs(path, request, segment.durationSeconds));
          const audio = await readFile(path);
          files.push(path);
          segments.push(audio);
        }
      }
      if (!files.length) throw new AudioError("Censor audio assembly produced no speakable segments");
      const manifest = join(directory, "segments.ffconcat");
      const output = join(directory, "assembled.mp3");
      await atomicWrite(manifest, `ffconcat version 1.0\n${files.map((path) => `file '${path.replaceAll("'", "'\\\\''")}'`).join("\n")}\n`);
      await this.tools.ffmpeg(buildCensorConcatArgs(manifest, output, request));
      const audio = await readFile(output);
      if (!audio.length) throw new AudioError("Censor audio assembly produced an empty MP3");
      const summary = qualitySegments.length ? summarizeQuality(qualitySegments) : undefined;
      const quality = summary ? { version: 1 as const, status: summary.status, retried: summary.retried, segments: qualitySegments } : undefined;
      return {
        audio,
        segments: speechSegments,
        segmentTexts: speechSegmentTexts,
        requestIds: requestIds.length ? requestIds : undefined,
        providerRequests,
        generatedCharacters,
        generatedUtf8Bytes,
        assembled: true,
        censorManifest,
        ...(quality ? { quality } : {}),
        censor: { segments: censored.length, durationSeconds: censored.reduce((sum, segment) => sum + segment.durationSeconds, 0) },
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async reassemble(segmentsDir: string, manifest: CensorManifest, output: string, request: Pick<TTSRequest, "sampleRate" | "bitrate">): Promise<void> {
    await this.tools.validateAvailability();
    const directory = await mkdtemp(join(tmpdir(), "ai-story-censor-reassemble-"));
    const files: string[] = [];
    try {
      for (const [index, item] of manifest.items.entries()) {
        if (item.kind === "speech") {
          const path = join(segmentsDir, `${String(item.speechIndex + 1).padStart(4, "0")}.mp3`);
          files.push(path);
        } else {
          const path = join(directory, `tone-${index}.mp3`);
          await this.tools.ffmpeg(buildCensorToneArgs(path, request, item.durationSeconds));
          files.push(path);
        }
      }
      if (!files.length) throw new AudioError("Censor audio reassembly produced no segments");
      const manifestFile = join(directory, "segments.ffconcat");
      await atomicWrite(manifestFile, `ffconcat version 1.0\n${files.map((path) => `file '${path.replaceAll("'", "'\\\\''")}'`).join("\n")}\n`);
      await this.tools.ffmpeg(buildCensorConcatArgs(manifestFile, output, request));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function clamp(minimum: number, maximum: number, value: number) { return Math.max(minimum, Math.min(maximum, value)); }

function speechForSynthesis(plan: CensorSegment[], index: number) {
  const segment = plan[index];
  if (!segment || segment.kind !== "speech") throw new AudioError("Invalid censor speech segment");
  const text = segment.text.trim();
  // A clipped open-ended phrase can make some models trail into the removed
  // word. Give every pre-censor chunk a neutral spoken boundary; this remains
  // internal and does not alter narration, subtitles, or canonical text.
  return plan[index + 1]?.kind === "censor" && !/[,.!?;:。！？；：]$/.test(text)
    ? `${text}${censorToneConfig.speechBoundaryPunctuation}`
    : text;
}
