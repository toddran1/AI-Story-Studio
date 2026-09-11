import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { z } from "zod";
import { FfmpegTools, runCommand } from "../audio/ffmpeg.js";
import { Environment } from "../config/env.js";
import { defaultStory, loadStory } from "../config/load-config.js";
import { Chapter, chapterSchema } from "../domain/chapter.js";
import { Story, storySchema } from "../domain/story.js";
import { atomicWrite, atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { exists, readJsonIfExists } from "../storage/story-files.js";
import { withStoryLock } from "../storage/story-lock.js";
import { alignmentConfig, createAlignmentEngine } from "../alignment/config.js";
import { ttsProviderNameSchema } from "../domain/provider.js";

const MAX_BACKUP_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_BACKUP_ENTRY_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_BACKUP_EXPANDED_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_PROJECT_FILES = 250_000;
const activityQueues = new Map<string, Promise<void>>();

export const safeSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);
export const storyMetadataSchema = z.object({ title: z.string().trim().min(1).max(200), author: z.string().trim().max(200).optional(), description: z.string().max(10_000).default(""), tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]), notes: z.string().max(20_000).default(""), sourceLanguage: z.string().trim().min(2).max(30), outputLanguage: z.string().trim().min(2).max(30) });
export type Activity = { id: string; type: string; message: string; at: string };
const activitySchema = z.array(z.object({ id: z.string(), type: z.string(), message: z.string(), at: z.string() })).default([]);
export const cleanupKindSchema = z.enum(["voicePreviews", "abPreviews", "oldProductionManifests", "artwork", "chapterVideo", "exports"]);

export const globalSettingsSchema = z.object({ defaultSourceLanguage: z.string().min(2), defaultOutputLanguage: z.string().min(2), defaultProductionProfile: z.enum(["audio", "audiobook", "story-video", "everything"]), translation: modelSchema(), narration: modelSchema(), qa: modelSchema(), storyBible: modelSchema(), scenePlanner: modelSchema(), tts: z.object({ provider: ttsProviderNameSchema, model: z.string().min(1), referenceId: z.string().optional() }) });
export type GlobalSettings = z.infer<typeof globalSettingsSchema>;

export async function loadGlobalSettings(root: string, env: Environment): Promise<GlobalSettings> { const raw = await readJsonIfExists<Record<string, unknown>>(globalSettingsPath(root)); const defaults = { defaultSourceLanguage: "zh-CN", defaultOutputLanguage: "en-US", defaultProductionProfile: "audiobook" as const, translation: { provider: "gemini" as const, model: env.GEMINI_DEFAULT_MODEL }, narration: { provider: "openai" as const, model: env.OPENAI_DEFAULT_MODEL }, qa: { provider: "openai" as const, model: env.OPENAI_DEFAULT_MODEL }, storyBible: { provider: "gemini" as const, model: env.GEMINI_DEFAULT_MODEL }, scenePlanner: { provider: "openai" as const, model: env.OPENAI_DEFAULT_MODEL }, tts: { provider: "fish" as const, model: env.FISH_AUDIO_MODEL, referenceId: env.FISH_AUDIO_REFERENCE_ID } }; return globalSettingsSchema.parse(raw ? { ...defaults, ...raw } : defaults); }
export async function saveGlobalSettings(root: string, value: unknown) { const settings = globalSettingsSchema.parse(value); await atomicWriteJson(globalSettingsPath(root), settings); return settings; }

