import { loadStoryBibleWithCanonicalOverlay } from "../story-bible/canonical.js";
import { identityNames } from "../narration/name-scope.js";
import type { CanonicalEntity } from "../domain/story-bible.js";
import { sceneEditableState } from "../scenes/editable-state.js";
import type { Scene } from "../scenes/types.js";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { logger } from "../utils/logger.js";
import {
  continuitySnapshot,
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
  return state.characters.find((entry) => entry.entityId && entityId ? characterKey(entry.name, entry.entityId) === key : characterKey(entry.name) === characterKey(name));
}

function applyChange(state: VisualContinuityState, change: VisualContinuityChange, decisions: VisualContinuityDecision[]) {
  for (const delta of change.characters ?? []) {
    const existing = findCharacter(state, delta.name, delta.entityId);
    const key = characterKey(delta.name, delta.entityId ?? existing?.entityId);
    const absent = state.absentCharacters;
    const remembered = absent && Object.hasOwn(absent, key) ? absent[key] : undefined;
    const next: VisualCharacterState = { ...remembered, ...existing, name: delta.name };
    if (delta.entityId) next.entityId = delta.entityId;
    for (const field of delta.clear ?? []) delete (next as Record<string, unknown>)[field];
    Object.assign(next, delta.set ?? {});

    if (delta.op === "exit") {
      if (!existing && !remembered) continue;
      const { activeAbilities, visibleEmotionalState, location, ...durable } = next;
      state.absentCharacters = { ...absent, [key]: durable };
      state.characters = state.characters.filter((entry) => entry !== existing);
      if (state.spatial) state.spatial = state.spatial.split("; ").filter(part => !part.startsWith(`${delta.name}:`)).join("; ") || undefined;
      decisions.push({ kind: "dropped", summary: `${delta.name} left the scene`, provenance: "current_narration" });
      continue;
    }
    if (remembered) {
      delete absent![key];
      decisions.push({ kind: "carried", summary: `Restored last known appearance for ${delta.name}`, provenance: "previous_chapter" });
    }
    if (existing) state.characters[state.characters.indexOf(existing)] = next;
    else state.characters.push(next);
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
  chapter?: number;
  history?: ReadonlyMap<number, VisualContinuityState>;
  entities?: CanonicalEntity[];
}): ResolvedVisualContinuity {
  const decisions: VisualContinuityDecision[] = [];
  const handoff = options.previousHandoff;
  const overlayEntries = options.manualOverrides?.entries ?? [];
  let current = handoff ? cloneState(handoff.state) : emptyState();

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
  let historicalChapter: number | undefined;
  let presentState: VisualContinuityState | undefined;
  let presentChapter = options.chapter ?? handoff?.chapter;
  const identities = new Map<string, Set<string>>();
  for (const entity of options.entities ?? []) {
    if (entity.type !== "character" && entity.type !== "location") continue;
    for (const name of [entity.id, ...entity.mergedFromIds, ...identityNames(entity)]) {
      const key = JSON.stringify([entity.type, name.trim().toLowerCase()]);
      const matches = identities.get(key) ?? new Set<string>();
      matches.add(entity.id);
      identities.set(key, matches);
    }
  }
  function entityId(type: "character" | "location", name?: string) {
    if (!name) return undefined;
    const matches = identities.get(JSON.stringify([type, name.trim().toLowerCase()]));
    return matches?.size === 1 ? [...matches][0] : undefined;
  }
  for (let index = 0; index < options.scenes.length; index++) {
    const scene = options.scenes[index]!;
    const target = scene.appearanceChapter;
    const chapter = presentChapter;
    const isHistorical = scene.visualChanges?.transition === "flashback"
      || (target !== undefined && chapter !== undefined && target < chapter)
      || (historicalChapter !== undefined && target === undefined && scene.visualChanges?.transition !== "time_jump" && options.scenes[index - 1]?.appearanceChapter === undefined);
    if (!isHistorical && target !== undefined) presentChapter = Math.max(presentChapter ?? target, target);
    const returning = !isHistorical && presentState !== undefined;
    if (isHistorical && (!presentState || (target !== undefined && target !== historicalChapter))) {
      presentState ??= current;
      historicalChapter = target ?? 0;
      const recorded = target === undefined ? undefined : options.history?.get(target);
      current = recorded ? cloneState(recorded) : emptyState();
      factSource.clear();
      decisions.push({ kind: "carried", summary: recorded ? `Loaded visual state from chapter ${target}` : "Historical scene has no recorded visual state", provenance: "previous_chapter" });
    } else if (returning) {
      current = presentState!;
      presentState = undefined;
      historicalChapter = undefined;
      factSource.clear();
    } else if (scene.visualChanges?.transition === "time_jump") {
      for (const character of current.characters) {
        delete character.activeAbilities; delete character.appearanceDelta; delete character.transformation; delete character.visibleEmotionalState;
      }
      delete current.environment; delete current.activeLocationKey; delete current.spatial;
      decisions.push({ kind: "dropped", summary: `Time jump at ${scene.id}: transient effects must be established again`, provenance: "current_narration" });
    }
    const previousScene = options.scenes[index - 1];
    const explicitSetting = scene.visualChanges?.environment?.set;
    if (explicitSetting?.locationId || explicitSetting?.description || (previousScene?.location && scene.location && !samePlace(previousScene.location,scene.location)) || (previousScene?.sequence?.id && scene.sequence?.id && previousScene.sequence.id !== scene.sequence.id)) delete current.spatial;
    const startState = cloneState(current);
    const factProvenance: Record<string, VisualContinuityFactProvenance> = {};
    for (const character of startState.characters) factProvenance[`characters.${character.name}`] = factSource.get(`characters.${character.name}`) ?? "previous_scene";
    if (startState.environment) factProvenance.environment = factSource.get("environment") ?? "previous_scene";
    for (const object of startState.objects) factProvenance[`objects.${object.name}`] = factSource.get(`objects.${object.name}`) ?? "previous_scene";

    const location = explicitSetting?.locationId ?? scene.location ?? explicitSetting?.description;
    const stableLocationId = entityId("location", location);
    const locationKey = (stableLocationId ?? location)?.trim().toLowerCase();
    const previousLocation = current.activeLocationKey ?? current.environment?.locationId ?? current.environment?.description;
    const changedLocation = Boolean(location && !samePlace(locationKey, previousLocation));
    if (changedLocation) {
      if (current.environment) decisions.push({ kind: "overridden", summary: `Scene ${scene.id} establishes a new setting: ${location}`, provenance: "current_narration" });
      const remembered = locationKey && current.knownLocations && Object.hasOwn(current.knownLocations, locationKey)
        ? current.knownLocations[locationKey]
        : undefined;
      current.environment = { ...remembered, description: remembered?.description ?? scene.location ?? explicitSetting?.description, locationId: stableLocationId ?? explicitSetting?.locationId };
      delete current.spatial;
      factProvenance.environment = remembered ? "previous_chapter" : "current_narration";
    }

    if (locationKey) current.activeLocationKey = locationKey;

    if (scene.sequence?.axis || scene.sequence?.positions.length) {
      const inherited = scene.sequence.axis ? [] : (current.spatial?.split("; ") ?? []).filter(part => !scene.sequence!.positions.some(p => part.startsWith(`${p.name}:`)));
      current.spatial = [scene.sequence.axis, ...inherited, ...scene.sequence.positions.map(p => `${p.name}: ${p.position}, facing ${p.facing}${p.movement ? `, ${p.movement}` : ""}`)].filter(Boolean).join("; ").slice(0,500);
    }
    const changes = (scene.visualChanges || returning) ? {
      ...scene.visualChanges,
      environment: scene.visualChanges?.environment && {
        ...scene.visualChanges.environment,
        set: scene.visualChanges.environment.set && {
          ...scene.visualChanges.environment.set,
          ...(stableLocationId ? { locationId: stableLocationId } : {}),
        },
      },
      transition: scene.visualChanges?.transition ?? (returning ? "time_jump" as const : undefined),
      characters: scene.visualChanges?.characters?.map(delta => ({
        ...delta, entityId: entityId("character", delta.entityId) ?? delta.entityId ?? entityId("character", delta.name),
      })),
    } : undefined;
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
        applyManualStatePatch(current, {
          ...override.setState,
          characters: override.setState.characters?.map(character => ({
            ...character,
            entityId: entityId("character", character.entityId) ?? character.entityId ?? entityId("character", character.name),
          })),
          environment: override.setState.environment && {
            ...override.setState.environment,
            ...(entityId("location", override.setState.environment.locationId) ? { locationId: entityId("location", override.setState.environment.locationId) } : {}),
          },
        });
        for (const character of override.setState.characters ?? []) factSource.set(`characters.${character.name}`, "manual_override");
        if (override.setState.environment) factSource.set("environment", "manual_override");
        for (const object of override.setState.objects ?? []) factSource.set(`objects.${object.name}`, "manual_override");
        decisions.push({ kind: "manual", summary: `Manual continuity override applied at ${scene.id}${override.note ? `: ${override.note}` : ""}`, provenance: "manual_override" });
        factProvenance.manual = "manual_override";
      } else if (override.note || override.usePreviousReference) {
        decisions.push({ kind: "manual", summary: `Manual continuity note at ${scene.id}${stale ? " (stale; setState skipped)" : ""}`, provenance: "manual_override" });
      }
      manualOverride = { fields: !stale ? [...(override.setState?.characters ?? []).flatMap(c => Object.keys(c).filter(k => k !== "name" && k !== "entityId").map(k => `characters.${c.name}.${k}`)), ...Object.keys(override.setState?.environment ?? {}).map(k => `environment.${k}`)] : [], note: override.note, usePreviousReference: override.usePreviousReference, revision: override.revision, stale };
    }

    // Remember durable setting details only. Time, lighting and weather belong to the frame.
    const effectiveLocation = locationKey ?? current.activeLocationKey ?? current.environment?.locationId ?? current.environment?.description;
    if (effectiveLocation && current.environment) {
      const { locationId, description, condition, damage } = current.environment;
      current.knownLocations = {
        ...current.knownLocations,
        [effectiveLocation.trim().toLowerCase()]: { locationId, description, condition, damage },
      };
    }

    const referenceOverride = manualOverride?.stale ? undefined : override;
    const referenceDecision = isHistorical || returning
      ? { kind: "none" as const, used: false, reason: "Narrative time discontinuity; prior frame excluded" }
      : index === 0
      ? decidePreviousChapterReference(handoff, stableLocationId ? { ...scene, location: stableLocationId } : scene, referenceOverride, decisions)
      : decidePreviousSceneReference(options.scenes[index - 1]!, scene, referenceOverride);

    perScene.push({ sceneId: scene.id, historical: isHistorical, historicalStateAvailable: isHistorical ? options.history?.has(historicalChapter ?? 0) ?? false : undefined, startState, changes, endState: cloneState(current), factProvenance, referenceDecision, manualOverride });
  }

  return { perScene, chapterEndState: cloneState(presentState ?? current), decisions };
}

