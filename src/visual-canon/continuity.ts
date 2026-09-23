import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import {
  VisualCharacterState,
  VisualContinuityChange,
  VisualContinuityDecision,
  VisualContinuityFactProvenance,
  VisualContinuityHandoff,
  VisualContinuityOverlay,
  VisualContinuityOverrideEntry,
  VisualContinuityReferenceDecision,
  VisualContinuityState,
  VisualObjectState,
  ContinuitySceneInput,
  ResolvedSceneContinuity,
  ResolvedVisualContinuity,
  visualContinuityHandoffSchema,
  visualContinuityOverlaySchema,
} from "./continuity-state.js";

export * from "./continuity-state.js";


const emptyState = (): VisualContinuityState => ({ characters: [], objects: [] });
const cloneState = (state: VisualContinuityState): VisualContinuityState => structuredClone(state);

const characterKey = (name: string, entityId?: string) => (entityId ?? name).trim().toLowerCase();

function findCharacter(state: VisualContinuityState, name: string, entityId?: string) {
  const key = characterKey(name, entityId);
  return state.characters.find((entry) => characterKey(entry.name, entry.entityId) === key);
}

function applyChange(state: VisualContinuityState, change: VisualContinuityChange, decisions: VisualContinuityDecision[]) {
  for (const delta of change.characters ?? []) {
    const existing = findCharacter(state, delta.name, delta.entityId);
    if (delta.op === "exit") {
      if (existing) {
        state.characters = state.characters.filter((entry) => entry !== existing);
        decisions.push({ kind: "dropped", summary: `${delta.name} left the scene`, provenance: "current_narration" });
      }
      continue;
    }
    if (delta.op === "enter") {
      const next: VisualCharacterState = { name: delta.name, ...(delta.entityId ? { entityId: delta.entityId } : {}), ...(delta.set ?? {}) };
      if (existing) Object.assign(existing, next);
      else state.characters.push(next);
      continue;
    }
    if (!existing) {
      state.characters.push({ name: delta.name, ...(delta.entityId ? { entityId: delta.entityId } : {}), ...(delta.set ?? {}) });
      continue;
    }
    for (const field of delta.clear ?? []) delete (existing as Record<string, unknown>)[field];
    Object.assign(existing, delta.set ?? {});
  }
  if (change.environment?.set || change.environment?.clear) {
    const environment = { ...(state.environment ?? {}) };
    for (const field of change.environment.clear ?? []) delete (environment as Record<string, unknown>)[field];
    Object.assign(environment, change.environment.set ?? {});
    state.environment = Object.keys(environment).length ? environment : undefined;
  }
  for (const delta of change.objects ?? []) {
    const key = delta.name.trim().toLowerCase();
    const existing = state.objects.find((entry) => entry.name.trim().toLowerCase() === key);
    if (delta.op === "remove") {
      if (existing) {
        state.objects = state.objects.filter((entry) => entry !== existing);
        decisions.push({ kind: "dropped", summary: `Object '${delta.name}' removed`, provenance: "current_narration" });
      }
      continue;
    }
    if (existing) Object.assign(existing, delta.set ?? {});
    else state.objects.push({ name: delta.name, ...(delta.set ?? {}) });
  }
}

function applyManualStatePatch(state: VisualContinuityState, patch: NonNullable<VisualContinuityOverrideEntry["setState"]>) {
  for (const character of patch.characters ?? []) {
    const existing = findCharacter(state, character.name, character.entityId);
    if (existing) Object.assign(existing, character);
    else state.characters.push(character as VisualCharacterState);
  }
  if (patch.environment) state.environment = { ...(state.environment ?? {}), ...patch.environment };
  for (const object of patch.objects ?? []) {
    const key = object.name.trim().toLowerCase();
    const existing = state.objects.find((entry) => entry.name.trim().toLowerCase() === key);
    if (existing) Object.assign(existing, object);
    else state.objects.push(object as VisualObjectState);
  }
  if (patch.spatial !== undefined) state.spatial = patch.spatial;
}

const samePlace = (a?: string, b?: string) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/**
 * Deterministically fold a chapter's planned scene deltas over the inherited
 * handoff state. Current-chapter narration-derived deltas always win over
 * inherited state: inherited environment location/time/weather is dropped when
 * the first scene establishes a new setting; injuries, equipment, and carried
 * items persist unless a delta clears them. Manual overlay entries apply last.
 */
