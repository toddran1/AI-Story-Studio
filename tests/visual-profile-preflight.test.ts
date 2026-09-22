import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateStoredArtwork } from "../src/artwork/generator.js";
import { canonicalEntitySchema, emptyStoryBible } from "../src/domain/story-bible.js";
import { updateCanonicalEntity, loadStoryBibleWithCanonicalOverlay } from "../src/story-bible/canonical.js";
import { updateVisualProfile } from "../src/visual-canon/profiles.js";
import { inspectArtworkVisualPreflight } from "../src/visual-canon/preflight.js";
import { sceneManifestSchema } from "../src/scenes/types.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { testStory } from "./helpers.js";

const characterId = "ent_111111111111111111111111";
const locationId = "ent_222222222222222222222222";
const now = "2026-01-01T00:00:00.000Z";
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "visual-preflight-")); roots.push(root);
  const story = testStory(); const paths = storyPaths(root, story.slug, 1);
  await atomicWriteJson(paths.bible, { ...emptyStoryBible(), canonicalEntities: [
    canonicalEntitySchema.parse({ id: characterId, type: "character", canonicalName: "Mara", aliases: [], description: "A young astronomer.", firstAppearance: 1, lastKnownAppearance: 1 }),
    canonicalEntitySchema.parse({ id: locationId, type: "location", canonicalName: "Old Observatory", aliases: [], description: "A brass-domed observatory.", firstAppearance: 1, lastKnownAppearance: 1 }),
  ] });
  await atomicWriteJson(paths.scenesManifest, sceneManifestSchema.parse({ version: 1, chapter: 1, durationSeconds: 20, planningFingerprint: "scene-plan", planner: { provider: "test", model: "test", promptVersion: "1" }, createdAt: now, updatedAt: now, scenes: [
    { id: "scene-001", summary: "Mara enters.", startSeconds: 0, endSeconds: 10, characters: ["Mara"], location: "Old Observatory", visualPrompt: "Mara under the brass telescope", importance: "major", artwork: {} },
    { id: "scene-002", summary: "Mara studies the sky.", startSeconds: 10, endSeconds: 20, characters: ["Mara"], location: "Old Observatory", visualPrompt: "Mara sees stars", importance: "standard", artwork: {} },
  ] }));
  return { root, story, paths };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Artwork Visual Profile Preflight", () => {
  it("deduplicates visually present canonical entities and blocks missing or draft profiles without provider work", async () => {
    const { root, story } = await fixture();
    const preflight = await inspectArtworkVisualPreflight({ root, slug: story.slug, chapters: [1] });
    expect(preflight.ready).toBe(false);
    expect(preflight.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityId: characterId, state: "missing_profile", affectedSceneIds: ["1:scene-001", "1:scene-002"] }),
      expect.objectContaining({ entityId: locationId, state: "missing_profile", affectedSceneIds: ["1:scene-001", "1:scene-002"] }),
    ]));
    await updateVisualProfile(root, story.slug, characterId, { visualType: "character" });
    const drafted = await inspectArtworkVisualPreflight({ root, slug: story.slug, chapters: [1] });
    expect(drafted.entities.find((entity) => entity.entityId === characterId)).toMatchObject({ state: "draft_profile" });
  });

  it("uses approved profiles first, permits one-time fallback without persistence, and respects persistent skip", async () => {
    const { root, story } = await fixture();
    await updateVisualProfile(root, story.slug, characterId, { visualType: "character", status: "approved", appearance: "A sharp-eyed astronomer." });
    const oneTime = await inspectArtworkVisualPreflight({ root, slug: story.slug, chapters: [1], allowUnprofiledEntityIds: [locationId] });
    expect(oneTime.ready).toBe(true);
    expect(oneTime.entities.find((entity) => entity.entityId === characterId)).toMatchObject({ state: "approved_profile" });
    expect((await loadStoryBibleWithCanonicalOverlay(root, story.slug)).canonicalEntities.find((entity) => entity.id === locationId)?.visualProfilePolicy).toBeUndefined();
    const base = await loadStoryBibleWithCanonicalOverlay(root, story.slug, { includeCanonicalOverlay: false });
    await updateCanonicalEntity(root, story.slug, base, locationId, { visualProfilePolicy: { mode: "skip" } });
    const skipped = await inspectArtworkVisualPreflight({ root, slug: story.slug, chapters: [1] });
    expect(skipped.ready).toBe(true);
    expect(skipped.entities.find((entity) => entity.entityId === locationId)).toMatchObject({ state: "skip_profile", policy: "skip" });
  });

  it("does not let a stale skip suppress a newly approved profile", async () => {
    const { root, story } = await fixture();
    const base = await loadStoryBibleWithCanonicalOverlay(root, story.slug, { includeCanonicalOverlay: false });
    await updateCanonicalEntity(root, story.slug, base, characterId, { visualProfilePolicy: { mode: "skip" } });
    await updateVisualProfile(root, story.slug, characterId, { visualType: "character", status: "approved", appearance: "Mara's established profile." });
    const preflight = await inspectArtworkVisualPreflight({ root, slug: story.slug, chapters: [1], allowUnprofiledEntityIds: [locationId] });
    expect(preflight.entities.find((entity) => entity.entityId === characterId)).toMatchObject({ state: "approved_profile" });
  });

  it("rejects generation before an image provider can be called when a decision is unresolved", async () => {
    const { root, story, paths } = await fixture();
    await atomicWriteJson(paths.chapterMeta, { chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage, counts: { originalCharacters: 1, englishWords: 1, narrationWords: 1 }, createdAt: now, updatedAt: now, stages: { ingestion: { status: "complete", fingerprint: "a", outputFingerprint: "a" }, translation: { status: "complete", fingerprint: "b", outputFingerprint: "b" }, narration: { status: "complete", fingerprint: "c", outputFingerprint: "c" }, qa: { status: "complete", fingerprint: "d", outputFingerprint: "d" }, storyBible: { status: "complete", fingerprint: "e", outputFingerprint: "e" }, tts: { status: "pending" } } });
    let calls = 0;
    const provider = { name: story.artwork.provider, version: "test", validateConfiguration: async () => { calls++; }, generate: async () => { calls++; return { data: Buffer.from("png"), mimeType: "image/png" as const }; } };
    await expect(generateStoredArtwork({ root, story, chapter: 1, provider })).rejects.toThrow("Visual Profile Check required");
    expect(calls).toBe(0);
  });
});
