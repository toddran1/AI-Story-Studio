import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioError } from "../pipeline/errors.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { FfmpegTools } from "../audio/ffmpeg.js";
import { TTSProvider } from "./provider.js";
import { TTSRequest, TTSResult } from "./types.js";
import { summarizeQuality } from "./quality-guard.js";

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
export type CensorAssembly = TTSResult & { assembled?: boolean; censor?: { segments: number; durationSeconds: number } };

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
    const files: string[] = []; const segments: Uint8Array[] = []; const requestIds: string[] = []; let providerRequests = 0;
    const qualitySegments: import("./quality-guard.js").TtsSegmentQuality[] = [];
    try {
      for (const [index, segment] of plan.entries()) {
        if (segment.kind === "speech") {
          // The provider only receives ordinary prose, never a censor marker or
          // the literal word "bleep".
          const result = await provider.synthesize({ ...request, text: speechForSynthesis(plan, index), bleepStrongProfanity: false });
          requestIds.push(...(result.requestIds ?? []));
          providerRequests += result.providerRequests ?? result.segments.length;
          // Tone segments have no expected text, so a flattened 1:1 segmentTexts
          // mapping is impossible; the per-speech-chunk quality reports still
          // aggregate honestly (reindexed across calls).
          for (const q of result.quality?.segments ?? []) qualitySegments.push({ ...q, index: qualitySegments.length });
          for (const audio of result.segments.length ? result.segments : [result.audio]) {
            const path = join(directory, `${String(files.length + 1).padStart(4, "0")}.mp3`);
            await atomicWrite(path, audio); files.push(path); segments.push(audio);
          }
        } else {
          const path = join(directory, `${String(files.length + 1).padStart(4, "0")}.mp3`);
          await this.tools.ffmpeg(buildCensorToneArgs(path, request, segment.durationSeconds));
          const audio = await readFile(path); files.push(path); segments.push(audio);
        }
      }
      if (!files.length) throw new AudioError("Censor audio assembly produced no speakable segments");
      const manifest = join(directory, "segments.ffconcat"); const output = join(directory, "assembled.mp3");
      await atomicWrite(manifest, `ffconcat version 1.0\n${files.map((path) => `file '${path.replaceAll("'", "'\\\\''")}'`).join("\n")}\n`);
      await this.tools.ffmpeg(buildCensorConcatArgs(manifest, output, request));
      const audio = await readFile(output);
      if (!audio.length) throw new AudioError("Censor audio assembly produced an empty MP3");
      const summary = qualitySegments.length ? summarizeQuality(qualitySegments) : undefined;
      const quality = summary ? { version: 1 as const, status: summary.status, retried: summary.retried, segments: qualitySegments } : undefined;
      return { audio, segments, requestIds: requestIds.length ? requestIds : undefined, providerRequests, assembled: true,
        ...(quality ? { quality } : {}),
        censor: { segments: censored.length, durationSeconds: censored.reduce((sum, segment) => sum + segment.durationSeconds, 0) } };
    } finally { await rm(directory, { recursive: true, force: true }); }
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