export function resolveVisualContinuity(options: {
  previousHandoff?: { chapter: number; sceneId: string; state: VisualContinuityState; referenceArtwork?: VisualContinuityHandoff["referenceArtwork"] };
  scenes: ContinuitySceneInput[];
  manualOverrides?: VisualContinuityOverlay;
}): ResolvedVisualContinuity {
  const decisions: VisualContinuityDecision[] = [];
  const handoff = options.previousHandoff;
  const overlayEntries = options.manualOverrides?.entries ?? [];
  const current = handoff ? cloneState(handoff.state) : emptyState();

  if (handoff) {
    const carriedCharacters = current.characters.length;
    const carriedObjects = current.objects.length;
    if (carriedCharacters || carriedObjects || current.environment) {
      decisions.push({
        kind: "carried",
        summary: `Carried ${carriedCharacters} character state(s), ${carriedObjects} object(s)${current.environment ? ", and the environment" : ""} from chapter ${handoff.chapter}`,
        provenance: "previous_chapter",
      });
    }
  }

  // Provenance tracks each fact group across the fold: handoff facts start as
  // previous_chapter, facts created within this chapter as current_narration,
  // carried-forward chapter-local facts as previous_scene when read back.
  const factSource = new Map<string, VisualContinuityFactProvenance>();
  for (const character of current.characters) factSource.set(`characters.${character.name}`, handoff ? "previous_chapter" : "previous_scene");
  if (current.environment) factSource.set("environment", handoff ? "previous_chapter" : "previous_scene");
  for (const object of current.objects) factSource.set(`objects.${object.name}`, handoff ? "previous_chapter" : "previous_scene");

  const perScene: ResolvedSceneContinuity[] = [];
  for (let index = 0; index < options.scenes.length; index++) {
    const scene = options.scenes[index]!;
    const startState = cloneState(current);
    const factProvenance: Record<string, VisualContinuityFactProvenance> = {};
    for (const character of startState.characters) factProvenance[`characters.${character.name}`] = factSource.get(`characters.${character.name}`) ?? "previous_scene";
    if (startState.environment) factProvenance.environment = factSource.get("environment") ?? "previous_scene";
    for (const object of startState.objects) factProvenance[`objects.${object.name}`] = factSource.get(`objects.${object.name}`) ?? "previous_scene";

    if (index === 0 && handoff && current.environment) {
      const set = scene.visualChanges?.environment?.set;
      const establishesNewSetting = Boolean(set && (set.locationId || set.description || set.timeOfDay || set.weather))
        || Boolean(scene.location && !samePlace(scene.location, current.environment.description) && !samePlace(scene.location, current.environment.locationId));
      if (establishesNewSetting) {
        const dropped = ["locationId", "description", "timeOfDay", "weather"].filter((field) => (current.environment as Record<string, unknown>)?.[field] !== undefined);
        if (dropped.length) {
          const environment = { ...current.environment };
          for (const field of dropped) delete (environment as Record<string, unknown>)[field];
          current.environment = Object.keys(environment).length ? environment : undefined;
          decisions.push({ kind: "overridden", summary: `Current narration establishes a new setting; inherited environment ${dropped.join("/")} not carried forward`, provenance: "current_narration" });
        }
      }
    }

    const changes = scene.visualChanges;
    if (changes) applyChange(current, changes, decisions);
    if (changes) {
      for (const delta of changes.characters ?? []) { factSource.set(`characters.${delta.name}`, "current_narration"); factProvenance[`characters.${delta.name}`] = "current_narration"; }
      if (changes.environment) { factSource.set("environment", "current_narration"); factProvenance.environment = "current_narration"; }
      for (const delta of changes.objects ?? []) { factSource.set(`objects.${delta.name}`, "current_narration"); factProvenance[`objects.${delta.name}`] = "current_narration"; }
    }

    const override = overlayEntries.find((entry) => entry.sceneId === scene.id);
    let manualOverride: ResolvedSceneContinuity["manualOverride"];
    if (override) {
      // A stale recorded content fingerprint means the scene changed since the
      // entry was written: apply note-level intent only, conservatively.
      const stale = Boolean(override.sceneContentFingerprint && scene.contentFingerprint && override.sceneContentFingerprint !== scene.contentFingerprint);
      if (!stale && override.setState) {
        applyManualStatePatch(current, override.setState);
        for (const character of override.setState.characters ?? []) factSource.set(`characters.${character.name}`, "manual_override");
        if (override.setState.environment) factSource.set("environment", "manual_override");
        for (const object of override.setState.objects ?? []) factSource.set(`objects.${object.name}`, "manual_override");
        decisions.push({ kind: "manual", summary: `Manual continuity override applied at ${scene.id}${override.note ? `: ${override.note}` : ""}`, provenance: "manual_override" });
        factProvenance.manual = "manual_override";
      } else if (override.note || override.usePreviousReference) {
        decisions.push({ kind: "manual", summary: `Manual continuity note at ${scene.id}${stale ? " (stale; setState skipped)" : ""}`, provenance: "manual_override" });
      }
      manualOverride = { note: override.note, usePreviousReference: override.usePreviousReference, revision: override.revision, stale };
    }

    const referenceDecision = index === 0
      ? decidePreviousChapterReference(handoff, scene, override, decisions)
      : decidePreviousSceneReference(options.scenes[index - 1]!, scene, override);

    perScene.push({ sceneId: scene.id, startState, changes, endState: cloneState(current), factProvenance, referenceDecision, manualOverride });
  }

  return { perScene, chapterEndState: cloneState(current), decisions };
}

