import { ImageAspectRatio } from "./provider.js";
import { Story } from "../domain/story.js";

/** Centralized provider-neutral visual composition guidance for the configured artwork aspect ratio.
 * Guides the image model to compose inside a safe area suitable for deterministic post-generation
 * normalization and crop safety without horizontal/vertical stretching. */
export function artworkCompositionGuidance(aspectRatio: ImageAspectRatio = "16:9"): string {
  switch (aspectRatio) {
    case "9:16":
      return (
        "COMPOSITION: 9:16 portrait frame.\n" +
        "Compose specifically for a tall vertical canvas in a portrait-safe composition. Arrange characters, faces, actions, and important objects for vertical framing.\n" +
        "Keep essential visual details, faces, heads, and key carried items inside the composition-safe area and avoid placing important subjects at the extreme top or bottom edges, without creating excessive empty space."
      );
    case "1:1":
      return (
        "COMPOSITION: 1:1 square frame.\n" +
        "Compose specifically for a square canvas in a square-safe composition. Keep the primary subjects, essential faces, key character interactions, and important story elements well-balanced within the square composition-safe area, without placing critical details against the outer edges."
      );
    case "16:9":
    default:
      return (
        "COMPOSITION: 16:9 landscape cinematic frame.\n" +
        "Compose specifically for a wide landscape canvas in a landscape-safe composition. Keep all essential characters, faces, heads, narratively important hands, weapons, critical carried or environmental objects, and key character interactions inside the composition-safe area.\n" +
        "Avoid placing essential subjects too close to the extreme left or right edges so the frame remains crop-safe when normalized to the exact final 16:9 production frame, without creating excessive empty space."
      );
  }
}

/** Resolve the effective aspect ratio for composition guidance, honoring configured artwork
 * aspectRatio with fallback to legacy size dimensions if aspectRatio was left at default. */
export function resolveArtworkAspectRatio(
  story: Pick<Story, "artwork">,
  artDirection?: { aspectRatio?: string }
): ImageAspectRatio {
  if (story.artwork?.aspectRatio && story.artwork.aspectRatio !== "16:9") {
    return story.artwork.aspectRatio;
  }
  if (artDirection?.aspectRatio && artDirection.aspectRatio !== "16:9") {
    return artDirection.aspectRatio as ImageAspectRatio;
  }
  // Check legacy size if aspectRatio was left at default "16:9"
  if (story.artwork?.size === "1024x1536") return "9:16";
  if (story.artwork?.size === "1024x1024") return "1:1";
  return story.artwork?.aspectRatio ?? (artDirection?.aspectRatio as ImageAspectRatio) ?? "16:9";
}

