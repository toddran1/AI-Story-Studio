import type { Scene } from "../../../src/scenes/types.js";

export function sceneEditableValues(scene: Scene) {
  return {
    summary: scene.summary, visualPrompt: scene.visualPrompt, characters: scene.characters,
    entityIds: scene.entityIds ?? [], location: scene.location, startSeconds: scene.startSeconds,
    endSeconds: scene.endSeconds, disabled: scene.disabled, importance: scene.importance,
    direction: scene.direction, overrides: scene.overrides, visualChanges: scene.visualChanges,
  };
}

export function dirtySceneIds(draft: Scene[], saved: Scene[]): Set<string> {
  const persisted = new Map(saved.map((scene) => [scene.id, scene]));
  return new Set(draft.filter((scene) => {
    const original = persisted.get(scene.id);
    return original && JSON.stringify(sceneEditableValues(scene)) !== JSON.stringify(sceneEditableValues(original));
  }).map((scene) => scene.id));
}

export function scenePlanStructureDirty(draft: Scene[], saved: Scene[]): boolean {
  return draft.map((scene) => scene.id).join("|") !== saved.map((scene) => scene.id).join("|");
}

export function reconcileSceneDrafts(draft: Scene[], oldSaved: Scene[], newSaved: Scene[]): Scene[] {
  const edited = dirtySceneIds(draft, oldSaved);
  const byId = new Map(draft.map((scene) => [scene.id, scene]));
  if (scenePlanStructureDirty(draft, oldSaved)) {
    const persisted = new Map(newSaved.map((scene) => [scene.id, scene]));
    return draft.map((scene) => edited.has(scene.id) ? scene : persisted.get(scene.id) ?? scene);
  }
  return newSaved.map((scene) => edited.has(scene.id) ? byId.get(scene.id) ?? scene : scene);
}