function decidePreviousChapterReference(
  handoff: { chapter: number; sceneId: string; state: VisualContinuityState; referenceArtwork?: VisualContinuityHandoff["referenceArtwork"] } | undefined,
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
  if ((scene.appearanceChapter !== undefined && scene.appearanceChapter < handoff.chapter) || (scene.visualChanges?.transition && scene.visualChanges.transition !== "continuous")) return { kind: "previous-chapter", used: false, reason: "Narrative time discontinuity; prior frame excluded" };
  const set = scene.visualChanges?.environment?.set;
  const previousLocation = handoff.state.activeLocationKey ?? handoff.state.environment?.locationId ?? handoff.state.environment?.description;
  const settingChanged = Boolean(set && (set.locationId || set.description || set.timeOfDay))
    || Boolean(scene.location && !samePlace(scene.location, previousLocation));
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
  if ((scene.appearanceChapter !== undefined && previous.appearanceChapter !== undefined && scene.appearanceChapter < previous.appearanceChapter) || (scene.visualChanges?.transition && scene.visualChanges.transition !== "continuous")) return { kind: "previous-scene", used: false, reason: "Narrative time discontinuity; prior frame excluded", sourceSceneId: previous.id };
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
      character.activeAbilities !== undefined && `active abilities: ${character.activeAbilities.join(", ") || "none (inactive baseline)"}`,
      character.visibleEquipment !== undefined && `visible equipment: ${character.visibleEquipment.join(", ") || "none"}`,
      character.concealedItems?.length && `concealed/stored (do not display): ${character.concealedItems.join(", ")}`,
      character.equipment && `equipment possession (visibility must be established): ${character.equipment}`,
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
export function renderSceneContinuity(resolved: ResolvedSceneContinuity, maxCharacters = 2400): string | undefined {
  const lines: string[] = [];
  const stateText = renderContinuityForPlanner(resolved.endState, maxCharacters);
  if (stateText !== "No prior visual continuity state.") lines.push(`RESOLVED CURRENT FRAME STATE (after scene changes and manual overrides):\n${stateText}`);
  if (resolved.changes) {
    const notes: string[] = [];
    if (resolved.changes.transition) notes.push(`Narrative time: ${resolved.changes.transition}`);
    for (const delta of resolved.changes.characters ?? []) {
      if (delta.clear?.length) notes.push(`${delta.name}: explicitly cleared ${delta.clear.join(", ")} — do not restore those features from a reference or earlier scene`);
      notes.push(`${delta.name}: ${delta.op}${delta.set ? ` (${Object.entries(delta.set).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("; ")})` : ""}`);
    }
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
  sourceFacts?: VisualContinuityHandoff["sourceFacts"];
  referenceArtwork?: VisualContinuityHandoff["referenceArtwork"];
  origin: "automatic" | "manual" | "derived";
};

const previousContinuityCache = new Map<string, { signature: string; value?: PreviousVisualContinuity; history: Map<number, VisualContinuityState> }>();
function continuityInputFingerprint(scenes: ManifestSceneLike[], overlay: VisualContinuityOverlay, previous: PreviousVisualContinuity | undefined, entities: CanonicalEntity[], history: ReadonlyMap<number, VisualContinuityState>) {
  return fingerprint({ version: "continuity-input-v6", identities: entities.map(entity => [entity.id, entity.type, entity.mergedFromIds, identityNames(entity)]), historical: scenes.map(scene => scene.overrides?.appearanceChapter === undefined ? null : history.get(scene.overrides.appearanceChapter) ?? null), scenes: continuitySceneInputs({ scenes }).map(input => ({ ...input, narrationText: scenes.find(scene => scene.id === input.id)?.narrationText })), overlay, previous: previous && { chapter: previous.chapter, stateFingerprint: previous.stateFingerprint, sourceFacts: previous.sourceFacts, referenceArtwork: previous.referenceArtwork } });
}

/** Reconcile manifests in chapter order. A saved handoff is a reusable cache
 * only while its own scene/overlay inputs and upstream state still match. */
export async function resolvePreviousVisualContinuity(root: string, slug: string, chapter: number): Promise<PreviousVisualContinuity | undefined> {
  return (await resolveContinuityHistory(root, slug, chapter)).previous;
}

async function resolveContinuityHistory(root: string, slug: string, chapter: number) {
  const entities = (await loadStoryBibleWithCanonicalOverlay(root, slug)).canonicalEntities;
  const history = new Map<number, VisualContinuityState>();
  let names: string[];
  try { names = await readdir(join(storyPaths(root, slug, chapter).story, "chapters")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { previous: undefined, history, entities }; throw error; }
  const chapters = names.map(name => /^\d{4,}$/.test(name) ? Number(name) : NaN).filter(n => Number.isSafeInteger(n) && n > 0 && n < chapter).sort((a,b) => a-b);
  const signature = fingerprint([entities.map(entity => [entity.id, entity.type, entity.mergedFromIds, identityNames(entity)]), await Promise.all(chapters.map(async number => {
    const paths = storyPaths(root,slug,number);
    return [number, await Promise.all([paths.scenesManifest,paths.visualContinuityManual,paths.visualContinuity].map(async path => {
      try { const info = await stat(path); return [info.ino,info.size,info.mtimeMs,info.ctimeMs]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    }))];
  }))]);
  const key = JSON.stringify([root,slug,chapter]); const cached = previousContinuityCache.get(key);
  if (cached?.signature === signature) return { previous: structuredClone(cached.value), history: structuredClone(cached.history), entities };
  const { sceneManifestSchema } = await import("../scenes/types.js");
  let previous: PreviousVisualContinuity | undefined;
  for (const number of chapters) {
    const raw = await readJsonIfExists(storyPaths(root,slug,number).scenesManifest).catch(error => { if (error instanceof SyntaxError) return undefined; throw error; });
    const manifest = sceneManifestSchema.safeParse(raw);
    const saved = await loadVisualContinuityHandoff(root,slug,number);
    if (!manifest.success) {
      if (saved) history.set(number, saved.state);
      if (saved) previous = { chapter: number, sceneId: saved.source.sceneId, state: saved.state, stateFingerprint: saved.stateFingerprint, sourceFacts: saved.sourceFacts, referenceArtwork: saved.referenceArtwork, origin: saved.origin };
      continue;
    }
    const scenes = manifest.data.scenes.filter(scene => !scene.disabled);
    if (!scenes.length) continue;
    const overlay = await loadVisualContinuityOverlay(root,slug,number);
    if (saved?.inputFingerprint === continuityInputFingerprint(scenes, overlay, previous, entities, history)) {
      history.set(number, saved.state);
      previous = { chapter: number, sceneId: saved.source.sceneId, state: saved.state, stateFingerprint: saved.stateFingerprint, sourceFacts: saved.sourceFacts, referenceArtwork: saved.referenceArtwork, origin: saved.origin };
      continue;
    }
    const resolved = resolveVisualContinuity({ previousHandoff: previous ? { ...previous } : undefined, scenes: continuitySceneInputs({scenes}), manualOverrides: overlay, chapter: number, history, entities });
    history.set(number, resolved.chapterEndState);
    previous = { chapter: number, sceneId: scenes.at(-1)!.id, state: resolved.chapterEndState, stateFingerprint: fingerprint(resolved.chapterEndState), sourceFacts: continuitySourceFacts(scenes,overlay,resolved,number,previous), referenceArtwork: resolved.perScene.at(-1)?.historical ? undefined : approvedReferenceArtwork(scenes), origin: "derived" };
  }
  if (previousContinuityCache.size >= 64) previousContinuityCache.delete(previousContinuityCache.keys().next().value!);
  previousContinuityCache.set(key,{signature,value: structuredClone(previous), history });
  return { previous, history, entities };
}

type ManifestSceneLike = {
  disabled?: boolean;
  summary?: string; visualPrompt?: string;
  narrationText?: string;
  sequence?: ContinuitySceneInput["sequence"];
  overrides?: { appearanceChapter?: number };
  id: string;
  location?: string;
  visualChanges?: VisualContinuityChange;
  artwork: { approvedVersionId?: string; versions: Array<{ id: string; versionNumber: number; imageFingerprint: string }> };
};

export function continuitySceneInputs(manifest: { scenes: ManifestSceneLike[] }, contentFingerprints?: Record<string, string>): ContinuitySceneInput[] {
  return manifest.scenes.filter(scene => !scene.disabled).map((scene) => {
    const approved = scene.artwork.approvedVersionId ? scene.artwork.versions.find((version) => version.id === scene.artwork.approvedVersionId) : undefined;
    return {
      id: scene.id,
      sequence: scene.sequence,
      appearanceChapter: scene.overrides?.appearanceChapter,
      location: scene.location,
      visualChanges: scene.visualChanges,
      approvedArtwork: approved ? { versionId: approved.id, versionNumber: approved.versionNumber, imageFingerprint: approved.imageFingerprint } : undefined,
      contentFingerprint: contentFingerprints?.[scene.id] ?? (scene.summary !== undefined && scene.visualPrompt !== undefined ? fingerprint(sceneEditableState(scene as Scene)) : undefined),
    };
  });
}

export function approvedReferenceArtwork(scenes: ManifestSceneLike[]): VisualContinuityHandoff["referenceArtwork"] | undefined {
  const finalScene = scenes.filter(scene => !scene.disabled).at(-1);
  if (!finalScene?.artwork.approvedVersionId) return undefined;
  const version = finalScene.artwork.versions.find((item) => item.id === finalScene.artwork.approvedVersionId);
  return version ? { sceneId: finalScene.id, versionId: version.id, versionNumber: version.versionNumber, imageFingerprint: version.imageFingerprint } : undefined;
}

function continuitySourceFacts(scenes: ManifestSceneLike[], overlay: VisualContinuityOverlay, resolved: ResolvedVisualContinuity, chapter: number, previous?: PreviousVisualContinuity) {
  const sourceFacts: NonNullable<VisualContinuityHandoff["sourceFacts"]> = { ...previous?.sourceFacts };
  for (const scene of scenes.filter(scene => !scene.disabled)) {
    if (resolved.perScene.find(entry => entry.sceneId === scene.id)?.historical) continue;
    const record = (subject: string, field: string, value: unknown) => {
      const key = JSON.stringify([subject, field]);
      if (scene.narrationText?.trim()) sourceFacts[key] = { subject, field, valueFingerprint: fingerprint(value), chapter: chapter, sceneId: scene.id, passage: scene.narrationText.slice(0,8000) };
      else delete sourceFacts[key];
    };
    for (const delta of scene.visualChanges?.characters ?? []) {
      for (const field of delta.clear ?? []) delete sourceFacts[JSON.stringify([delta.name,field])];
      for (const [field,value] of Object.entries(delta.set ?? {})) record(delta.name,field,value);
    }
    for (const [field,value] of Object.entries(scene.visualChanges?.environment?.set ?? {})) record("Environment",field,value);
    const effective = resolved.perScene.find(entry => entry.sceneId === scene.id)?.manualOverride;
    const manual = effective && !effective.stale ? overlay.entries.find(entry => entry.sceneId === scene.id)?.setState : undefined;
    for (const character of manual?.characters ?? []) for (const field of Object.keys(character)) delete sourceFacts[JSON.stringify([character.name,field])];
    for (const field of Object.keys(manual?.environment ?? {})) delete sourceFacts[JSON.stringify(["Environment",field])];
  }
  for (const [key,fact] of Object.entries(sourceFacts)) {
    const value = fact.subject === "Environment" ? (resolved.chapterEndState.environment as Record<string,unknown> | undefined)?.[fact.field] : (resolved.chapterEndState.characters.find(character => character.name === fact.subject) as Record<string,unknown> | undefined)?.[fact.field];
    if (value === undefined || fingerprint(value) !== fact.valueFingerprint) delete sourceFacts[key];
  }
  return sourceFacts;
}

/** Resolve the chapter's continuity package and persist the handoff artifact.
 * Recomputed from manifest deltas + previous handoff + overlay (no dual state
 * store); the write is skipped when nothing semantically changed. */
export async function persistChapterVisualContinuity(options: {
  root: string;
  slug: string;
  chapter: number;
  manifest: { chapter: number; planningFingerprint?: string; scenes: ManifestSceneLike[] };
  origin?: "automatic" | "manual";
}): Promise<ResolvedVisualContinuity> {
  const { previous, overlay, resolved, inputFingerprint } = await resolveChapterVisualContinuity(options);
  const finalScene = options.manifest.scenes.filter(scene => !scene.disabled).at(-1);
  if (!finalScene) throw new Error("Continuity requires at least one enabled scene");
  const sourceFacts = continuitySourceFacts(options.manifest.scenes, overlay, resolved, options.chapter, previous);
  const existing = await loadVisualContinuityHandoff(options.root, options.slug, options.chapter);
  const sceneBaselines = Object.fromEntries(continuitySceneInputs(options.manifest).flatMap(input => {
    const state = resolved.perScene.find(entry => entry.sceneId === input.id);
    if (!state || !input.contentFingerprint) return [];
    const prior = existing?.sceneBaselines?.[input.id];
    const sceneFingerprint = fingerprint([options.manifest.planningFingerprint, input.contentFingerprint]);
    return [[input.id, prior?.sceneFingerprint === sceneFingerprint
      ? prior
      : { sceneFingerprint, snapshot: continuitySnapshot(state) }]];
  }));
  const artifact: VisualContinuityHandoff = {
    version: 1,
    chapter: options.chapter,
    state: resolved.chapterEndState,
    source: { chapter: options.chapter, sceneId: finalScene.id },
    stateFingerprint: fingerprint(resolved.chapterEndState),
    sourceFacts,
    sceneBaselines,
    inputFingerprint,
    referenceArtwork: resolved.perScene.at(-1)?.historical ? undefined : approvedReferenceArtwork(options.manifest.scenes),
    origin: options.origin ?? "automatic",
    updatedAt: new Date().toISOString(),
  };
  const unchanged = existing
    && existing.stateFingerprint === artifact.stateFingerprint
    && existing.source.sceneId === artifact.source.sceneId
    && fingerprint(existing.referenceArtwork ?? null) === fingerprint(artifact.referenceArtwork ?? null)
    && existing.inputFingerprint === artifact.inputFingerprint
    && fingerprint(existing.sceneBaselines ?? {}) === fingerprint(sceneBaselines)
    && existing.origin === artifact.origin
    && fingerprint(existing.sourceFacts ?? {}) === fingerprint(artifact.sourceFacts ?? {});
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
}): Promise<{ resolved: ResolvedVisualContinuity; previous?: PreviousVisualContinuity; overlay: VisualContinuityOverlay; inputFingerprint: string }> {
  const { previous, history, entities } = await resolveContinuityHistory(options.root, options.slug, options.chapter);
  const overlay = await loadVisualContinuityOverlay(options.root, options.slug, options.chapter);
  const resolved = resolveVisualContinuity({
    previousHandoff: previous ? { chapter: previous.chapter, sceneId: previous.sceneId, state: previous.state, referenceArtwork: previous.referenceArtwork } : undefined,
    scenes: continuitySceneInputs(options.manifest, options.contentFingerprints),
    manualOverrides: overlay,
    chapter: options.chapter, history, entities,
  });
  return { resolved, previous, overlay, inputFingerprint: continuityInputFingerprint(options.manifest.scenes.filter(scene => !scene.disabled), overlay, previous, entities, history) };
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
