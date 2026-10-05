import { characterDesignContext } from "./character-design.js";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { findVisualReferenceFile } from "./assets.js";
import { MAX_REFERENCE_IMAGE_BYTES } from "../artwork/providers.js";
import { requireCanonicalStoryBibleEntity, loadStoryBibleWithCanonicalOverlay } from "../story-bible/canonical.js";
import { z } from "zod";
import type { Story } from "../domain/story.js";
import type { ImageProvider } from "../artwork/provider.js";
import { canonicalEntitySchema } from "../domain/story-bible.js";
import { loadVisualProfiles, generateStyleSheet, canApproveVisualProfile, referenceSheetTargetFingerprint } from "./profiles.js";
import { loadStoryArtDirection, resolveActiveArtDirection } from "./art-direction.js";
import { prepareReferenceSheetIdentity } from "./reference-identity.js";
import { pricingFor, calculateCost } from "../cost/pricing.js";
import { fingerprint } from "../utils/hash.js";
import { withUsageScope } from "../cost/context.js";

export const referenceSelectionSchema = z.object({ entityId: canonicalEntitySchema.shape.id, kind: z.enum(["profile", "era", "form"]), scopeId: z.string().min(1).max(200).optional() }).strict().refine(item => item.kind === "profile" ? item.scopeId === undefined : !!item.scopeId, { message: "Select a scope ID for a form or era" });
export const referenceBatchInputSchema = z.object({ selection: z.array(referenceSelectionSchema).min(1).max(100), force: z.boolean().default(false) }).strict();
export type ReferenceBatchInput = z.infer<typeof referenceBatchInputSchema>;
export type ReferenceBatchEntry = z.infer<typeof referenceSelectionSchema> & { key: string; label: string; targetFingerprint?: string; reuseReferenceId?: string; blockedReason?: string; identityMode?: string; identityReason?: string };
export type ReferenceBatchPlan = { entries: ReferenceBatchEntry[]; fingerprint: string; imageCount: number; estimatedCostUsd?: number; costNote: string; provider: string; model: string; force: boolean };

