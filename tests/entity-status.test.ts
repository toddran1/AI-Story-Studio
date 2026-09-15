import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyStoryBible, storyBibleUpdateSchema } from "../src/domain/story-bible.js";
import { updateCanonicalEntity } from "../src/story-bible/canonical.js";
import { getEntityStatusOptions, isStandardEntityStatus, normalizeEntityStatus } from "../src/story-bible/entity-status.js";
import { mergeStoryBible } from "../src/story-bible/updater.js";

const values = (type: string) => getEntityStatusOptions(type).map((option) => option.value);
const update = (characters: Array<Record<string, unknown>>) => storyBibleUpdateSchema.parse({ chapterSummary: "Status fixture", characters });
const entity = (name: string, extra: Record<string, unknown> = {}) => ({ canonicalEnglishName: name, originalName: "", description: "Status fixture", firstSeenChapter: 1, lastSeenChapter: 1, ...extra });

describe("entity-aware Story Bible statuses", () => {
  it("provides the requested specialized and generic status vocabularies", () => {
    expect(values("character")).toEqual(expect.arrayContaining(["unknown", "alive", "spirit-ghost", "unknown-whereabouts"]));
    expect(values("location")).toEqual(expect.arrayContaining(["existing", "under-siege", "occupied-by-enemy"]));
    expect(values("organization")).toEqual(expect.arrayContaining(["at-war", "disbanded", "extinct"]));
    expect(values("item")).toEqual(expect.arrayContaining(["equipped", "recharged", "purified"]));
    expect(values("ability")).toEqual(expect.arrayContaining(["partially-mastered", "cooldown", "transferred"]));
    expect(values("concept")).toEqual(expect.arrayContaining(["ongoing", "deprecated", "unresolved"]));
    expect(values("unrecognized-future-type")[0]).toBe("unknown");
  });

  it("normalizes standard values while retaining unusual custom states", () => {
    expect(normalizeEntityStatus("character", " Alive ")).toBe("alive");
    expect(normalizeEntityStatus("character", "Spirit / Ghost")).toBe("spirit-ghost");
    expect(normalizeEntityStatus("character", "Cultivation crippled")).toBe("Cultivation crippled");
    expect(isStandardEntityStatus("character", "ALIVE")).toBe(true);
    expect(isStandardEntityStatus("character", "Trapped in temporal stasis")).toBe(false);
  });

  it("saves standard statuses canonically and preserves a legacy custom status", async () => {
    const root = await mkdtemp(join(tmpdir(), "entity-status-"));
    const base = mergeStoryBible(emptyStoryBible(), update([entity("Su Ming", { status: "Cultivation crippled" })]), 1);
    const su = base.canonicalEntities[0]!;
    const standard = await updateCanonicalEntity(root, "demo-story", base, su.id, { status: "Alive" });
    expect(standard.bible.canonicalEntities[0]).toMatchObject({ status: "alive", origin: "manual" });
    const preserved = await updateCanonicalEntity(root, "legacy-story", base, su.id, { notes: "Keep unusual state" });
    expect(preserved.bible.canonicalEntities[0]).toMatchObject({ status: "Cultivation crippled", notes: "Keep unusual state" });
    expect(preserved.bible.entityTimeline).toEqual(base.entityTimeline);
    expect(preserved.bible.canonicalEntities[0]?.provenance).toEqual(su.provenance);
  });

  it("allows a non-empty custom value but never stores the Custom selector", async () => {
    const root = await mkdtemp(join(tmpdir(), "entity-status-custom-"));
    const base = mergeStoryBible(emptyStoryBible(), update([entity("Su Ming")]), 1);
    const su = base.canonicalEntities[0]!;
    const custom = await updateCanonicalEntity(root, "demo-story", base, su.id, { status: "Soul separated from body" });
    expect(custom.bible.canonicalEntities[0]?.status).toBe("Soul separated from body");
    await expect(updateCanonicalEntity(root, "demo-story", base, su.id, { status: " Custom... " })).rejects.toThrow(/Custom status requires/);
  });

  it("uses the selected entity type rather than a stale status vocabulary", () => {
    expect(isStandardEntityStatus("character", "alive")).toBe(true);
    expect(isStandardEntityStatus("location", "alive")).toBe(false);
    expect(normalizeEntityStatus("location", "Under siege")).toBe("under-siege");
  });
});
