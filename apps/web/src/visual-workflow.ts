import { api, post, type VisualEntityProfile, type Scene } from "./api.js";
export type VisualTask = { key: string; kind: "profile" | "era" | "form" | "conflict" | "reference"; scopeId?: string; label: string; needsSheet: boolean; stale?: boolean };
export type VisualCatalogEntity = { id: string; name: string; type: string; profile?: VisualEntityProfile; tasks: VisualTask[]; baseReferenceIds: string[] };
export type VisualImpact = { chapter?: number; summaryId?: string; source: string; sceneId: string; summary: string; disabled: boolean; protected: boolean; hasArtwork: boolean; review: string };
export type ResolvedVisualPreview = { references: { mode: string; available: number; loadedReferenceIds: string[]; loadedReferences: Array<{ entityId?: string; referenceId?: string }> }; prompt: string; negativePrompt: string; resolvedEntities: Array<{ entityId: string; name: string; description: string; appearanceEra?: { name: string }; references?: VisualEntityProfile["references"]; groundingMode: string }> };
const catalogRequests = new Map<string, Promise<VisualCatalogEntity[]>>();
export function getVisualCatalog(slug: string) {
  const pending = catalogRequests.get(slug); if (pending) return pending;
  const request = api<VisualCatalogEntity[]>(`/stories/${encodeURIComponent(slug)}/visual-workflow`).then(rows => { if (!Array.isArray(rows)) throw new Error("Invalid visual catalog response"); return rows; }).finally(() => catalogRequests.delete(slug));
  catalogRequests.set(slug, request); return request;
}
export const getVisualImpact = (slug: string, entityId: string) => api<VisualImpact[]>(`/stories/${encodeURIComponent(slug)}/visual-profiles/${encodeURIComponent(entityId)}/impact`);
export const previewVisuals = (slug: string, scene: Scene, chapter?: number, summaryId?: string) => post<ResolvedVisualPreview>(`/stories/${encodeURIComponent(slug)}/visual-workflow/preview`, { scene, chapter, summaryId });
export const referenceUrl = (slug: string, entityId: string, refId: string) => `/api/stories/${encodeURIComponent(slug)}/visual-profiles/${encodeURIComponent(entityId)}/references/${encodeURIComponent(refId)}`;

export type ReferenceSelection = { entityId: string; kind: "profile" | "era" | "form"; scopeId?: string };
export type ReferenceBatchPlan = { entries: Array<ReferenceSelection & { key: string; label: string; blockedReason?: string; reuseReferenceId?: string; identityMode?: string; identityReason?: string }>; fingerprint: string; imageCount: number; estimatedCostUsd?: number; costNote: string; provider: string; model: string; force: boolean };
export type SceneSelection = { chapter?: number; summaryId?: string; sceneId: string };
export type RegenerationPlan = { entries: Array<SceneSelection & { key: string; label: string; protected: boolean; blockedReason?: string }>; fingerprint: string; imageCount: number; estimatedCostUsd?: number; costNote: string; provider: string; model: string };
export const sceneSelectionKey = (item: SceneSelection) => `${item.chapter ? `chapter:${item.chapter}` : `summary:${item.summaryId}`}:${item.sceneId}`;
export const planReferenceSheets = (slug: string, selection: ReferenceSelection[], force = false) => post<ReferenceBatchPlan>(`/stories/${encodeURIComponent(slug)}/visual-workflow/references/plan`, { selection, force });
export const startReferenceSheets = (slug: string, selection: ReferenceSelection[], plan: ReferenceBatchPlan) => post<import("./api.js").Job>(`/stories/${encodeURIComponent(slug)}/visual-workflow/references/start`, { selection, force: plan.force, planFingerprint: plan.fingerprint });
export const planVisualRegeneration = (slug: string, entityId: string, selection: SceneSelection[], includeProtected: boolean) => post<RegenerationPlan>(`/stories/${encodeURIComponent(slug)}/visual-workflow/regeneration/plan`, { entityId, selection, includeProtected });
export const startVisualRegeneration = (slug: string, entityId: string, selection: SceneSelection[], includeProtected: boolean, plan: RegenerationPlan) => post<import("./api.js").Job>(`/stories/${encodeURIComponent(slug)}/visual-workflow/regeneration/start`, { entityId, selection, includeProtected, planFingerprint: plan.fingerprint });
export type VisualCheckFinding = { status: "match" | "mismatch" | "uncertain" | "not_applicable"; observation: string };
export type VisualCheck = { summary: string; identity: VisualCheckFinding; creatureForm: VisualCheckFinding; count: VisualCheckFinding; signatureFeatures: VisualCheckFinding; composition: VisualCheckFinding; checkedAt: string; imageFingerprint: string; targetFingerprint: string; promptVersion: string; provider: string; model: string };
export type VisualCheckTarget = SceneSelection & { versionId?: string };
export const inspectVisualCheck = (slug: string, target: VisualCheckTarget) => post<{ check: VisualCheck | null; stale: boolean; provider: string; model: string }>(`/stories/${encodeURIComponent(slug)}/visual-workflow/check/inspect`, target);
export const startVisualCheck = (slug: string, target: VisualCheckTarget, force = false) => post<import("./api.js").Job>(`/stories/${encodeURIComponent(slug)}/visual-workflow/check/start`, { target, force });
