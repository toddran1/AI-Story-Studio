import { AudioSettings } from "./config.js";
import { AUDIO_PROCESSOR_VERSION, AudioProbe, FfmpegTools } from "./ffmpeg.js";
import { AudioError } from "../pipeline/errors.js";

export type MasteringPlan = { args: string[]; expectedDurationSeconds: number };
export interface AudioMasteringProcessor {
  readonly version: string;
  master(inputs: string[], output: string, settings: AudioSettings): Promise<AudioProbe>;
}

export class FfmpegMasteringProcessor implements AudioMasteringProcessor {
  readonly version = AUDIO_PROCESSOR_VERSION;
  constructor(private readonly tools = new FfmpegTools()) {}
  async master(inputs: string[], output: string, settings: AudioSettings): Promise<AudioProbe> {
    if (!inputs.length) throw new AudioError("Audio mastering requires at least one TTS segment");
    await this.tools.validateAvailability(); const inputProbes = await Promise.all(inputs.map((path) => this.tools.probe(path)));
    const plan = buildMasteringPlan(inputs, output, settings, inputProbes.map((probe) => probe.durationSeconds));
    await this.tools.ffmpeg(plan.args); const probe = await this.tools.probe(output); validateMasteredAudio(probe, plan.expectedDurationSeconds);
    return probe;
  }
}

export function buildMasteringPlan(inputs: string[], output: string, settings: AudioSettings, durations: number[]): MasteringPlan {
  if (!inputs.length || inputs.length !== durations.length) throw new AudioError("Mastering inputs and durations must be non-empty and aligned");
  const args: string[] = []; for (const input of inputs) args.push("-i", input);
  const labels: string[] = []; const filters: string[] = [];
  inputs.forEach((_, index) => {
    filters.push(`[${index}:a]aresample=${settings.sampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo[s${index}]`); labels.push(`[s${index}]`);
    if (index < inputs.length - 1 && settings.segmentGapSeconds > 0) { filters.push(`anullsrc=r=${settings.sampleRate}:cl=stereo:d=${settings.segmentGapSeconds}[gap${index}]`); labels.push(`[gap${index}]`); }
  });
  const needsConcat = labels.length > 1; if (needsConcat) filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[joined]`);
  const source = needsConcat ? "[joined]" : labels[0]!;
  filters.push(`${source}loudnorm=I=${settings.loudnessTarget}:TP=${settings.truePeak}:LRA=11,alimiter=limit=${dbToAmplitude(settings.truePeak)}[mastered]`);
  args.push("-filter_complex", filters.join(";"), "-map", "[mastered]", "-ar", String(settings.sampleRate), "-ac", "2", "-c:a", "libmp3lame", "-b:a", settings.bitrate, output);
  return { args, expectedDurationSeconds: durations.reduce((sum, value) => sum + value, 0) + settings.segmentGapSeconds * Math.max(0, inputs.length - 1) };
}

export function validateMasteredAudio(probe: AudioProbe, expectedDurationSeconds: number) {
  if (probe.codec !== "mp3" || !probe.container.toLowerCase().includes("mp3")) throw new AudioError(`Mastered chapter must be MP3, received ${probe.codec}/${probe.container}`);
  if (expectedDurationSeconds > 0 && (probe.durationSeconds < expectedDurationSeconds * 0.75 || probe.durationSeconds > expectedDurationSeconds * 1.35 + 1)) {
    throw new AudioError(`Mastered duration ${probe.durationSeconds.toFixed(2)}s is implausible for ${expectedDurationSeconds.toFixed(2)}s of input`);
  }
}

const dbToAmplitude = (db: number) => Math.pow(10, db / 20).toFixed(6);