function decidePreviousChapterReference(
  handoff: { chapter: number; sceneId: string; referenceArtwork?: VisualContinuityHandoff["referenceArtwork"] } | undefined,
  scene: ContinuitySceneInput,
  override: VisualContinuityOverrideEntry | undefined,
  decisions: VisualContinuityDecision[],
): VisualContinuityReferenceDecision {
  const artwork = handoff?.referenceArtwork;
  if (!handoff || !artwork) return { kind: handoff ? "previous-chapter" : "none", used: false, reason: handoff ? "previous chapter has no approved final-scene artwork" : "no previous chapter handoff" };
  if (override?.usePreviousReference === "avoid") {
    decisions.push({ kind: "manual", summary: `Manual override avoids previous chapter artwork at ${scene.id}`, provenance: "manual_override" });
    return { kind: "previous-chapter", used: false, reason: "manual override avoids the previous reference", sourceChapter: handoff.chapter, sourceSceneId: artwork.sceneId };
  }
  if (override?.usePreviousReference === "prefer") {
    return { kind: "previous-chapter", used: true, reason: "manual override prefers the previous reference", sourceChapter: handoff.chapter, sourceSceneId: artwork.sceneId, versionId: artwork.versionId, versionNumber: artwork.versionNumber, imageFingerprint: artwork.imageFingerprint };
  }
  const set = scene.visualChanges?.environment?.set;
  const settingChanged = Boolean(set && (set.locationId || set.description || set.timeOfDay));
  if (settingChanged) {
    decisions.push({ kind: "overridden", summary: `Previous chapter artwork rejected for ${scene.id}: location or time changed`, provenance: "current_narration" });
    return { kind: "previous-chapter", used: false, reason: "location or time changed in the first scene; textual continuity retained", sourceChapter: handoff.chapter, sourceSceneId: artwork.sceneId };
  }
  return { kind: "previous-chapter", used: true, reason: "same setting as the previous chapter handoff", sourceChapter: handoff.chapter, sourceSceneId: artwork.sceneId, versionId: artwork.versionId, versionNumber: artwork.versionNumber, imageFingerprint: artwork.imageFingerprint };
}

function decidePreviousSceneReference(previous: ContinuitySceneInput, scene: ContinuitySceneInput, override: VisualContinuityOverrideEntry | undefined): VisualContinuityReferenceDecision {
  const artwork = previous.approvedArtwork;
  if (!artwork) return { kind: "previous-scene", used: false, reason: "previous scene has no approved artwork", sourceSceneId: previous.id };
  if (override?.usePreviousReference === "avoid") return { kind: "previous-scene", used: false, reason: "manual override avoids the previous reference", sourceSceneId: previous.id };
  if (override?.usePreviousReference === "prefer") return { kind: "previous-scene", used: true, reason: "manual override prefers the previous reference", sourceSceneId: previous.id, ...artwork };
  const set = scene.visualChanges?.environment?.set;
  if (set && (set.locationId || set.description || set.timeOfDay)) {
    return { kind: "previous-scene", used: false, reason: "location or time changed; textual continuity retained", sourceSceneId: previous.id };
  }
  if (scene.location && previous.location && !samePlace(scene.location, previous.location)) {
    return { kind: "previous-scene", used: false, reason: "scene moved to a new location; textual continuity retained", sourceSceneId: previous.id };
  }
  return { kind: "previous-scene", used: true, reason: "continuous with the previous scene", sourceSceneId: previous.id, ...artwork };
}

