import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canonicalEntitySchema, visualEvidenceSchema } from "../src/domain/story-bible.js";
import { VisualEvidencePanel } from "../apps/web/src/VisualEvidencePanel.js";

const observation = (id: string, value: string, chapter: number, persistence: "persistent" | "changed" | "temporary" = "persistent") => visualEvidenceSchema.parse({
  id: `ve_${id.padStart(24, "0")}`,
  field: "character.hairColor",
  value,
  normalizedValue: value.toLowerCase(),
  chapter,
  lastObservedChapter: chapter,
  confidence: 0.94,
  persistence,
  status: persistence === "temporary" ? "temporary" : "current",
  source: "source_text",
  provenance: [{ chapter, excerpt: `Source says ${value}.`, confidence: 0.94 }],
});

function entity(records: ReturnType<typeof observation>[], decisions: Array<{ evidenceId: string; action: "select" | "change" | "dismiss" }> = []) {
  return canonicalEntitySchema.parse({
    id: "ent_0123456789abcdef01234567",
    type: "character",
    canonicalName: "Li Chen",
    firstAppearance: 1,
    lastKnownAppearance: 400,
    visualEvidence: records,
    visualEvidenceDecisions: decisions.map((decision) => ({ field: "character.hairColor", ...decision, decidedAt: "2026-09-25T12:00:00.000Z" })),
  });
}

function markup(records: ReturnType<typeof observation>[], options: { chapter?: number; readOnly?: boolean; decisions?: Array<{ evidenceId: string; action: "select" | "change" | "dismiss" }> } = {}) {
  return renderToStaticMarkup(<VisualEvidencePanel slug="demo" entity={entity(records, options.decisions)} chapter={options.chapter ?? 500} readOnly={options.readOnly} />);
}

describe("Story Bible Visual Evidence panel", () => {
  it("offers ignore for a single observation without competing-value actions", () => {
    const html = markup([observation("1", "black", 12)]);
    expect(html).toContain("Ignore observation");
    expect(html).not.toContain("Keep as current");
    expect(html).not.toContain("Mark later change");
    expect(html).toContain("CURRENT");
  });

  it("offers restore and marks a dismissed single observation ignored", () => {
    const item = observation("1", "black", 12);
    const html = markup([item], { decisions: [{ evidenceId: item.id, action: "dismiss" }] });
    expect(html).toContain("Restore observation");
    expect(html).toContain("IGNORED");
    expect(html).not.toContain("Keep as current");
    expect(html).not.toContain("Mark later change");
    expect(html).not.toContain("Current: black");
  });

  it("shows conflict-resolution controls only for competing observations", () => {
    const html = markup([observation("1", "black", 12), observation("2", "silver", 40)]);
    expect(html).toContain("Current: Unresolved");
    expect(html).toContain("Conflicting source observations");
    expect(html).toContain("CONFLICT");
    expect(html).toContain("Keep as current");
    expect(html).toContain("Mark later change");
  });

  it("marks selected and changed editorial resolutions concisely", () => {
    const selected = observation("1", "black", 12);
    expect(markup([selected, observation("2", "silver", 40)], { decisions: [{ evidenceId: selected.id, action: "select" }] })).toContain("EDITORIAL CURRENT");

    const changed = observation("3", "silver", 40, "changed");
    expect(markup([observation("1", "black", 12), changed], { decisions: [{ evidenceId: changed.id, action: "change" }] })).toContain("EDITORIAL CHANGE");
  });

  it("offers Leave unresolved when an editorial decision exists", () => {
    const item = observation("1", "black", 12);
    expect(markup([item], { decisions: [{ evidenceId: item.id, action: "select" }] })).toContain("Leave unresolved");
  });

  it("keeps historical/current labels relative to the requested chapter", () => {
    const old = observation("1", "black", 20);
    const future = observation("2", "silver", 310, "changed");
    const historical = markup([old, future], { chapter: 100, readOnly: true });
    expect(historical).toContain("Current: black");
    expect(historical).toContain("CURRENT");
    expect(historical).not.toContain("Chapter 310: silver");
    expect(historical).not.toContain("Ignore observation");

    const latest = markup([old, future], { decisions: [{ evidenceId: future.id, action: "change" }] });
    expect(latest).toContain("Current: silver");
    expect(latest).toContain("HISTORICAL");
    expect(latest).toContain("EDITORIAL CHANGE");
  });

  it("keeps temporary observations in their separate area with no editorial controls", () => {
    const temporary = observation("1", "red robe", 5, "temporary");
    const html = markup([temporary], { chapter: 5 });
    expect(html).toContain("Temporary observations (1)");
    expect(html).toContain("TEMPORARY");
    expect(html).not.toContain("Ignore observation");
    expect(html).not.toContain("Keep as current");
  });

  it("does not expose mutation actions in read-only historical mode", () => {
    const html = markup([observation("1", "black", 12)], { readOnly: true });
    expect(html).not.toContain("Ignore observation");
    expect(html).not.toContain("Restore observation");
    expect(html).not.toContain("Keep as current");
    expect(html).not.toContain("Mark later change");
    expect(html).not.toContain("Leave unresolved");
  });
});