export async function planReferenceBatch(root: string, story: Story, provider: ImageProvider, raw: unknown): Promise<ReferenceBatchPlan> {
  const input = referenceBatchInputSchema.parse(raw); const profiles = await loadVisualProfiles(root, story.slug);
  const bible = await loadStoryBibleWithCanonicalOverlay(root, story.slug);
  const direction = resolveActiveArtDirection(await loadStoryArtDirection(root, story.slug));
  const entries: ReferenceBatchEntry[] = []; const seen = new Set<string>();
  for (const item of input.selection) {
    const key = `${item.entityId}:${item.kind}:${item.scopeId ?? "base"}`; if (seen.has(key)) continue; seen.add(key);
    const entity = await requireCanonicalStoryBibleEntity(root, story.slug, item.entityId);
    const profile = profiles[item.entityId];
    const scope = { appearanceEraId: item.kind === "era" ? item.scopeId : undefined, creatureFormId: item.kind === "form" ? item.scopeId : undefined };
    const design = item.kind === "era" ? profile?.appearanceEras?.find(era => era.id === item.scopeId) : item.kind === "form" ? profile?.creatureForms?.find(form => form.id === item.scopeId) : profile;
    let blockedReason: string | undefined;
    if (!profile || !design) blockedReason = "Review and save the visual design first.";
    else if (profile.conflicts?.some(conflict => conflict.status === "needs_review")) blockedReason = "Resolve visual conflicts first.";
    else if (item.kind === "era" && profile.appearanceEras?.find(era => era.id === item.scopeId)?.detectedChange?.needsReview || item.kind === "form" && profile?.creatureForms?.find(form => form.id === item.scopeId)?.detectedSource?.needsReview) blockedReason = "Review changed source evidence first.";
    else if (item.kind === "profile" ? !canApproveVisualProfile(profile) : !design.appearance.trim() && !design.visualPrompt.trim() && !Object.values(design.character ?? design.creature ?? {}).some(value => typeof value === "string" && value.trim())) blockedReason = "Describe this visual design first.";
    const identity = profile && !blockedReason ? await prepareReferenceSheetIdentity(root, story.slug, profile, story, provider, scope) : undefined;
    const targetFingerprint = profile && identity ? referenceSheetTargetFingerprint(profile, story, direction, scope, identity.fingerprints, entity, profile.visualType === "character" ? characterDesignContext(bible, profiles, item.entityId) : []) : undefined;
    const assigned = new Set([...(profile?.appearanceEras ?? []).flatMap(era => era.referenceIds), ...(profile?.creatureForms ?? []).flatMap(form => form.referenceIds)]);
    const ids = item.kind === "era" ? profile?.appearanceEras?.find(era => era.id === item.scopeId)?.referenceIds : item.kind === "form" ? profile?.creatureForms?.find(form => form.id === item.scopeId)?.referenceIds : profile?.references.filter(ref => !assigned.has(ref.id)).map(ref => ref.id);
    const refs = profile?.references.filter(ref => ids?.includes(ref.id)) ?? [];
    // Approved sheets are intentional canon. A retry also reuses a candidate
    // generated from the same target and verified identity-image inputs.
    let reuse: (typeof refs)[number] | undefined;
    if (!input.force) for (const ref of refs) {
      if (!ref.approved && ref.provenance?.targetFingerprint !== targetFingerprint) continue;
      const file = await findVisualReferenceFile(root, story.slug, profile!.entityId, ref.id); if (!file) continue;
      const size = (await stat(file.path)).size; if (!size || size > MAX_REFERENCE_IMAGE_BYTES) continue;
      const data = await readFile(file.path); if (data.length > MAX_REFERENCE_IMAGE_BYTES) continue;
      if (ref.provenance?.imageFingerprint && ref.provenance.imageFingerprint !== createHash("sha256").update(data).digest("hex")) continue;
      reuse = ref; break;
    }
    entries.push({ ...item, key, label: design && "name" in design ? `${entity.canonicalName} · ${String(design.name)}` : entity.canonicalName, blockedReason, targetFingerprint, reuseReferenceId: reuse?.id, identityMode: identity?.mode, identityReason: identity?.reason });
  }
  const imageCount = entries.filter(entry => !entry.blockedReason && !entry.reuseReferenceId).length;
  const pricing = pricingFor(story.artwork.provider, story.artwork.model, story.artwork);
  return { entries, force: input.force, fingerprint: fingerprint({ entries, artwork: story.artwork, direction, force: input.force }), imageCount, estimatedCostUsd: calculateCost(pricing, { imageCount }), costNote: "Estimate uses the studio pricing catalog for output images; reference input, checks and provider retries may add cost.", provider: story.artwork.provider, model: story.artwork.model };
}

/** Caller holds the story lock. Every image is saved as an unapproved candidate. */
export async function runReferenceBatch(root: string, story: Story, provider: ImageProvider, plan: ReferenceBatchPlan, onProgress: (progress: unknown) => void, shouldStop: () => boolean = () => false) {
  const outcomes: Array<{ key: string; status: "generated" | "reused" | "failed"; referenceId?: string; error?: string }> = [];
  for (let index = 0; index < plan.entries.length; index++) {
    if (shouldStop()) return { status: "paused", outcomes, remaining: plan.entries.slice(index).map(entry => entry.key) };
    const entry = plan.entries[index]!;
    onProgress({ stage: "visual-reference", index: index + 1, total: plan.entries.length, label: entry.label, outcomes: [...outcomes] });
    if (entry.blockedReason) { outcomes.push({ key: entry.key, status: "failed", error: entry.blockedReason }); continue; }
    if (entry.reuseReferenceId) { outcomes.push({ key: entry.key, status: "reused", referenceId: entry.reuseReferenceId }); continue; }
    try {
      const result = await withUsageScope({ story: story.slug, stage: "visual-reference" }, () => generateStyleSheet(root, story.slug, entry.entityId, provider, story, { appearanceEraId: entry.kind === "era" ? entry.scopeId : undefined, creatureFormId: entry.kind === "form" ? entry.scopeId : undefined }));
      outcomes.push({ key: entry.key, status: "generated", referenceId: result.reference.id });
    } catch (error) { outcomes.push({ key: entry.key, status: "failed", error: error instanceof Error ? error.message : String(error) }); }
    onProgress({ stage: "visual-reference", index: index + 1, total: plan.entries.length, label: entry.label, outcomes: [...outcomes] });
  }
  return { status: outcomes.some(outcome => outcome.status === "failed") ? "completed_with_errors" : "completed", outcomes, remaining: [] };
}
