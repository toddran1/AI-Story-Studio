import type { Scene } from "./types.js";

/** Fields that define a manually editable scene beat. Artwork is intentionally excluded. */
export function sceneEditableState(scene: Scene) {
  return {
    summary: scene.summary,
    startSeconds: scene.startSeconds,
    endSeconds: scene.endSeconds,
    characters: scene.characters,
    entityIds: scene.entityIds ?? [],
    location: scene.location,
    visualPrompt: scene.visualPrompt,
    importance: scene.importance,
    disabled: scene.disabled ?? false,
    direction: scene.direction,
    overrides: scene.overrides,
    visualChanges: scene.visualChanges,
  };
}

/** Toggling a scene's participation does not alter the image itself. */
export function sceneArtworkContentState(scene: Scene) {
  const { disabled: _disabled, ...state } = sceneEditableState(scene);
  return state;
}
