import { access, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand, CommandRunner } from "../audio/ffmpeg.js";
import { ConfigurationError } from "../pipeline/errors.js";
import { AlignmentEngine, AlignmentObservation, AlignmentRequest } from "./types.js";

export const WHISPER_CPP_ALIGNMENT_VERSION = "whisper-cpp-json-v1";

export class WhisperCppAlignmentEngine implements AlignmentEngine {
  readonly name = "whisper-cpp";
  readonly version = WHISPER_CPP_ALIGNMENT_VERSION;
  private validation?: Promise<void>;
  constructor(private readonly executable = "whisper-cli", private readonly configuredModel?: string, private readonly timeoutMs = 1_800_000, private readonly runner: CommandRunner = runCommand) {}

  validateConfiguration() { return this.validation ??= this.checkConfiguration(); }

  private async checkConfiguration() {
    if (!this.configuredModel) throw new ConfigurationError("Whisper.cpp alignment requires ALIGNMENT_MODEL to point to a local ggml model file");
    try { await access(this.configuredModel); } catch (error) { throw new ConfigurationError(`Whisper.cpp alignment model was not found at ${this.configuredModel}`, { cause: error }); }
    // Metal/BLAS backend discovery can be slow on the first launch, especially when
    // the model and application data live on an external volume.
    try { await this.runner(this.executable, ["--help"], Math.min(this.timeoutMs, 60_000)); } catch (error) { throw new ConfigurationError(`Whisper.cpp executable '${this.executable}' is unavailable. Install whisper.cpp or set ALIGNMENT_EXECUTABLE.`, { cause: error }); }
  }

  async align(request: AlignmentRequest): Promise<AlignmentObservation[]> {
    await this.validateConfiguration();
    const directory = join(dirname(request.audioPath), `.alignment-${randomUUID()}`); const output = join(directory, "whisper");
    await mkdir(directory, { recursive: true });
    try {
      const args = ["-m", request.model ?? this.configuredModel!, "-f", request.audioPath, "-ojf", "-of", output, "-np", "-sow", "-ml", "1", "-l", languageCode(request.language)];
      if (request.device === "cpu") args.push("-ng");
      await this.runner(this.executable, args, this.timeoutMs);
      const parsed = JSON.parse(await readFile(`${output}.json`, "utf8"));
      const words = parseWhisperJson(parsed);
      if (!words.length) throw new Error("Whisper.cpp produced no timestamped speech tokens");
      return words;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

export function parseWhisperJson(value: unknown): AlignmentObservation[] {
  const root = record(value); const transcription = Array.isArray(root?.transcription) ? root.transcription : Array.isArray(root?.segments) ? root.segments : [];
  const result: AlignmentObservation[] = [];
  for (const rawSegment of transcription) {
    const segment = record(rawSegment); if (!segment) continue; const segmentBounds = bounds(segment);
    const tokens = Array.isArray(segment.tokens) ? segment.tokens : [];
    const parsedTokens = tokens.map((raw): AlignmentObservation | undefined => { const token = record(raw); if (!token) return undefined; const text = String(token.text ?? token.word ?? "").trim(); const time = bounds(token); if (!text || /^\[.*\]$/.test(text) || !time) return undefined; const confidence = probability(token); return { text, start: time.start, end: time.end, ...(confidence === undefined ? {} : { confidence }) }; }).filter((item): item is AlignmentObservation => Boolean(item));
    if (parsedTokens.length) { result.push(...parsedTokens); continue; }
    const text = String(segment.text ?? "").trim(); if (!text || !segmentBounds) continue; const words = text.split(/\s+/).filter(Boolean); const step = (segmentBounds.end - segmentBounds.start) / Math.max(1, words.length);
    words.forEach((word, index) => result.push({ text: word, start: segmentBounds.start + step * index, end: segmentBounds.start + step * (index + 1), confidence: probability(segment) }));
  }
  return result.filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start).sort((a, b) => a.start - b.start);
}

function record(value: unknown): Record<string, any> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined; }
function bounds(value: Record<string, any>) {
  const offsets = record(value.offsets); const timestamps = record(value.timestamps);
  const start = seconds(offsets?.from, true) ?? seconds(timestamps?.from) ?? seconds(value.start) ?? seconds(value.t0, true, 100);
  const end = seconds(offsets?.to, true) ?? seconds(timestamps?.to) ?? seconds(value.end) ?? seconds(value.t1, true, 100);
  return start !== undefined && end !== undefined && end > start ? { start, end } : undefined;
}
function seconds(value: unknown, milliseconds = false, divisor = 1000): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return milliseconds ? value / divisor : value;
  if (typeof value !== "string") return undefined; const numeric = Number(value); if (Number.isFinite(numeric)) return milliseconds ? numeric / divisor : numeric;
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value.trim()); if (!match) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]!.padEnd(3, "0")) / 1000;
}
function probability(value: Record<string, any>) { const raw = value.p ?? value.probability ?? value.confidence; const parsed = Number(raw); return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : undefined; }
function languageCode(value: string) { return value.trim().toLowerCase().split(/[-_]/)[0] || "auto"; }
