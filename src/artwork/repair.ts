import { z } from "zod";
import type { ImageProvider, ImageReferenceImage } from "./provider.js";
import { MAX_REFERENCE_IMAGE_BYTES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_TOTAL_BYTES, providerSupportsReferenceImages } from "./providers.js";
import type { Story } from "../domain/story.js";
import { readVisualCheckImage } from "./visual-check.js";
import { fingerprint } from "../utils/hash.js";
export const artworkRepairSchema = z.object({ sourceVersionId: z.string().trim().min(1).max(200), instruction: z.string().trim().min(1).max(2000) }).strict();
export type ArtworkRepair = z.infer<typeof artworkRepairSchema>;
export async function prepareArtworkRepair(story: Story, provider: ImageProvider, path: string, repair: ArtworkRepair, references: ImageReferenceImage[], prompt: string) {
  if (provider.capabilities?.supportsReferenceImages === false || provider.capabilities?.maxReferenceImages === 0 || !providerSupportsReferenceImages(provider.name, story.artwork.model)) throw new Error("This image model cannot consume a source image for targeted repair. Select an image-capable artwork model.");
  const source = await readVisualCheckImage(path);
  if (source.image.data.length > MAX_REFERENCE_IMAGE_BYTES) throw new Error("Repair source exceeds the provider reference image limit. Use a smaller source original.");
  const selected: ImageReferenceImage[] = [{ ...source.image, sourceKind: "continuity", role: "repair-source" }];
  let bytes = source.image.data.length;
  for (const ref of references) if (selected.length < Math.min(MAX_REFERENCE_IMAGES, provider.capabilities?.maxReferenceImages ?? MAX_REFERENCE_IMAGES) && bytes + ref.data.length <= MAX_REFERENCE_TOTAL_BYTES) { selected.push(ref); bytes += ref.data.length; }
  return { references: selected, fingerprint: fingerprint({ repair, source: source.fingerprint, prompt }), prompt: `${prompt}\n\nREFERENCE ORDER FOR THIS REPAIR:\n${selected.map((ref,index) => `${index+1}: ${ref.role === "repair-source" ? "source frame to edit" : `${ref.entityName ?? "scene"} (${ref.role ?? "design"})`}`).join("\n")}\n\nTARGETED REPAIR: Reference image 1 is the exact source artwork to edit. Apply only this correction: ${repair.instruction}\nPreserve the source frame's accepted character identities, faces, body proportions, clothing, pose, lighting, setting, composition and unrelated details except where the correction explicitly requires a change. Later references are identity/design support only. Produce one repaired still, not a before/after comparison.` };
}