export async function createBlankStory(root: string, env: Environment, raw: unknown) {
  const input = storyMetadataSchema.extend({ slug: safeSlugSchema, sourceLanguage: z.string().trim().min(2).max(30).optional(), outputLanguage: z.string().trim().min(2).max(30).optional() }).parse(raw); const paths = storyPaths(root, input.slug, 1); if (await exists(paths.story)) throw new Error(`Story '${input.slug}' already exists`);
  const defaults = await loadGlobalSettings(root, env); let story = defaultStory(input.slug, env); story = storySchema.parse({ ...story, ...input, source: { type: "original" }, sourceLanguage: input.sourceLanguage ?? defaults.defaultSourceLanguage, outputLanguage: input.outputLanguage ?? defaults.defaultOutputLanguage, defaultProductionProfile: defaults.defaultProductionProfile, pipeline: { ...story.pipeline, translation: defaults.translation, narration: defaults.narration, qa: defaults.qa, storyBible: defaults.storyBible, scenePlanner: defaults.scenePlanner, tts: { ...story.pipeline.tts, provider: defaults.tts.provider, model: defaults.tts.model, referenceId: defaults.tts.referenceId } } });
  const stage = join(root, "stories", `.create-${randomUUID()}`); await mkdir(stage, { recursive: true }); try { await atomicWriteJson(join(stage, "story.json"), story); await atomicWriteJson(join(stage, "pipeline.json"), story.pipeline); await rename(stage, paths.story); } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  await recordActivity(root, input.slug, "story.created", "Created story project"); return story;
}

export async function updateStoryMetadata(root: string, slug: string, raw: unknown) { safeSlugSchema.parse(slug); const input = storyMetadataSchema.parse(raw); return withStoryLock(root, slug, "story metadata update", async () => { const paths = storyPaths(root, slug, 1); const current = await loadStory(paths.storyConfig); const story = storySchema.parse({ ...current, ...input }); await invalidateStoryForConfigChange(root, slug, current, story); await atomicWriteJson(paths.storyConfig, story); await recordActivity(root, slug, "story.metadata", "Updated story information"); return story; }); }

export async function saveCover(root: string, slug: string, filename: string, bytes: Uint8Array) { safeSlugSchema.parse(slug); const extension = extname(basename(filename)).toLowerCase(); if (![".jpg", ".jpeg", ".png"].includes(extension)) throw new Error("Cover must be a JPG or PNG image"); if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw new Error("Cover must be between 1 byte and 15 MB"); validateImageSignature(extension, bytes); return withStoryLock(root, slug, "cover update", async () => { const paths = storyPaths(root, slug, 1); if (!(await exists(paths.storyConfig))) throw new Error(`Story '${slug}' was not found`); const target = join(paths.story, `cover${extension}`); await atomicWrite(target, bytes); for (const name of ["cover.jpg", "cover.jpeg", "cover.png"]) if (join(paths.story, name) !== target) await rm(join(paths.story, name), { force: true }); await invalidateChapterVideo(root, slug); await invalidateExportManifests(root, slug); await recordActivity(root, slug, "story.cover", "Updated story cover; chapter video and combined exports marked stale"); return { coverUrl: `/api/stories/${slug}/cover` }; }); }

