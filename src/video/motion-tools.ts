import { readFile } from "node:fs/promises";
import { CommandRunner, runCommand } from "../audio/ffmpeg.js";
import { imageDimensions } from "../artwork/resolution.js";
export type MotionProbe = { durationSeconds: number; width: number; height: number };
export class FfmpegMotionTools {
  constructor(private readonly runner: CommandRunner = runCommand, private readonly ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", private readonly ffprobe = process.env.FFPROBE_PATH || "ffprobe") {}
  async probe(path: string): Promise<MotionProbe> {
    const result = await this.runner(this.ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", path]);
    const value = JSON.parse(result.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
    const video = value.streams?.find(s => s.codec_type === "video"); const durationSeconds = Number(value.format?.duration);
    if (!video?.width || !video.height || video.width > 8192 || video.height > 8192 || video.width * video.height > 34_000_000 || !Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 12.1) throw new Error("Motion clips require a 1–12 second MP4 with dimensions up to 8192 pixels (34 megapixels).");
    return { width: video.width, height: video.height, durationSeconds: Math.min(12, durationSeconds) };
  }
  async normalize(source: string, output: string, width: number, height: number) {
    const probe = await this.probe(source);
    await this.runner(this.ffmpeg, ["-hide_banner", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov", "-i", source, "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x11131a,setsar=1,fps=24`, "-t", String(probe.durationSeconds), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output]);
    return { ...probe, width, height };
  }
  async frames(video: string, duration: number, paths: string[]) {
    for (const [index, path] of paths.entries()) {
      const time = index === 0 ? 0 : index === 1 ? duration / 2 : Math.max(0, duration - .15);
      await this.runner(this.ffmpeg, ["-hide_banner", "-nostdin", "-y", "-ss", String(time), "-i", video, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=1280:1280:force_original_aspect_ratio=decrease", path]);
    }
  }
  async parallax(background: string, foreground: string, output: string, duration: number, width: number, height: number) {
    for (const path of [background, foreground]) {
      const data = await readFile(path); const dimensions = imageDimensions(data);
      if (!dimensions || dimensions.width > 8192 || dimensions.height > 8192 || dimensions.width * dimensions.height > 34_000_000) throw new Error("Parallax layers must be bounded PNG images.");
    }
    // Background is clean artwork; foreground is a separately prepared alpha
    // cutout. No duplicated character, guessed depth or synthesized anatomy.
    const graph = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x11131a,setsar=1[bg];[1:v]format=rgba,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,scale=${Math.floor(width * .98 / 2) * 2}:${Math.floor(height * .98 / 2) * 2}[fg];[bg][fg]overlay=x='(W-w)/2+${Math.round(width * .006)}*sin(t*PI/${duration})':y='(H-h)/2':eval=frame,format=yuv420p[out]`;
    await this.runner(this.ffmpeg, ["-hide_banner", "-nostdin", "-y", "-loop", "1", "-framerate", "24", "-i", background, "-loop", "1", "-framerate", "24", "-i", foreground, "-filter_complex", graph, "-map", "[out]", "-an", "-t", String(duration), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output]);
    return { durationSeconds: duration, width, height };
  }
}
