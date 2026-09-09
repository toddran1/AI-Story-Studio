import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Story } from "../domain/story.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { fingerprint } from "../utils/hash.js";
import { ProductionManifest, ProductionPlan, productionManifestSchema } from "./types.js";

export function productionPaths(root: string, slug: string, id?: string) { const directory = join(root, "stories", slug, "production-runs"); return { directory, latest: join(directory, "latest.json"), manifest: id ? join(directory, `${id}.json`) : undefined }; }
export function createProductionManifest(story: Story, plan: ProductionPlan, options: ProductionManifest["options"]): ProductionManifest {
  const now = new Date().toISOString(); const id = `${now.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`;
  const operations = Object.fromEntries(plan.stages.filter((stage) => !["audiobook", "videoExport", "refresh"].includes(stage)).map((stage) => [stage, { status: "pending", reused: false, attempts: 0 }]));
  return productionManifestSchema.parse({ version: 1, id, story: story.slug, storyFingerprint: fingerprint(story), createdAt: now, updatedAt: now, selection: { from: plan.from, to: plan.to }, options, status: options.dryRun ? "planned" : "running", current: {},
    chapters: Object.fromEntries(plan.chapters.map((chapter) => [String(chapter), { chapter, status: "pending", operations: structuredClone(operations) }])), retry: { maxProviderAttempts: 3, maxQaRepairs: options.repairQa ? 2 : 0 }, failures: [], summary: emptySummary(plan.chapters.length) });
}
export async function persistProductionManifest(root: string, manifest: ProductionManifest) { manifest.updatedAt = new Date().toISOString(); const paths = productionPaths(root, manifest.story, manifest.id); await mkdir(paths.directory, { recursive: true }); await atomicWriteJson(paths.manifest!, productionManifestSchema.parse(manifest)); await atomicWriteJson(paths.latest, productionManifestSchema.parse(manifest)); }
export async function loadLatestProduction(root: string, slug: string) { const raw = await readJsonIfExists(productionPaths(root, slug).latest); return raw ? productionManifestSchema.parse(raw) : undefined; }
export function emptySummary(chapters: number[]): ProductionManifest["summary"];
export function emptySummary(chapters: number): ProductionManifest["summary"];
export function emptySummary(chapters: number[] | number): ProductionManifest["summary"] { return { chapters: typeof chapters === "number" ? chapters : chapters.length, completed: 0, needsReview: 0, failed: 0, reusedStages: 0, newStages: 0, qaWarnings: 0, qaFailures: 0, exports: {}, elapsedMs: 0 }; }