export async function duplicateStory(root: string, sourceSlug: string, requestedSlug: string, mode: "settings" | "full") { safeSlugSchema.parse(sourceSlug); safeSlugSchema.parse(requestedSlug); const source = storyPaths(root, sourceSlug, 1).story; if (!(await exists(join(source, "story.json")))) throw new Error(`Story '${sourceSlug}' was not found`); const slug = await uniqueSlug(root, requestedSlug); const stage = join(root, "stories", `.duplicate-${randomUUID()}`); const target = storyPaths(root, slug, 1).story;
  try { await mkdir(stage, { recursive: true }); if (mode === "full") { await rm(stage, { recursive: true, force: true }); const transient = new Set(["activity.json", "batches", "exports", "production-runs", "previews", "voice-previews"]); await cp(source, stage, { recursive: true, filter: (path) => { const rel = relative(source, path); const top = rel.split(sep)[0]; return rel === "" || (!transient.has(top!) && basename(path) !== ".lock" && !basename(path).endsWith(".tmp")); } }); } else { for (const name of ["story.json", "pipeline.json", "cover.jpg", "cover.jpeg", "cover.png"]) if (await exists(join(source, name))) await cp(join(source, name), join(stage, name)); }
    const story = await loadStory(join(stage, "story.json")); const copy = storySchema.parse({ ...story, id: slug, slug, title: `${story.title} Copy` }); await atomicWriteJson(join(stage, "story.json"), copy); await atomicWriteJson(join(stage, "pipeline.json"), copy.pipeline); await rename(stage, target); await recordActivity(root, slug, "story.duplicated", `Duplicated from ${sourceSlug} (${mode === "full" ? "full project" : "settings only"})`); return { story: copy, slug };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

export async function deleteStory(root: string, slug: string, confirmation: string) { safeSlugSchema.parse(slug); const paths = storyPaths(root, slug, 1); const story = await loadStory(paths.storyConfig); if (confirmation !== story.title) throw new Error("Confirmation must exactly match the story title"); const trash = join(root, "stories", ".trash"); await mkdir(trash, { recursive: true }); const destination = join(trash, `${slug}-${Date.now()}`); await withStoryLock(root, slug, "story deletion", async () => { await rename(paths.story, destination); await rm(join(destination, ".lock"), { recursive: true, force: true }); }); return { deleted: slug, recoverable: true }; }

export async function buildStoryBackup(root: string, slug: string, includeMedia: boolean) { safeSlugSchema.parse(slug); return withStoryLock(root, slug, "project backup", async () => { const storyRoot = storyPaths(root, slug, 1).story; const files = await walk(storyRoot); let expandedBytes = 0; const selected: Array<{ path: string; name: string }> = []; for (const path of files) { const name = relative(storyRoot, path).split(sep).join("/"); if (shouldExcludeBackup(name, includeMedia)) continue; const info = await stat(path); if (info.size > MAX_BACKUP_ENTRY_BYTES) throw new Error(`Backup file exceeds the 4 GB per-file limit: ${name}`); expandedBytes += info.size; if (expandedBytes > MAX_BACKUP_EXPANDED_BYTES) throw new Error("Backup exceeds the 20 GB expanded-size limit"); selected.push({ path, name }); } const id = randomUUID(); const directory = join(root, ".ai-story-studio", "backups"); const output = join(directory, `${id}.zip`); await mkdir(directory, { recursive: true }); try { await writeBackupArchive(output, selected, { format: "ai-story-studio", version: 1, slug, includeMedia, createdAt: new Date().toISOString() }); } catch (error) { await rm(output, { force: true }); throw error; } const info = await stat(output); await recordActivity(root, slug, "backup.created", `Created ${includeMedia ? "full" : "project-only"} backup`); return { id, filename: `${slug}-${includeMedia ? "full" : "project"}.zip`, bytes: info.size, downloadUrl: `/api/backups/${id}.zip` }; }); }

export async function restoreStoryBackup(root: string, bytes: Uint8Array) {
  if (bytes.byteLength > MAX_BACKUP_ARCHIVE_BYTES) throw new Error("Backup exceeds the 4 GB archive-size limit");
  const directory = join(root, ".ai-story-studio", "restore-uploads"); const path = join(directory, `${randomUUID()}.zip`);
  await atomicWrite(path, bytes);
  try { return await restoreStoryBackupFile(root, path); }
  finally { await rm(path, { force: true }); }
}

export async function restoreStoryBackupFile(root: string, archivePath: string) {
  const infoHolder = await stat(archivePath); if (!infoHolder.isFile()) throw new Error("Backup upload is not a file");
  if (infoHolder.size > MAX_BACKUP_ARCHIVE_BYTES) throw new Error("Backup exceeds the 4 GB archive-size limit");
  const stage = join(root, "stories", `.restore-${randomUUID()}`);
  try {
    await mkdir(stage, { recursive: true }); await extractBackupArchive(archivePath, stage);
    const descriptorRaw = await readJsonIfExists(join(stage, "backup.json")); const storyRaw = await readJsonIfExists(join(stage, "story.json"));
    if (!descriptorRaw || !storyRaw) throw new Error("Backup must contain backup.json and story.json");
    const descriptor = z.object({ format: z.literal("ai-story-studio"), version: z.literal(1), slug: safeSlugSchema }).passthrough().parse(descriptorRaw);
    const original = storySchema.parse(storyRaw); const slug = await uniqueSlug(root, descriptor.slug);
    if (slug !== original.slug) await removeTransientProjectData(stage);
    const restored = storySchema.parse({ ...original, id: slug, slug, ...(slug === original.slug ? {} : { title: `${original.title} Restored` }) });
    await rm(join(stage, "backup.json"), { force: true }); await atomicWriteJson(join(stage, "story.json"), restored); await atomicWriteJson(join(stage, "pipeline.json"), restored.pipeline);
    await rename(stage, storyPaths(root, slug, 1).story); await recordActivity(root, slug, "backup.restored", `Restored backup from ${descriptor.slug}`); return { slug, story: restored };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

export async function getStorageUsage(root: string, slug: string) { safeSlugSchema.parse(slug); const story = storyPaths(root, slug, 1).story; const totals: Record<string, number> = { source: 0, text: 0, ttsRaw: 0, masteredAudio: 0, artwork: 0, video: 0, previews: 0, exports: 0, other: 0, total: 0 }; for (const path of await walk(story)) { const bytes = (await stat(path)).size; const rel = relative(story, path).split(sep).join("/"); const category = storageCategory(rel); totals[category] += bytes; totals.total += bytes; } return totals; }

export async function cleanupStory(root: string, slug: string, kind: z.infer<typeof cleanupKindSchema>) { safeSlugSchema.parse(slug); cleanupKindSchema.parse(kind); return withStoryLock(root, slug, `cleanup ${kind}`, async () => { const paths = storyPaths(root, slug, 1); let removed = 0; const removeTarget = async (path: string) => { if (await exists(path)) { removed += await pathSize(path); await rm(path, { recursive: true, force: true }); } };
    if (kind === "voicePreviews") await removeTarget(join(paths.story, "voice-previews")); else if (kind === "abPreviews") await removeTarget(join(paths.story, "previews")); else if (kind === "exports") await removeTarget(join(paths.story, "exports")); else if (kind === "oldProductionManifests") { const directory = join(paths.story, "production-runs"); if (await exists(directory)) for (const name of await readdir(directory)) if (name !== "latest.json") await removeTarget(join(directory, name)); }
    else { for (const entry of await readdir(join(paths.story, "chapters"), { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) { const number = Number(entry.name); if (!Number.isSafeInteger(number)) continue; const chapterPaths = storyPaths(root, slug, number); if (kind === "chapterVideo") { await removeTarget(chapterPaths.video); await markPending(chapterPaths.chapterMeta, ["video"]); } else { await removeTarget(chapterPaths.scenesDirectory); await markPending(chapterPaths.chapterMeta, ["artwork", "video"]); } } }
    await recordActivity(root, slug, "storage.cleanup", `Cleaned ${kind} (${removed} bytes)`); return { kind, removedBytes: removed }; }); }

export async function readActivity(root: string, slug: string, limit = 30) { safeSlugSchema.parse(slug); const items = activitySchema.parse((await readJsonIfExists(activityPath(root, slug))) ?? []); return items.slice(-Math.min(100, Math.max(1, limit))).reverse(); }
export async function recordActivity(root: string, slug: string, type: string, message: string) {
  const path = activityPath(root, slug); const previous = activityQueues.get(path) ?? Promise.resolve();
  const update = previous.catch(() => undefined).then(async () => { const items = activitySchema.parse((await readJsonIfExists(path)) ?? []); items.push({ id: randomUUID(), type, message, at: new Date().toISOString() }); await atomicWriteJson(path, items.slice(-500)); });
  activityQueues.set(path, update); try { await update; } finally { if (activityQueues.get(path) === update) activityQueues.delete(path); }
}
export async function systemStatus(env: Environment, root = process.cwd()) { const tools = new FfmpegTools(); let ffmpeg = false; let ffprobe = false; let alignment = false; let alignmentMessage: string | undefined; try { await runCommand(tools.ffmpegPath, ["-version"], 5_000); ffmpeg = true; } catch {} try { await runCommand(tools.ffprobePath, ["-version"], 5_000); ffprobe = true; } catch {} const config = alignmentConfig(env, root); const engine = createAlignmentEngine(config); if (engine) try { await engine.validateConfiguration(); alignment = true; } catch (error) { alignmentMessage = error instanceof Error ? error.message : String(error); } else alignmentMessage = "Alignment is disabled"; return { providers: { openai: Boolean(env.OPENAI_API_KEY), gemini: Boolean(env.GEMINI_API_KEY), fish: Boolean(env.FISH_AUDIO_API_KEY) }, dependencies: { ffmpeg, ffprobe, alignment, alignmentEngine: config.engine, alignmentMessage } }; }

export async function invalidateStoryForConfigChange(root: string, slug: string, before: Story, after: Story) {
  const stages = new Set<string>(); const changed = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right); const add = (...items: string[]) => items.forEach((item) => stages.add(item));
  if (before.sourceLanguage !== after.sourceLanguage || before.outputLanguage !== after.outputLanguage) add("translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video");
  if (changed(before.pipeline.translation, after.pipeline.translation) || changed(before.context, after.context)) add("translation", "narration", "qa", "storyBible", "continuity", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video");
  if (changed(before.pipeline.narration, after.pipeline.narration)) add("narration", "qa", "storyBible", "continuity", "tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video");
  if (changed(before.pipeline.qa, after.pipeline.qa)) add("qa");
  if (changed(before.pipeline.storyBible, after.pipeline.storyBible)) add("storyBible", "continuity");
  if (changed(before.pipeline.tts, after.pipeline.tts)) add("tts", "audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video");
  if (changed(before.audio, after.audio)) add("audioMastering", "alignment", "subtitles", "scenePlanning", "artwork", "video");
  if (changed(before.subtitles, after.subtitles)) add("subtitles", "video");
  if (changed(before.video, after.video)) add("video");
  if (changed(before.pipeline.scenePlanner, after.pipeline.scenePlanner) || changed(before.scenes, after.scenes)) add("scenePlanning", "artwork", "video");
  if (changed(before.artwork, after.artwork)) add("artwork", "video");
  const exportMetadataChanged = before.title !== after.title || before.author !== after.author;
  if (stages.size) { const chapters = join(storyPaths(root, slug, 1).story, "chapters"); for (const entry of await readdir(chapters, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory() && /^\d+$/.test(entry.name)) await markPending(storyPaths(root, slug, Number(entry.name)).chapterMeta, [...stages]); }
  if (stages.size || exportMetadataChanged) await invalidateExportManifests(root, slug);
}

export function slugify(value: string) { return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "untitled-story"; }
export function backupPath(root: string, id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid backup ID"); return join(root, ".ai-story-studio", "backups", `${id}.zip`); }

function modelSchema() { return z.object({ provider: z.enum(["openai", "gemini"]), model: z.string().min(1) }); }
function globalSettingsPath(root: string) { return join(root, ".ai-story-studio", "settings.json"); }
function activityPath(root: string, slug: string) { return join(storyPaths(root, slug, 1).story, "activity.json"); }
async function uniqueSlug(root: string, requested: string) { const base = safeSlugSchema.parse(slugify(requested)); if (!(await exists(storyPaths(root, base, 1).story))) return base; for (let i = 2; i < 10_000; i++) { const value = `${base}-${i}`; if (!(await exists(storyPaths(root, value, 1).story))) return value; } throw new Error("Unable to allocate a unique story slug"); }
async function walk(directory: string, state = { count: 0 }): Promise<string[]> { const out: string[] = []; for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; })) { if (entry.name === ".lock" || entry.name.includes(".tmp")) continue; const path = join(directory, entry.name); if (entry.isDirectory()) out.push(...await walk(path, state)); else if (entry.isFile()) { state.count++; if (state.count > MAX_PROJECT_FILES) throw new Error(`Project contains more than ${MAX_PROJECT_FILES.toLocaleString("en-US")} files`); out.push(path); } } return out; }
function shouldExcludeBackup(path: string, includeMedia: boolean) { if (path === "activity.json" || path.startsWith("backups/") || path.startsWith(".lock")) return true; if (includeMedia || /^cover\.(jpg|jpeg|png)$/.test(path)) return false; return /(^|\/)(audio-segments|scenes|voice-previews|previews|exports)(\/|$)/.test(path) || /\.(mp3|m4b|mp4|png|jpe?g)$/i.test(path); }
function validateArchiveNames(names: string[]) { if (names.length > MAX_PROJECT_FILES) throw new Error("Backup contains too many files"); for (const name of names) { const normalized = name.replaceAll("\\", "/"); const parts = normalized.split("/"); if (!name || name.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || parts.includes("..") || parts.includes(".lock") || parts.some((part) => part.includes(".tmp")) || resolve("/safe", normalized) === "/safe") throw new Error(`Unsafe backup path: ${name}`); } }
function validateImageSignature(extension: string, bytes: Uint8Array) {
  const valid = extension === ".png" ? validPng(bytes) : validJpeg(bytes);
  if (!valid) throw new Error("Cover is not a complete, structurally valid image matching its file extension");
}

function validPng(bytes: Uint8Array) {
  if (bytes.length < 45 || ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 8; let first = true; let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset); const end = offset + 12 + length; if (end > bytes.length) return false; const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (first && (type !== "IHDR" || length !== 13 || view.getUint32(offset + 8) === 0 || view.getUint32(offset + 12) === 0)) return false;
    if (type === "IDAT") hasImageData = true; if (type === "IEND") return length === 0 && hasImageData && end === bytes.length; first = false; offset = end;
  }
  return false;
}

function validJpeg(bytes: Uint8Array) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return false;
  let offset = 2; let dimensions = false;
  while (offset + 3 < bytes.length - 2) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++]!; if (marker === 0xd9 || marker === 0xda) break; if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 1 >= bytes.length) return false; const length = (bytes[offset]! << 8) | bytes[offset + 1]!; if (length < 2 || offset + length > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) { if (length < 7) return false; dimensions = ((bytes[offset + 3]! << 8) | bytes[offset + 4]!) > 0 && ((bytes[offset + 5]! << 8) | bytes[offset + 6]!) > 0; }
    offset += length;
  }
  return dimensions;
}

