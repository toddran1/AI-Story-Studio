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
const VALID_ASPECT_RATIOS = new Set<string>(["16:9", "1:1", "9:16"]);

/** Resolve the effective aspect ratio for composition guidance.
 * Precedence:
 * 1. Modern story.artwork.aspectRatio (authoritative whenever present and valid: 16:9, 1:1, 9:16)
 * 2. Art Direction aspect ratio fallback
 * 3. Legacy artwork.size inference (e.g. 1024x1536 -> 9:16, 1024x1024 -> 1:1, 1536x1024 -> 16:9)
 * 4. Default 16:9
 */
export function resolveArtworkAspectRatio(
  story: Pick<Story, "artwork">,
  story: { artwork?: { aspectRatio?: string; size?: string } } | Pick<Story, "artwork">,
  artDirection?: { aspectRatio?: string }
): ImageAspectRatio {
  if (story.artwork?.aspectRatio && story.artwork.aspectRatio !== "16:9") {
    return story.artwork.aspectRatio;
  // 1. Modern story.artwork.aspectRatio is authoritative whenever present and valid
  if (story.artwork?.aspectRatio && VALID_ASPECT_RATIOS.has(story.artwork.aspectRatio)) {
    return story.artwork.aspectRatio as ImageAspectRatio;
  }
  if (artDirection?.aspectRatio && artDirection.aspectRatio !== "16:9") {

  // 2. Art Direction aspect ratio fallback
  if (artDirection?.aspectRatio && VALID_ASPECT_RATIOS.has(artDirection.aspectRatio)) {
    return artDirection.aspectRatio as ImageAspectRatio;
  }
  // Check legacy size if aspectRatio was left at default "16:9"
  if (story.artwork?.size === "1024x1536") return "9:16";
  if (story.artwork?.size === "1024x1024") return "1:1";
  return story.artwork?.aspectRatio ?? (artDirection?.aspectRatio as ImageAspectRatio) ?? "16:9";

  // 3. Legacy artwork.size inference
  if (story.artwork?.size) {
    if (story.artwork.size === "1024x1536") return "9:16";
    if (story.artwork.size === "1024x1024") return "1:1";
    if (story.artwork.size === "1536x1024") return "16:9";
    const [width = 0, height = 0] = story.artwork.size.split("x").map(Number);
    if (width > 0 && height > 0) {
      if (width === height) return "1:1";
      if (width < height) return "9:16";
      return "16:9";
    }
  }

  // 4. Default
  return "16:9";
}

