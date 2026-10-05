import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { VisualEntityProfile, VisualReferenceImage } from "../domain/visual-profile.js";
import type { ImageProvider, ImageReferenceImage } from "../artwork/provider.js";
import type { Story } from "../domain/story.js";
import { MAX_REFERENCE_IMAGE_BYTES, providerSupportsReferenceImages } from "../artwork/providers.js";
import { findVisualReferenceFile, mimeForVisualReferenceExtension } from "./assets.js";

export type ReferenceSheetScope = { appearanceEraId?: string; creatureFormId?: string };
export function identityReferenceCandidates(profile: VisualEntityProfile, scope: ReferenceSheetScope): VisualReferenceImage[] {
  const era = profile.appearanceEras?.find(item => item.id === scope.appearanceEraId);
  const form = profile.creatureForms?.find(item => item.id === scope.creatureFormId);
  const own = era?.referenceIds ?? form?.referenceIds ?? [];
  const assigned = new Set([...(profile.appearanceEras ?? []).flatMap(item => item.referenceIds), ...(profile.creatureForms ?? []).flatMap(item => item.referenceIds)]);
  const priorEra = era ? profile.appearanceEras?.filter(item => item.status === "approved" && item.startChapter < era.startChapter).sort((a,b) => b.startChapter-a.startChapter)[0] : undefined;
  const living = form ? profile.creatureForms?.find(item => item.status === "approved" && item.state === "living" && item.id !== form.id) : undefined;
  const ordered = [own, priorEra?.referenceIds ?? [], profile.references.filter(ref => !assigned.has(ref.id)).map(ref => ref.id), living?.referenceIds ?? []];
  const all: VisualReferenceImage[] = [];
  for (const ids of ordered) {
    const candidates = profile.references.filter(ref => ref.approved && ids.includes(ref.id)).sort((a,b) => Number(b.role === "primary_reference") - Number(a.role === "primary_reference") || b.createdAt.localeCompare(a.createdAt));
    for (const candidate of candidates) if (!all.some(ref => ref.id === candidate.id)) all.push(candidate);
  }
  return all;
}

/** One verified identity image prevents competing forms from dominating an edit. */
export async function prepareReferenceSheetIdentity(root: string, slug: string, profile: VisualEntityProfile, story: Story, provider: ImageProvider, scope: ReferenceSheetScope) {
  const candidates = identityReferenceCandidates(profile, scope);
  const supported = provider.capabilities?.supportsReferenceImages !== false && (provider.capabilities?.maxReferenceImages ?? 1) > 0 && providerSupportsReferenceImages(story.artwork.provider, story.artwork.model);
  if (!supported) return { images: [] as ImageReferenceImage[], fingerprints: [] as string[], mode: "text-only" as const, reason: "The configured image model cannot consume identity images." };
  for (const ref of candidates) {
    const file = await findVisualReferenceFile(root, slug, profile.entityId, ref.id);
    if (!file) continue;
    const size = (await stat(file.path)).size;
    if (!size || size > MAX_REFERENCE_IMAGE_BYTES) continue;
    const data = await readFile(file.path);
    if (!data.length || data.length > MAX_REFERENCE_IMAGE_BYTES) continue;
    const hash = createHash("sha256").update(data).digest("hex");
    if (ref.provenance?.imageFingerprint && ref.provenance.imageFingerprint !== hash) continue;
    return { images: [{ data, mimeType: mimeForVisualReferenceExtension(file.ext), sourceKind: "visual-profile" as const, entityId: profile.entityId, referenceId: ref.id, role: ref.role }], fingerprints: [hash], mode: "image-conditioned" as const, reason: "An approved identity reference is supplied; the target design controls transformed anatomy." };
  }
  return { images: [] as ImageReferenceImage[], fingerprints: [] as string[], mode: "text-only" as const, reason: candidates.length ? "Approved identity images are missing or exceed the image size limit." : "No approved identity image is available yet." };
}

export const IDENTITY_TRANSFORMATION_INSTRUCTION = "IDENTITY REFERENCE: Preserve recognizable identity, proportions, silhouette and signature features only where compatible with the TARGET DESIGN. The TARGET DESIGN overrides the reference's living/dead state, flesh, skin, scales, clothing and changed anatomy. A skeleton target must have the described exposed bones, not living flesh copied from its reference. Render the target as a neutral reusable sheet; do not clone panels into additional story entities.";