async function invalidateChapterVideo(root: string, slug: string) { const chapters = join(storyPaths(root, slug, 1).story, "chapters"); for (const entry of await readdir(chapters, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory() && /^\d+$/.test(entry.name)) await markPending(storyPaths(root, slug, Number(entry.name)).chapterMeta, ["video"]); }
async function invalidateExportManifests(root: string, slug: string) { const directory = join(storyPaths(root, slug, 1).story, "exports"); let names: string[]; try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } for (const name of names) if (name.endsWith(".json")) await rm(join(directory, name), { force: true }); }
async function markPending(path: string, stages: string[]) { const raw = await readJsonIfExists<Chapter>(path); if (!raw) return; const chapter = chapterSchema.parse(raw); for (const stage of stages) if (stage in chapter.stages) chapter.stages[stage as keyof typeof chapter.stages] = { status: "pending" }; chapter.updatedAt = new Date().toISOString(); await atomicWriteJson(path, chapter); }
function storageCategory(path: string) { if (path.startsWith("source/")) return "source"; if (path.startsWith("previews/") || path.startsWith("voice-previews/")) return "previews"; if (path.startsWith("exports/")) return "exports"; if (path.includes("/audio-segments/") || path.endsWith("/audio-raw.mp3")) return "ttsRaw"; if (path.endsWith("/audio.mp3")) return "masteredAudio"; if (/\/scenes\/.*\.png$/.test(path)) return "artwork"; if (path.endsWith(".mp4")) return "video"; if (/\.(txt|json|srt|vtt)$/.test(path)) return "text"; return "other"; }
async function pathSize(path: string): Promise<number> { const info = await stat(path); if (info.isFile()) return info.size; let total = 0; for (const entry of await readdir(path)) total += await pathSize(join(path, entry)); return total; }

