import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { videoSettingsSchema } from "../src/video/config.js";
import { FfmpegVideoProcessor } from "../src/video/renderer.js";

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const available = [ffmpeg, ffprobe].every((command) => spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0);
function generate(args: string[]) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Fixture FFmpeg failed: ${result.stderr}`);
}

describe("real FFmpeg presentation render", () => {
  it.skipIf(!available)("keeps three dissolved scenes aligned with the 15-second audio", async () => {
    const directory = await mkdtemp(join(tmpdir(), "video-presentation-"));
    try {
      const images = ["red", "green", "blue"].map((color, index) => ({ color, path: join(directory, `scene-${index}.png`) }));
      for (const image of images) generate(["-f", "lavfi", "-i", `color=c=${image.color}:s=160x90`, "-frames:v", "1", image.path]);
      const audio = join(directory, "narration.m4a");
      generate(["-f", "lavfi", "-i", "sine=frequency=440:duration=15", "-c:a", "aac", audio]);
      const settings = videoSettingsSchema.parse({ width: 640, height: 360, fps: 24, introDurationSeconds: 0, subtitleMode: "none", motion: { mode: "still", intensity: "subtle" }, transition: { mode: "dissolve", durationSeconds: 0.5 } });
      const probe = await new FfmpegVideoProcessor().render({ audio, audioDurationSeconds: 15, storyTitle: "Test", chapterLabel: "Summary", sceneArtwork: images.map((image, index) => ({ path: image.path, durationSeconds: [4, 5, 6][index]! })) }, join(directory, "out.mp4"), settings);
      expect(probe).toMatchObject({ videoCodec: "h264", audioCodec: "aac", width: 640, height: 360 });
      expect(probe.durationSeconds).toBeCloseTo(15, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
});
