import { describe, expect, it } from "vitest";
import { videoSettingsSchema } from "../src/video/config.js";
import { buildVideoPresentationTimeline, buildSceneMotionFilter } from "../src/video/presentation.js";
import { buildVideoArgs, validateChapterVideo } from "../src/video/renderer.js";
import { videoFingerprint } from "../src/video/chapter-video.js";

const base = videoSettingsSchema.parse({ width: 640, height: 360, introDurationSeconds: 0, subtitleMode: "none" });
const scenes = [4, 5, 6].map((durationSeconds) => ({ durationSeconds }));
const images = scenes.map((scene, index) => ({ ...scene, path: `scene-${index}.png` }));
const input = { audio: "audio.m4a", audioDurationSeconds: 15, storyTitle: "Story", chapterLabel: "Summary", sceneArtwork: images };

describe("video presentation timeline", () => {
  it("parses legacy video settings with presentation defaults", () => {
    const old = videoSettingsSchema.parse({ width: 640, height: 360, backgroundMode: "kenBurns" });
    expect(old.transition).toEqual({ mode: "dissolve", durationSeconds: 0.5 });
    expect(old.motion).toEqual({ mode: "auto_subtle", intensity: "subtle" });
  });

  it("keeps logical duration and boundary times for every transition mode", () => {
    for (const mode of ["cut", "dissolve", "fade_black", "slide"] as const) {
      const timeline = buildVideoPresentationTimeline(scenes, { ...base, transition: { mode, durationSeconds: 0.5 } });
      expect(timeline.totalDurationSeconds).toBe(15);
      expect(timeline.boundaries.map((boundary) => boundary.boundaryTimeSeconds)).toEqual([4, 9]);
      expect(timeline.scenes.reduce((sum, scene) => sum + scene.visualDurationSeconds, 0) - timeline.boundaries.reduce((sum, boundary) => sum + boundary.effectiveDurationSeconds, 0)).toBeCloseTo(15);
      expect(timeline.boundaries.every((boundary) => boundary.mode === mode)).toBe(true);
    }
  });

  it("clamps short scenes, skips disabled scenes, and resolves outgoing overrides", () => {
    const timeline = buildVideoPresentationTimeline([
      { durationSeconds: 0.6, videoTreatment: { transitionOut: { mode: "slide", durationSeconds: 1 } } },
      { durationSeconds: 10, disabled: true },
      { durationSeconds: 0.8 },
    ], base);
    expect(timeline.totalDurationSeconds).toBeCloseTo(1.4);
    expect(timeline.boundaries).toHaveLength(1);
    expect(timeline.boundaries[0]).toMatchObject({ mode: "slide", effectiveDurationSeconds: 0.15, boundaryTimeSeconds: 0.6 });
    expect(buildVideoPresentationTimeline([{ durationSeconds: 1 }], base).boundaries).toHaveLength(0);
    expect(buildVideoPresentationTimeline([{ durationSeconds: 0.1 }, { durationSeconds: 0.1 }], base).boundaries[0]!.mode).toBe("cut");
  });

  it("resolves auto motion deterministically and respects scene override", () => {
    const a = buildVideoPresentationTimeline([...scenes, ...scenes], base);
    const b = buildVideoPresentationTimeline([...scenes, ...scenes], base);
    expect(a).toEqual(b);
    expect(a.scenes.map((scene) => scene.motion)).toEqual(["zoom_in", "pan_right", "zoom_out", "pan_left", "zoom_in", "pan_right"]);
    expect(buildVideoPresentationTimeline([{ durationSeconds: 1, videoTreatment: { motion: "still" } }], base).scenes[0]!.motion).toBe("still");
    expect(buildSceneMotionFilter({ mode: "pan_up", width: 640, height: 360, fps: 30, durationSeconds: 2, intensity: "normal" })).toContain("zoompan=");
  });

  it("uses the shared FFmpeg graph, keeps intro and subtitle mapping, and fingerprints settings", () => {
    for (const [mode, filter] of [["cut", "concat=n=2:v=1:a=0"], ["dissolve", "xfade=transition=fade"], ["fade_black", "xfade=transition=fadeblack"], ["slide", "xfade=transition=slideleft"]] as const) {
      const settings = { ...base, transition: { mode, durationSeconds: 0.5 } };
      const args = buildVideoArgs(input, "out.mp4", settings).join(" ");
      expect(args).toContain(filter);
      expect(args).toContain("-t 15");
      const chapter = buildVideoArgs({ ...input, subtitles: "subs.srt" }, "out.mp4", { ...settings, introDurationSeconds: 3, subtitleMode: "both" }).join(" ");
      expect(chapter).toContain("-t 18");
      expect(chapter).toContain("mov_text");
      expect(chapter).toContain("subtitles=filename=");
    }
    expect(videoFingerprint("a", "s", "b", base)).not.toBe(videoFingerprint("a", "s", "b", { ...base, transition: { mode: "slide", durationSeconds: 0.5 } }));
    expect(videoFingerprint("a", "s", "b", base)).not.toBe(videoFingerprint("a", "s", "b", { ...base, motion: { mode: "still", intensity: "normal" } }));
    expect(() => validateChapterVideo({ durationSeconds: 14.5, videoCodec: "h264", audioCodec: "aac", width: 640, height: 360, container: "mp4" }, base, 15)).toThrow("does not match");
  });
});
