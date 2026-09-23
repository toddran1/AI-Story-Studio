import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdvancedVisualDirection } from "../apps/web/src/AdvancedVisualDirection.js";
import { SceneFilmstrip } from "../apps/web/src/SceneFilmstrip.js";
import { VideoReadinessPanel } from "../apps/web/src/VideoReadinessPanel.js";
import { VisualGroundingPanel } from "../apps/web/src/VisualGroundingPanel.js";

describe("shared Scene Studio UI", () => {
  it("keeps Chapter Story Default and Summary inheritance separate", () => {
    const callbacks = { onDirection: () => undefined, onOverrides: () => undefined };
    const chapter = renderToStaticMarkup(<AdvancedVisualDirection source="chapter" {...callbacks} />);
    const summary = renderToStaticMarkup(<AdvancedVisualDirection source="summary" summaryPreset="Battle Cinematic" {...callbacks} />);
    expect(chapter).toContain("Story Default");
    expect(chapter).not.toContain("Inherit Summary");
    expect(summary).toContain("Inherit Summary · Battle Cinematic");
    for (const html of [chapter, summary]) {
      for (const label of ["Character expressions", "Wardrobe / equipment overrides", "Custom visual prompt", "Custom negative prompt", "Use creature references", "Use location references"]) expect(html).toContain(label);
    }
  });
  it("renders the same filmstrip timing structure for either source", () => {
    const html = renderToStaticMarkup(<SceneFilmstrip scenes={[{ id: "scene-001", summary: "One", startSeconds: 0, endSeconds: 20, importance: "major" }, { id: "scene-002", summary: "Two", startSeconds: 20, endSeconds: 30, disabled: true }]} onSelect={() => undefined} />);
    expect(html).toContain("0:00–0:20"); expect(html).toContain("0:20–0:30"); expect(html).toContain("opacity:0.45");
  });
  it("distinguishes readiness warnings from hard blockers without claiming a render passed", () => {
    const html = renderToStaticMarkup(<VideoReadinessPanel checks={[{ label: "Audio", state: "warning", detail: "Retained stale audio" }, { label: "Artwork", state: "blocker", detail: "Image missing" }]} />);
    expect(html).toContain("1 blocker"); expect(html).toContain("Retained stale audio"); expect(html).toContain("Image missing"); expect(html).toContain("Final file integrity");
  });
  it("does not project current grounding onto an unrecorded historical version", () => {
    const html = renderToStaticMarkup(<VisualGroundingPanel label="v1" recorded={false}><span>Current profile</span></VisualGroundingPanel>);
    expect(html).toContain("grounding was not recorded"); expect(html).not.toContain("Current profile");
  });
});
