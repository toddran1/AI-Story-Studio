import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EntityImpactDialog, canonicalEntityDiff, canonicalEntityPatchImpact, cleanupOriginLabel, defaultCleanupSelection, impactEstimateLines, pageSelectionState, toggleEntitySelection } from "../apps/web/src/App.js";
import type { EntityImpact } from "../apps/web/src/api.js";

const impact = (patch: Partial<EntityImpact> = {}): EntityImpact => ({
  affectedChapters: [], narrationAffected: 0, qaAffected: 0, ttsAffected: 0, audioAffected: 0,
  scenePlanningAffected: 0, artworkAffected: 0, videoAffected: 0,
  manualNarrationChapters: [], visualProfileAffected: false, continuityAffected: 0, warnings: [], ...patch,
});

const entity = (patch: Record<string, unknown> = {}) => ({
  id: "ent_0123456789abcdef01234567", type: "character", canonicalName: "Su Ming", aliases: ["Ming"],
  preferredNarrationName: undefined, aliasNarrationRules: [], localizedNaming: undefined, pronunciation: undefined,
  canonicalNameLocked: false, status: "alive", notes: "", ...patch,
});

describe("entity impact predicate (which edits skip the preview)", () => {
  it("treats notes, status, lock toggle, and alias edits as harmless", () => {
    const before = entity();
    expect(canonicalEntityPatchImpact(before, { notes: "new note" }).impactful).toBe(false);
    expect(canonicalEntityPatchImpact(before, { status: "dead" }).impactful).toBe(false);
    expect(canonicalEntityPatchImpact(before, { canonicalNameLocked: true }).impactful).toBe(false);
    expect(canonicalEntityPatchImpact(before, { aliases: ["Ming", "Big Ming"] }).impactful).toBe(false);
    expect(canonicalEntityPatchImpact(before, { preferredNarrationName: null }).impactful).toBe(false);
  });
  it("flags naming, pronunciation, type, and rename edits as high-impact", () => {
    const before = entity();
    expect(canonicalEntityPatchImpact(before, { canonicalName: "Su Mingyu" }).reasons).toEqual(["Canonical rename"]);
    expect(canonicalEntityPatchImpact(before, { type: "location" }).reasons).toEqual(["Entity type change"]);
    expect(canonicalEntityPatchImpact(before, { preferredNarrationName: "Big Mike" }).impactful).toBe(true);
    expect(canonicalEntityPatchImpact(before, { aliasNarrationRules: [{ alias: "Ming", behavior: "use_preferred" }] }).impactful).toBe(true);
    expect(canonicalEntityPatchImpact(before, { localizedNaming: { locale: "en-US", fullName: "Mike", usageMode: "ai_contextual" } }).impactful).toBe(true);
    expect(canonicalEntityPatchImpact(before, { pronunciation: { mode: "custom", customPronunciation: "soo" } }).impactful).toBe(true);
  });
});

describe("canonicalEntityDiff", () => {
  it("lists only changed fields with old and new values", () => {
    const diff = canonicalEntityDiff(entity(), { canonicalName: "Su Mingyu", notes: "note", preferredNarrationName: "Big Mike" });
    expect(diff).toEqual([
      { label: "Canonical name", before: "Su Ming", after: "Su Mingyu" },
      { label: "Preferred narration name", before: "—", after: "Big Mike" },
      { label: "Notes", before: "—", after: "note" },
    ]);
    expect(canonicalEntityDiff(entity(), { notes: "" })).toEqual([]);
  });
});

describe("impactEstimateLines", () => {
  it("renders only non-zero estimates", () => {
    const lines = impactEstimateLines(impact({ affectedChapters: [1, 2, 3], narrationAffected: 2, qaAffected: 1, manualNarrationChapters: [2], visualProfileAffected: true }));
    expect(lines).toEqual([
      "3 chapters reference this entity",
      "2 generated narrations may become stale",
      "1 QA result needs recheck",
      "1 manual narration chapter will be preserved for review",
      "Visual Profile needs review before regenerating artwork",
    ]);
    expect(lines.some((line) => line.includes("TTS"))).toBe(false);
    expect(impactEstimateLines(impact())).toEqual([]);
  });
});

describe("EntityImpactDialog", () => {
  it("renders the diff, estimated impact lines, warnings, and cancel/apply actions", () => {
    const html = renderToStaticMarkup(<EntityImpactDialog
      title="Edit Su Ming"
      diff={[{ label: "Preferred narration name", before: "—", after: "Big Mike" }]}
      impact={impact({ affectedChapters: [1, 2], narrationAffected: 1, ttsAffected: 2, warnings: ["1 manual narration chapter will be preserved for review"] })}
      onCancel={() => undefined}
      onApply={() => undefined}
    />);
    expect(html).toContain("Estimated impact");
    expect(html).toContain("Preferred narration name");
    expect(html).toContain("Big Mike");
    expect(html).toContain("1 generated narration may become stale");
    expect(html).toContain("2 TTS outputs need regeneration");
    expect(html).toContain("1 manual narration chapter will be preserved for review");
    expect(html).toContain("Cancel");
    expect(html).toContain("Apply change");
    expect(html).not.toContain("QA result");
  });
});

describe("bulk selection state helpers", () => {
  it("toggles selection by entity id and tracks page state across filters", () => {
    let selected: string[] = [];
    selected = toggleEntitySelection(selected, "ent_a", true);
    selected = toggleEntitySelection(selected, "ent_b", true);
    // Navigating to another page (different ids) keeps the earlier selection.
    expect(pageSelectionState(["ent_c", "ent_d"], selected)).toBe("none");
    expect(selected).toEqual(["ent_a", "ent_b"]);
    selected = toggleEntitySelection(selected, "ent_a", false);
    expect(selected).toEqual(["ent_b"]);
    expect(pageSelectionState(["ent_b", "ent_c"], selected)).toBe("some");
    selected = toggleEntitySelection(selected, "ent_c", true);
    expect(pageSelectionState(["ent_b", "ent_c"], selected)).toBe("all");
  });
});

describe("cleanup plan selection defaults and origin labels", () => {
  it("checks only unprotected auto-safe recommendations by default", () => {
    const recommendations = [
      { id: "rec_safe", safeToAutoApply: true, protected: false },
      { id: "rec_protected", safeToAutoApply: true, protected: true },
      { id: "rec_conflict", safeToAutoApply: false, protected: false },
      { id: "rec_review", safeToAutoApply: false, protected: true },
    ];
    expect(defaultCleanupSelection(recommendations)).toEqual(["rec_safe"]);
    expect(defaultCleanupSelection([])).toEqual([]);
  });
  it("labels only known recommendation origins", () => {
    expect(cleanupOriginLabel("deterministic")).toBe("Deterministic");
    expect(cleanupOriginLabel("ai")).toBe("AI-assisted");
    expect(cleanupOriginLabel(undefined)).toBeUndefined();
    expect(cleanupOriginLabel("manual")).toBeUndefined();
  });
});
