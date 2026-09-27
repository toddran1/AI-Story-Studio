import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { FfmpegTools } from "../audio/ffmpeg.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { importMusicTrack } from "./library.js";
import { musicGenerationRequestSchema, type MusicGenerationProvider } from "./providers/types.js";

const idSchema = z.string().uuid();
export const musicGenerationJobSchema = z.object({ id: idSchema, provider: z.string(), status: z.enum(["queued", "generating", "processing", "complete", "failed", "cancelled"]), request: musicGenerationRequestSchema, createdAt: z.string().datetime(), completedAt: z.string().datetime().optional(), error: z.string().optional(), candidate: z.object({ filename: z.literal("candidate.mp3"), fingerprint: z.string(), durationSeconds: z.number().positive(), providerGenerationId: z.string().optional(), model: z.string().optional() }).optional() });
export type MusicGenerationJob = z.infer<typeof musicGenerationJobSchema>;
function paths(root: string, id: string) { idSchema.parse(id); const dir = join(root, "music-generation", id); return { dir, manifest: join(dir, "manifest.json"), audio: join(dir, "candidate.mp3") }; }
export async function readMusicGeneration(root: string, id: string) { const raw = await readJsonIfExists(paths(root, id).manifest); return raw ? musicGenerationJobSchema.parse(raw) : undefined; }
export async function listMusicGenerations(root: string) { const { readdir } = await import("node:fs/promises"); const dir = join(root, "music-generation"); const entries = await readdir(dir).catch(() => []); const jobs = await Promise.all(entries.filter((id) => idSchema.safeParse(id).success).map((id) => readMusicGeneration(root, id).catch(() => undefined))); return jobs.filter((job): job is MusicGenerationJob => Boolean(job)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export function startMusicGeneration(root: string, raw: unknown, provider: MusicGenerationProvider, tools = new FfmpegTools()) {
  const request = musicGenerationRequestSchema.parse(raw); const id = randomUUID(); const location = paths(root, id);
  const initial: MusicGenerationJob = { id, provider: provider.id, status: "queued", request, createdAt: new Date().toISOString() };
  const ready = (async () => { await mkdir(location.dir, { recursive: true }); await atomicWriteJson(location.manifest, initial); })();
  const run = ready.then(async () => {
    let job: MusicGenerationJob = { ...initial, status: "generating" }; await atomicWriteJson(location.manifest, job);
    try {
      const result = await provider.generate(request); job = { ...job, status: "processing" }; await atomicWriteJson(location.manifest, job);
      if (!result.audio.length || result.audio.length > 100_000_000) throw new Error("Provider returned invalid audio size");
      await writeFile(location.audio, result.audio); const probe = await tools.probe(location.audio); const fingerprint = await fileFingerprint(location.audio);
      if (!(probe.durationSeconds > 0) || !fingerprint) throw new Error("Provider returned invalid audio");
      job = { ...job, status: "complete", completedAt: new Date().toISOString(), candidate: { filename: "candidate.mp3", fingerprint, durationSeconds: probe.durationSeconds, providerGenerationId: result.providerGenerationId, model: result.model } };
      await atomicWriteJson(location.manifest, job); return job;
    } catch (error) { await rm(location.audio, { force: true }); job = { ...job, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Music generation failed" }; await atomicWriteJson(location.manifest, job); return job; }
  });
  return { id, ready, run };
}
export async function saveMusicCandidate(root: string, id: string, title?: string, tools = new FfmpegTools()) {
  const job = await readMusicGeneration(root, id); if (!job || job.status !== "complete" || !job.candidate) throw new Error("Music candidate is not ready");
  const location = paths(root, id); if (await fileFingerprint(location.audio) !== job.candidate.fingerprint) throw new Error("Music candidate is missing or changed");
  const track = await importMusicTrack(root, location.audio, "generated.mp3", { title: title?.trim() || job.request.title || "Generated music", source: job.provider,
    tags: job.request.tags, generation: { provider: job.provider, providerGenerationId: job.candidate.providerGenerationId, model: job.candidate.model, prompt: job.request.prompt, requestedDurationSeconds: job.request.durationSeconds, generatedAt: job.completedAt! },
    licenseInfo: { source: job.provider, capturedAt: new Date().toISOString(), termsUrl: job.provider === "elevenlabs" ? "https://elevenlabs.io/music-terms" : undefined, notes: "Review the provider's current terms and your account plan before commercial use." } }, tools);
  await rm(location.dir, { recursive: true, force: true }); return track;
}
export async function discardMusicCandidate(root: string, id: string) { const job = await readMusicGeneration(root, id); if (job && ["queued", "generating", "processing"].includes(job.status)) throw new Error("Wait for music generation to finish before discarding the candidate"); await rm(paths(root, id).dir, { recursive: true, force: true }); }
export async function musicCandidatePath(root: string, id: string) { const job = await readMusicGeneration(root, id); if (job?.status !== "complete" || !job.candidate) return undefined; const path = paths(root, id).audio; return await fileFingerprint(path) === job.candidate.fingerprint ? path : undefined; }
