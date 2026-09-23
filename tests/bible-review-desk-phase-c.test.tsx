import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanonicalEntitySheet, EntityHistorySection, EntityUsageSection, entityAuditDeltaLabel, entityAuditRevertPatch } from "../apps/web/src/App.js";
import type { EntityAuditEntry } from "../apps/web/src/api.js";

const entity = (patch: Record<string, unknown> = {}) => ({
  id: "ent_0123456789abcdef01234567", type: "character", canonicalName: "Su Ming", originalName: "苏明", aliases: ["Ming"],
  preferredNarrationName: undefined, aliasNarrationRules: [], localizedNaming: undefined, pronunciation: undefined,
  canonicalNameLocked: false, status: "alive", notes: "", description: "", origin: "automatic",
  firstAppearance: 1, lastKnownAppearance: 3, provenance: [{ chapter: 1, kind: "extraction", origin: "automatic" }], mergedFromIds: [],
  ...patch,
});

const detail = (patch: Record<string, unknown> = {}) => ({
  entity: entity(), timeline: [], relationships: [], relatedNames: {}, relatedReferences: [],
  issues: [], merges: [], duplicateSuggestions: [], namingCollisions: [], readiness: [], visualProfileExists: false,
  ...patch,
});

const noop = () => {};

describe("canonical entity sheet — Phase C sections", () => {
  it("renders the naming collision section with field details and a compare action", () => {
    const other = "ent_aaaaaaaaaaaaaaaaaaaaaaaa";
    const html = renderToStaticMarkup(
      <CanonicalEntitySheet
        detail={detail({ namingCollisions: [{
          id: "nmc_1", type: "canonical-narration", name: "Sue", confidence: "high", hasMergeRelationship: false,
          entities: [
            { id: entity().id, canonicalName: "Su Ming", type: "character", field: "canonical name" },
            { id: other, canonicalName: "Ming", type: "character", field: "preferred narration name" },
          ],
          chapters: [1, 2], reason: "The name 'Sue' is used by 2 different entities.",
        }] })}
        slug="night-lantern" navigate={noop} onClose={noop} onUndo={noop} onEdit={noop}
        onDemote={noop} onSuppress={noop} onMerge={noop} onOpenVisualProfile={noop}
      />,
    );
    expect(html).toContain("Naming collision");
    expect(html).toContain("The name &#x27;Sue&#x27; is used by 2 different entities.");
    expect(html).toContain("Compare with Ming");
    expect(html).toContain("preferred narration name");
  });

  it("renders lazy usage and history affordances without fetching", () => {
    const html = renderToStaticMarkup(
      <CanonicalEntitySheet detail={detail()} slug="night-lantern" navigate={noop} onClose={noop} onUndo={noop} onEdit={noop} onDemote={noop} onSuppress={noop} onMerge={noop} onOpenVisualProfile={noop} />,
    );
    expect(html).toContain("View where this entity is used");
    expect(html).toContain("View change history");
    expect(renderToStaticMarkup(<EntityUsageSection slug="s" entityId="ent_0123456789abcdef01234567" navigate={noop} />)).toContain("Used in");
    expect(renderToStaticMarkup(<EntityHistorySection slug="s" entityId="ent_0123456789abcdef01234567" />)).toContain("Change History");
  });
});

describe("entity audit timeline helpers", () => {
  const entry = (patch: Partial<EntityAuditEntry>): EntityAuditEntry => ({
    id: "aud_1", entityId: "ent_0123456789abcdef01234567", action: "updated", source: "manual", timestamp: "2026-01-01T00:00:00.000Z", ...patch,
  });

  it("humanizes before → after deltas", () => {
    expect(entityAuditDeltaLabel(entry({ action: "renamed", before: { canonicalName: "Su Ming" }, after: { canonicalName: "Su Mingyu" } }))).toBe("canonical name: Su Ming → Su Mingyu");
    expect(entityAuditDeltaLabel(entry({ action: "locked", before: { canonicalNameLocked: false }, after: { canonicalNameLocked: true } }))).toBe("name lock: false → true");
    expect(entityAuditDeltaLabel(entry({ action: "narration_mapping_changed", before: { preferredNarrationName: null }, after: { preferredNarrationName: "Sue" } }))).toBe("preferred narration name: — → Sue");
    expect(entityAuditDeltaLabel(entry({ action: "merged", after: { mergeId: "m1" } }))).toBeUndefined();
  });

  it("allows revert only for safe overlay changes", () => {
    expect(entityAuditRevertPatch(entry({ action: "renamed", before: { canonicalName: "Su Ming" }, after: { canonicalName: "Su Mingyu" } }))).toEqual({ canonicalName: "Su Ming" });
    expect(entityAuditRevertPatch(entry({ action: "unlocked", before: { canonicalNameLocked: true }, after: { canonicalNameLocked: false } }))).toEqual({ canonicalNameLocked: true });
    expect(entityAuditRevertPatch(entry({ action: "merged", before: { canonicalName: "Su Ming" }, after: {} }))).toBeUndefined();
    expect(entityAuditRevertPatch(entry({ action: "suppressed", before: { canonicalName: "Su Ming", type: "character" } }))).toBeUndefined();
    expect(entityAuditRevertPatch(entry({ action: "updated", before: { pronunciation: { mode: "custom" } }, after: {} }))).toBeUndefined();
    expect(entityAuditRevertPatch(entry({ action: "updated", before: { notes: "a", aliases: ["x"] }, after: {} }))).toBeUndefined();
  });
});
