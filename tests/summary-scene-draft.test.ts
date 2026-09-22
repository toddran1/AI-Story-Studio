import { describe, expect, it } from "vitest";
import type { Scene } from "../src/scenes/types.js";
import { dirtySceneIds, reconcileSceneDrafts, scenePlanStructureDirty } from "../apps/web/src/summary-scene-draft.js";

const scene = (id: string, summary: string): Scene => ({
  id, summary, visualPrompt: summary, characters: [], entityIds: [], importance: "standard",
  startSeconds: id === "scene-001" ? 0 : 5, endSeconds: id === "scene-001" ? 5 : 10,
  artwork: { status: "pending", review: "unreviewed", versions: [] },
});

describe("summary scene drafts", () => {
  it("tracks scene edits independently and preserves a sibling draft after one scene is saved", () => {
    const saved = [scene("scene-001", "A"), scene("scene-002", "B")];
    const draft = [{ ...saved[0]!, summary: "A edited" }, { ...saved[1]!, summary: "B edited" }];
    expect([...dirtySceneIds(draft, saved)]).toEqual(["scene-001", "scene-002"]);
    const persisted = [{ ...saved[0]!, summary: "A edited" }, saved[1]!];
    const afterSavingA = reconcileSceneDrafts(draft, saved, persisted);
    expect(afterSavingA.map((item) => item.summary)).toEqual(["A edited", "B edited"]);
    expect([...dirtySceneIds(afterSavingA, persisted)]).toEqual(["scene-002"]);
    // A failed save leaves the original draft and dirty calculation untouched.
    expect([...dirtySceneIds(draft, saved)]).toEqual(["scene-001", "scene-002"]);
  });

  it("reverts one scene and keeps deletion/reordering as plan-level edits", () => {
    const saved = [scene("scene-001", "A"), scene("scene-002", "B")];
    const draft = [{ ...saved[0]!, visualPrompt: "new prompt" }, { ...saved[1]!, summary: "B edited" }];
    const reverted = draft.map((item) => item.id === "scene-001" ? saved[0]! : item);
    expect([...dirtySceneIds(reverted, saved)]).toEqual(["scene-002"]);
    expect(scenePlanStructureDirty(reverted, saved)).toBe(false);
    expect(scenePlanStructureDirty([...reverted].reverse(), saved)).toBe(true);
    expect(scenePlanStructureDirty(reverted.slice(0, 1), saved)).toBe(true);
    expect(reconcileSceneDrafts([...reverted].reverse(), saved, saved).map((item) => item.id)).toEqual(["scene-002", "scene-001"]);
  });
});