/** Bounded compact rendering of a continuity state for LLM planner input. */
export function renderContinuityForPlanner(state: VisualContinuityState, maxCharacters = 2000): string {
  const lines: string[] = [];
  for (const character of state.characters) {
    const parts = [
      character.wardrobe && `wardrobe: ${character.wardrobe}`,
      character.equipment && `equipment: ${character.equipment}`,
      character.carriedItems?.length && `carrying: ${character.carriedItems.join(", ")}`,
      character.injuries && `injuries: ${character.injuries}`,
      character.condition && `condition: ${character.condition}`,
      character.transformation && `transformation: ${character.transformation}`,
      character.appearanceDelta && `appearance change: ${character.appearanceDelta}`,
      character.visibleEmotionalState && `emotional state: ${character.visibleEmotionalState}`,
      character.location && `location: ${character.location}`,
    ].filter(Boolean);
    lines.push(`- ${character.name}${parts.length ? ` — ${parts.join("; ")}` : ""}`);
  }
  if (state.environment) {
    const env = state.environment;
    const parts = [env.description, env.timeOfDay && `time: ${env.timeOfDay}`, env.lighting && `lighting: ${env.lighting}`, env.weather && `weather: ${env.weather}`, env.condition && `condition: ${env.condition}`, env.damage && `damage: ${env.damage}`].filter(Boolean);
    if (parts.length) lines.push(`- Environment — ${parts.join("; ")}`);
  }
  for (const object of state.objects) lines.push(`- Object ${object.name}${object.condition ? ` — ${object.condition}` : ""}${object.possessedBy ? ` (held by ${object.possessedBy})` : ""}`);
  if (state.spatial) lines.push(`- Spatial: ${state.spatial}`);
  const text = lines.length ? lines.join("\n") : "No prior visual continuity state.";
  return text.length > maxCharacters ? `${text.slice(0, maxCharacters - 1)}…` : text;
}

/** Bounded per-scene continuity block for artwork prompts. */
export function renderSceneContinuity(resolved: ResolvedSceneContinuity, maxCharacters = 1200): string | undefined {
  const lines: string[] = [];
  const stateText = renderContinuityForPlanner(resolved.startState, maxCharacters);
  if (stateText !== "No prior visual continuity state.") lines.push(`STATE AT SCENE START:\n${stateText}`);
  if (resolved.changes) {
    const notes: string[] = [];
    for (const delta of resolved.changes.characters ?? []) notes.push(`${delta.name}: ${delta.op}${delta.set ? ` (${Object.entries(delta.set).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("; ")})` : ""}`);
    if (resolved.changes.environment?.set) notes.push(`environment: ${Object.entries(resolved.changes.environment.set).map(([key, value]) => `${key}: ${value}`).join("; ")}`);
    for (const delta of resolved.changes.objects ?? []) notes.push(`object ${delta.name}: ${delta.op}`);
    if (resolved.changes.note) notes.push(resolved.changes.note);
    if (notes.length) lines.push(`CHANGES IN THIS SCENE:\n${notes.join("\n")}`);
  }
  if (resolved.manualOverride?.note) lines.push(`MANUAL CONTINUITY NOTE:\n${resolved.manualOverride.note}`);
  if (!lines.length) return undefined;
  const text = lines.join("\n");
  return text.length > maxCharacters ? `${text.slice(0, maxCharacters - 1)}…` : text;
}

export function visualContinuityOverlayFingerprint(overlay: VisualContinuityOverlay): string {
  return fingerprint(overlay.entries.map(({ updatedAt: _updatedAt, ...entry }) => entry));
}

export async function loadVisualContinuityHandoff(root: string, slug: string, chapter: number): Promise<VisualContinuityHandoff | undefined> {
  const raw = await readJsonIfExists<unknown>(storyPaths(root, slug, chapter).visualContinuity).catch(() => undefined);
  if (raw === undefined) return undefined;
  const parsed = visualContinuityHandoffSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ event: "visual_continuity.handoff_ignored", story: slug, chapter }, "Ignoring corrupt visual continuity handoff");
    return undefined;
  }
  return parsed.data;
}