async function removeTransientProjectData(directory: string) {
  for (const name of ["activity.json", "batches", "exports", "production-runs", "previews", "voice-previews"]) await rm(join(directory, name), { recursive: true, force: true });
}

async function writeBackupArchive(output: string, files: Array<{ path: string; name: string }>, descriptor: Record<string, unknown>) {
  const stream = createWriteStream(output, { flags: "wx" }); let archiveBytes = 0; let drain: Promise<unknown> | undefined; let failure: Error | undefined; let zipper!: Zip;
  const streamFinished = new Promise<void>((resolvePromise, rejectPromise) => { stream.once("finish", resolvePromise); stream.once("error", rejectPromise); });
  const archiveFinished = new Promise<void>((resolvePromise, rejectPromise) => {
    zipper = new Zip((error, data, final) => {
      if (error) { failure = error; rejectPromise(error); stream.destroy(error); return; }
      archiveBytes += data.length;
      if (archiveBytes > MAX_BACKUP_ARCHIVE_BYTES) { failure = new Error("Backup exceeds the 4 GB archive-size limit"); rejectPromise(failure); zipper.terminate(); stream.destroy(failure); return; }
      if (data.length && !stream.write(Buffer.from(data))) drain = once(stream, "drain");
      if (final) { stream.end(); resolvePromise(); }
    });
  });
  const add = async (name: string, source: AsyncIterable<Uint8Array> | Uint8Array) => {
    const entry = /\.(?:m4b|mp3|mp4|jpe?g|png|zip)$/i.test(name) ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 }); zipper.add(entry);
    if (Symbol.asyncIterator in Object(source)) for await (const chunk of source as AsyncIterable<Uint8Array>) { if (failure) throw failure; entry.push(chunk); if (drain) { await drain; drain = undefined; } }
    else entry.push(source as Uint8Array);
    entry.push(new Uint8Array(), true); if (drain) { await drain; drain = undefined; }
  };
  try {
    await add("backup.json", Buffer.from(JSON.stringify(descriptor)));
    for (const file of files) await add(file.name, createReadStream(file.path, { highWaterMark: 512 * 1024 }));
    zipper.end(); await archiveFinished; await streamFinished;
  } catch (error) { zipper.terminate(); stream.destroy(); await rm(output, { force: true }); throw error; }
}

