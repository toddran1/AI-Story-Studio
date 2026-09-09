import { spawn } from "node:child_process";
import { AudioError } from "../pipeline/errors.js";

export const AUDIO_PROCESSOR_VERSION = "ffmpeg-audio-v1";
export type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[], timeoutMs?: number) => Promise<CommandResult>;
export type AudioProbe = { durationSeconds: number; codec: string; container: string; sampleRate?: number; bitrate?: number };

export class FfmpegTools {
  constructor(readonly ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg", readonly ffprobePath = process.env.FFPROBE_PATH || "ffprobe", private readonly runner: CommandRunner = runCommand) {}

  async validateAvailability() {
    try { await this.runner(this.ffmpegPath, ["-version"]); await this.runner(this.ffprobePath, ["-version"]); }
    catch (error) { throw new AudioError("FFmpeg and ffprobe are required for audio mastering. Install FFmpeg or set FFMPEG_PATH and FFPROBE_PATH.", { cause: error }); }
  }

  async ffmpeg(args: string[]) {
    try { return await this.runner(this.ffmpegPath, ["-hide_banner", "-nostdin", "-y", ...args]); }
    catch (error) { throw new AudioError(`FFmpeg failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  }

  async probe(path: string): Promise<AudioProbe> {
    let result: CommandResult;
    try { result = await this.runner(this.ffprobePath, ["-v", "error", "-show_entries", "format=duration,format_name,bit_rate:stream=codec_name,codec_type,sample_rate", "-of", "json", path]); }
    catch (error) { throw new AudioError(`ffprobe failed for ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    try {
      const value = JSON.parse(result.stdout) as { format?: { duration?: string; format_name?: string; bit_rate?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; sample_rate?: string }> };
      const stream = value.streams?.find((item) => item.codec_type === "audio"); const durationSeconds = Number(value.format?.duration);
      if (!stream?.codec_name || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("missing a valid audio stream or duration");
      const sampleRate = Number(stream.sample_rate); const bitrate = Number(value.format?.bit_rate);
      return { durationSeconds, codec: stream.codec_name, container: value.format?.format_name ?? "unknown",
        sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : undefined, bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : undefined };
    } catch (error) { throw new AudioError(`Invalid ffprobe output for ${path}`, { cause: error }); }
  }
}

export async function runCommand(command: string, args: string[], timeoutMs = mediaProcessTimeout()): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; let settled = false; let timedOut = false; let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => { if (settled) return; timedOut = true; child.kill("SIGTERM"); killTimer = setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, 5_000); killTimer.unref(); }, timeoutMs); timeout.unref();
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.on("data", (chunk: string) => { stderr = appendLimited(stderr, chunk); });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) => finish(() => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(timedOut ? `${command} timed out after ${timeoutMs}ms` : `${command} exited with ${code ?? signal}: ${stderr.trim().slice(-4000)}`))));
    function finish(action: () => void) { if (settled) return; settled = true; clearTimeout(timeout); if (killTimer) clearTimeout(killTimer); action(); }
  });
}

function appendLimited(current: string, chunk: string) { const next = current + chunk; return next.length > 1_000_000 ? next.slice(-1_000_000) : next; }
function mediaProcessTimeout() { const configured = Number(process.env.MEDIA_PROCESS_TIMEOUT_MS); return Number.isInteger(configured) && configured >= 1_000 ? configured : 30 * 60_000; }