export async function loadVisualContinuityOverlay(root: string, slug: string, chapter: number): Promise<VisualContinuityOverlay> {
  const raw = await readJsonIfExists<unknown>(storyPaths(root, slug, chapter).visualContinuityManual).catch(() => undefined);
  const parsed = raw !== undefined ? visualContinuityOverlaySchema.safeParse(raw) : undefined;
  return parsed?.success ? parsed.data : { version: 1, entries: [] };
}

export type PreviousVisualContinuity = {
  chapter: number;
  sceneId: string;
  state: VisualContinuityState;
  stateFingerprint: string;
  referenceArtwork?: VisualContinuityHandoff["referenceArtwork"];
  origin: "automatic" | "manual" | "derived";
};

/** Greatest previous chapter with a loadable handoff; otherwise lazily derive
 * one from the nearest previous scenes manifest that carries deltas. Corrupt
 * artifacts are skipped, never fatal. */
export async function resolvePreviousVisualContinuity(root: string, slug: string, chapter: number): Promise<PreviousVisualContinuity | undefined> {
  const chaptersDir = join(storyPaths(root, slug, chapter).story, "chapters");
  let names: string[];
  try {
    names = await readdir(chaptersDir);
  } catch {
    return undefined;
  }
  const previous = names.map((name) => (/^(\d{4,})$/.test(name) ? Number(name) : NaN)).filter((value) => Number.isInteger(value) && value > 0 && value < chapter).sort((a, b) => b - a);
  for (const candidate of previous) {
    const handoff = await loadVisualContinuityHandoff(root, slug, candidate);
    if (handoff) return { chapter: handoff.chapter, sceneId: handoff.source.sceneId, state: handoff.state, stateFingerprint: handoff.stateFingerprint, referenceArtwork: handoff.referenceArtwork, origin: handoff.origin };
  }
  const { sceneManifestSchema } = await import("../scenes/types.js");
  for (const candidate of previous) {
    const raw = await readJsonIfExists<unknown>(storyPaths(root, slug, candidate).scenesManifest).catch(() => undefined);
    const parsed = raw !== undefined ? sceneManifestSchema.safeParse(raw) : undefined;
    if (!parsed?.success || !parsed.data.scenes.some((scene) => scene.visualChanges)) continue;
    const overlay = await loadVisualContinuityOverlay(root, slug, candidate);
    const resolved = resolveVisualContinuity({ scenes: continuitySceneInputs(parsed.data), manualOverrides: overlay });
    const finalScene = parsed.data.scenes[parsed.data.scenes.length - 1]!;
    return { chapter: candidate, sceneId: finalScene.id, state: resolved.chapterEndState, stateFingerprint: fingerprint(resolved.chapterEndState), referenceArtwork: approvedReferenceArtwork(parsed.data.scenes), origin: "derived" };
  }
  return undefined;
}

type ManifestSceneLike = {
  id: string;
  location?: string;
  visualChanges?: VisualContinuityChange;
  artwork: { approvedVersionId?: string; versions: Array<{ id: string; versionNumber: number; imageFingerprint: string }> };
};

export function continuitySceneInputs(manifest: { scenes: ManifestSceneLike[] }, contentFingerprints?: Record<string, string>): ContinuitySceneInput[] {
  return manifest.scenes.map((scene) => {
    const approved = scene.artwork.approvedVersionId ? scene.artwork.versions.find((version) => version.id === scene.artwork.approvedVersionId) : undefined;
    return {
      id: scene.id,
      location: scene.location,
      visualChanges: scene.visualChanges,
      approvedArtwork: approved ? { versionId: approved.id, versionNumber: approved.versionNumber, imageFingerprint: approved.imageFingerprint } : undefined,
      contentFingerprint: contentFingerprints?.[scene.id],
    };
  });
}

export function approvedReferenceArtwork(scenes: ManifestSceneLike[]): VisualContinuityHandoff["referenceArtwork"] | undefined {
  const finalScene = scenes[scenes.length - 1];
  if (!finalScene?.artwork.approvedVersionId) return undefined;
  const version = finalScene.artwork.versions.find((item) => item.id === finalScene.artwork.approvedVersionId);
  return version ? { sceneId: finalScene.id, versionId: version.id, versionNumber: version.versionNumber, imageFingerprint: version.imageFingerprint } : undefined;
}