async function extractBackupArchive(archivePath: string, destination: string) {
  let count = 0; let expanded = 0; let failure: Error | undefined; const pending: Promise<void>[] = []; const drains = new Set<Promise<unknown>>();
  const fail = (error: unknown) => { failure ??= error instanceof Error ? error : new Error(String(error)); };
  const unzipper = new Unzip((file) => {
    try {
      validateArchiveNames([file.name]); count++; if (count > MAX_PROJECT_FILES) throw new Error("Backup contains too many files");
      if ((file.originalSize ?? 0) > MAX_BACKUP_ENTRY_BYTES) throw new Error(`Backup entry exceeds the 4 GB limit: ${file.name}`);
      if (file.name.endsWith("/")) { file.ondata = (error) => { if (error) fail(error); }; file.start(); return; }
      const target = join(destination, file.name); const task = mkdir(dirname(target), { recursive: true }).then(() => new Promise<void>((resolvePromise, rejectPromise) => {
        const output = createWriteStream(target, { flags: "wx" }); let entryBytes = 0;
        const reject = (error: unknown) => { fail(error); file.terminate(); output.destroy(); rejectPromise(failure); };
        output.once("error", reject); output.once("finish", resolvePromise);
        file.ondata = (error, data, final) => {
          if (error) { reject(error); return; } entryBytes += data.length; expanded += data.length;
          if (entryBytes > MAX_BACKUP_ENTRY_BYTES || expanded > MAX_BACKUP_EXPANDED_BYTES) { reject(new Error("Backup exceeds safe expanded-size limits")); return; }
          if (data.length && !output.write(Buffer.from(data))) { const wait = once(output, "drain"); drains.add(wait); void wait.finally(() => drains.delete(wait)); }
          if (final) output.end();
        };
        try { file.start(); } catch (error) { reject(error); }
      })); pending.push(task); void task.catch(fail);
    } catch (error) { fail(error); file.terminate(); }
  });
  unzipper.register(UnzipInflate); unzipper.register(UnzipPassThrough);
  try {
    for await (const chunk of createReadStream(archivePath, { highWaterMark: 64 * 1024 })) { if (failure) throw failure; unzipper.push(chunk); if (drains.size) await Promise.all([...drains]); }
    unzipper.push(new Uint8Array(), true); await Promise.all(pending); if (failure) throw failure;
  } catch (error) { throw new Error(`Unsafe or invalid backup archive: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}
