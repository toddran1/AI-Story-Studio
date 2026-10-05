import type { StoryBible } from "../domain/story-bible.js";
import type { VisualEntityProfile } from "../domain/visual-profile.js";
import { resolveVisualEntityType } from "./fields.js";
import type { Scene } from "../scenes/types.js";
import { resolveVisuallyRelevantCanonicalEntities } from "./resolver.js";

export function visualWorkflowCatalog(bible: StoryBible, profiles: Record<string, VisualEntityProfile>) {
  return bible.canonicalEntities.filter(entity => entity.visualProfilePolicy?.mode !== "skip").map(entity => {
    const profile = profiles[entity.id];
    const tasks: Array<{ key: string; kind: "profile" | "era" | "form" | "conflict" | "reference"; scopeId?: string; label: string; needsSheet: boolean; stale?: boolean }> = [];
    const assigned = new Set([...(profile?.appearanceEras ?? []).flatMap(era => era.referenceIds), ...(profile?.creatureForms ?? []).flatMap(form => form.referenceIds)]);
    const baseIds = profile?.references.filter(ref => !assigned.has(ref.id)).map(ref => ref.id) ?? [];
    const approvedReference = (ids?: string[]) => profile?.references.some(ref => ref.approved && (!ids || ids.includes(ref.id))) ?? false;
    if (!profile || profile.status !== "approved") tasks.push({ key: `${entity.id}:profile`, kind: "profile", label: "Review visual profile", needsSheet: !approvedReference(baseIds) });
    else if (!approvedReference(baseIds)) tasks.push({ key: `${entity.id}:reference`, kind: "reference", label: "Missing approved reference", needsSheet: true });
    for (const era of profile?.appearanceEras ?? []) if (era.status !== "approved" || era.detectedChange?.needsReview || !approvedReference(era.referenceIds)) tasks.push({ key: `${entity.id}:era:${era.id}`, kind: "era", scopeId: era.id, label: `${era.name} · chapters ${era.startChapter}–${era.endChapter ?? "onward"}`, needsSheet: !approvedReference(era.referenceIds), stale: era.detectedChange?.needsReview });
    for (const form of profile?.creatureForms ?? []) if (form.status !== "approved" || form.detectedSource?.needsReview || !approvedReference(form.referenceIds)) tasks.push({ key: `${entity.id}:form:${form.id}`, kind: "form", scopeId: form.id, label: `${form.name} · ${form.state}`, needsSheet: !approvedReference(form.referenceIds), stale: form.detectedSource?.needsReview });
    if (profile?.conflicts?.some(conflict => conflict.status === "needs_review")) tasks.push({ key: `${entity.id}:conflict`, kind: "conflict", label: "Resolve visual conflicts", needsSheet: false });
    return { id: entity.id, name: entity.canonicalName, type: resolveVisualEntityType(entity), profile, tasks, baseReferenceIds: profile?.references.filter(ref => ref.approved && !assigned.has(ref.id)).map(ref => ref.id) ?? [] };
  });
}

/** Conservative impact inventory. Affected does not mean artwork should be replaced. */
export function visualSceneImpact(scene: Scene, bible: StoryBible, entityId: string) {
  if (!resolveVisuallyRelevantCanonicalEntities(scene, bible).some(entity => entity.id === entityId)) return undefined;
  return { sceneId: scene.id, summary: scene.summary, disabled: !!scene.disabled, protected: scene.artwork.review === "approved" || !!scene.artwork.approvedVersionId || !!scene.artwork.manuallyEdited, hasArtwork: scene.artwork.status === "complete", review: scene.artwork.review };
}