/** Resolve the chapter's continuity package and persist the handoff artifact.
 * Recomputed from manifest deltas + previous handoff + overlay (no dual state
 * store); the write is skipped when nothing semantically changed. */
export async function persistChapterVisualContinuity(options: {
  root: string;
  slug: string;
  chapter: number;
  manifest: { chapter: number; scenes: ManifestSceneLike[] };
  origin?: "automatic" | "manual";
}): Promise<ResolvedVisualContinuity> {
  const previous = await resolvePreviousVisualContinuity(options.root, options.slug, options.chapter);
  const overlay = await loadVisualContinuityOverlay(options.root, options.slug, options.chapter);
  const resolved = resolveVisualContinuity({
    previousHandoff: previous ? { chapter: previous.chapter, sceneId: previous.sceneId, state: previous.state, referenceArtwork: previous.referenceArtwork } : undefined,
    scenes: continuitySceneInputs(options.manifest),
    manualOverrides: overlay,
  });
  const finalScene = options.manifest.scenes[options.manifest.scenes.length - 1]!;
  const artifact: VisualContinuityHandoff = {
    version: 1,
    chapter: options.chapter,
    state: resolved.chapterEndState,
    source: { chapter: options.chapter, sceneId: finalScene.id },
    stateFingerprint: fingerprint(resolved.chapterEndState),
    referenceArtwork: approvedReferenceArtwork(options.manifest.scenes),
    origin: options.origin ?? "automatic",
    updatedAt: new Date().toISOString(),
  };
  const existing = await loadVisualContinuityHandoff(options.root, options.slug, options.chapter);
  const unchanged = existing
    && existing.stateFingerprint === artifact.stateFingerprint
    && existing.source.sceneId === artifact.source.sceneId
    && fingerprint(existing.referenceArtwork ?? null) === fingerprint(artifact.referenceArtwork ?? null)
    && existing.origin === artifact.origin;
  if (!unchanged) await atomicWriteJson(storyPaths(options.root, options.slug, options.chapter).visualContinuity, artifact);
  return resolved;
}

/** Recompute-on-read resolution for dashboards and artwork generation. */
export async function resolveChapterVisualContinuity(options: {
  root: string;
  slug: string;
  chapter: number;
  manifest: { scenes: ManifestSceneLike[] };
  contentFingerprints?: Record<string, string>;
}): Promise<{ resolved: ResolvedVisualContinuity; previous?: PreviousVisualContinuity; overlay: VisualContinuityOverlay }> {
  const previous = await resolvePreviousVisualContinuity(options.root, options.slug, options.chapter);
  const overlay = await loadVisualContinuityOverlay(options.root, options.slug, options.chapter);
  const resolved = resolveVisualContinuity({
    previousHandoff: previous ? { chapter: previous.chapter, sceneId: previous.sceneId, state: previous.state, referenceArtwork: previous.referenceArtwork } : undefined,
    scenes: continuitySceneInputs(options.manifest, options.contentFingerprints),
    manualOverrides: overlay,
  });
  return { resolved, previous, overlay };
}

export async function upsertVisualContinuityOverride(options: {
  root: string;
  slug: string;
  chapter: number;
  entry: VisualContinuityOverrideEntry;
}): Promise<VisualContinuityOverlay> {
  const overlay = await loadVisualContinuityOverlay(options.root, options.slug, options.chapter);
  const index = overlay.entries.findIndex((entry) => entry.sceneId === options.entry.sceneId);
  const previous = index >= 0 ? overlay.entries[index]! : undefined;
  const entry = { ...options.entry, revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
  const entries = index >= 0 ? overlay.entries.map((item, itemIndex) => (itemIndex === index ? entry : item)) : [...overlay.entries, entry];
  const next = visualContinuityOverlaySchema.parse({ version: 1, entries });
  await atomicWriteJson(storyPaths(options.root, options.slug, options.chapter).visualContinuityManual, next);
  return next;
}

export async function removeVisualContinuityOverride(options: { root: string; slug: string; chapter: number; sceneId: string }): Promise<VisualContinuityOverlay> {
  const overlay = await loadVisualContinuityOverlay(options.root, options.slug, options.chapter);
  const next = visualContinuityOverlaySchema.parse({ version: 1, entries: overlay.entries.filter((entry) => entry.sceneId !== options.sceneId) });
  await atomicWriteJson(storyPaths(options.root, options.slug, options.chapter).visualContinuityManual, next);
  return next;
}
