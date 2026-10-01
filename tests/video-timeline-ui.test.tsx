// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { videoSettingsSchema } from "../src/video/config.js";
import { matchVideoPresentationPreset, videoPresentationPresets } from "../src/video/presets.js";
import { VideoTimelineEditor, applyTreatmentPatch, cleanVideoTreatment, timelineDurationWeight, treatmentDirty, videoSeekTime } from "../apps/web/src/VideoTimelineEditor.js";
import type { Scene } from "../apps/web/src/api.js";

const settings = videoSettingsSchema.parse({ width: 640, height: 360 });
const scene = (id: number, start: number, end: number, extra: Partial<Scene> = {}): Scene => ({ id: `scene-${String(id).padStart(3, "0")}`, summary: `Scene ${id} summary`, startSeconds: start, endSeconds: end, characters: [], visualPrompt: "A scene", importance: "standard", artwork: { status: "missing", review: "unreviewed" } as Scene["artwork"], ...extra });

describe("video timeline editing", () => {
  it("matches preset settings and detects manual deviation", () => {
    expect(matchVideoPresentationPreset(settings)).toBe("audiobook_subtle");
    for (const [id, preset] of Object.entries(videoPresentationPresets)) expect(matchVideoPresentationPreset({ motion: { ...preset.motion }, transition: { ...preset.transition } })).toBe(id);
    expect(matchVideoPresentationPreset({ ...settings, transition: { mode: "slide", durationSeconds: 0.5 } })).toBe("custom");
  });

  it("keeps sparse overrides and bulk operations off disabled and final enabled scenes", () => {
    const scenes = [scene(1, 0, 5), scene(2, 5, 8, { disabled: true }), scene(3, 5, 12)];
    expect(cleanVideoTreatment({ motion: "story_default", transitionOut: { mode: "story_default" } })).toBeUndefined();
    const updated = applyTreatmentPatch(scenes, new Set(scenes.map((item) => item.id)), (_current, hasNext) => ({ motion: "pan_left", ...(hasNext ? { transitionOut: { mode: "slide", durationSeconds: 0.4 } } : {}) }));
    expect(updated[0]!.videoTreatment).toEqual({ motion: "pan_left", transitionOut: { mode: "slide", durationSeconds: 0.4 } });
    expect(updated[1]!.videoTreatment).toBeUndefined();
    expect(updated[2]!.videoTreatment).toEqual({ motion: "pan_left" });
    expect(treatmentDirty(updated[0]!.videoTreatment, scenes[0]!.videoTreatment)).toBe(true);
    expect(treatmentDirty({ motion: "story_default" }, undefined)).toBe(false);
    expect(videoSeekTime(updated[2]!, true)).toBe(4);
    expect([scene(1, 0, 5), scene(2, 5, 15), scene(3, 15, 20)].map((item) => timelineDurationWeight(item, 20))).toEqual([0.25, 0.5, 0.25]);
  });

  it("renders chronological scene cards, effective boundary, and accessible seek controls", () => {
    const scenes = [scene(1, 0, 5, { videoTreatment: { motion: "zoom_in", transitionOut: { mode: "slide" } } }), scene(2, 5, 8, { disabled: true }), scene(3, 5, 12)];
    const html = renderToStaticMarkup(<VideoTimelineEditor scenes={scenes} savedScenes={scenes} settings={settings} onChange={() => undefined} onSaveScene={() => undefined} onSaveAll={() => undefined} />);
    expect(html).toContain("scene-001 → scene-003");
    expect(html).not.toContain("scene-002 →");
    expect(html).toContain("Scene 1 summary");
    expect(html).toContain("Override");
    expect(html).toContain("Save all video changes");
    expect(html).toContain("Seek to transition from scene-001 to scene-003");
  });

  it("highlights the active scene and seeks the existing player from scene and boundary controls", async () => {
    const scenes = [scene(1, 0, 5), scene(2, 5, 12), scene(3, 12, 20)];
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); const ref = createRef<HTMLVideoElement>();
    await act(async () => { root.render(<><video ref={ref} /><VideoTimelineEditor scenes={scenes} savedScenes={scenes} settings={settings} onChange={() => undefined} onSaveScene={() => undefined} onSaveAll={() => undefined} videoRef={ref} currentTime={13} /></>); });
    expect(host.querySelectorAll(".video-scene-card.active")).toHaveLength(1);
    expect(host.querySelector(".video-scene-card.active")?.textContent).toContain("Scene 3");
    await act(async () => { (host.querySelector('[aria-label="Seek video to scene-002"]') as HTMLButtonElement).click(); });
    expect(ref.current?.currentTime).toBe(5);
    await act(async () => { (host.querySelector('[aria-label="Seek to transition from scene-002 to scene-003"]') as HTMLButtonElement).click(); });
    expect(ref.current?.currentTime).toBe(11);
    await act(async () => root.unmount()); host.remove();
  });

  it("reviews retimed chapter scenes without saving derived timing into the plan", async () => {
    const scenes = [scene(1, 0, 8, { videoTreatment: { motion: "pan_left" } }), scene(2, 8, 16)];
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); const ref = createRef<HTMLVideoElement>();
    let saved: Scene | undefined;
    await act(async () => { root.render(<><video ref={ref} /><VideoTimelineEditor scenes={scenes} savedScenes={[scene(1, 0, 8), scenes[1]!]} settings={settings} onChange={() => undefined} onSaveScene={(value) => { saved = value; }} onSaveAll={() => undefined} videoRef={ref} currentTime={4} playbackTimings={{ "scene-001": { startSeconds: 0, endSeconds: 4 }, "scene-002": { startSeconds: 4, endSeconds: 10 } }} /></>); });
    expect(host.querySelector(".video-scene-card.active")?.textContent).toContain("Scene 2");
    await act(async () => { (host.querySelector('[aria-label="Seek video to scene-002"]') as HTMLButtonElement).click(); });
    expect(ref.current?.currentTime).toBe(4);
    await act(async () => { (host.querySelector(".video-scene-card .button.primary") as HTMLButtonElement).click(); });
    expect(saved?.endSeconds).toBe(8);
    await act(async () => root.unmount()); host.remove();
  });
});
