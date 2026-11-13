import { randomUUID } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { formatChapterSelection, selectChapterNumbers } from "../batch/range.js";
import { storySchema } from "../domain/story.js";
import { importedChapterFingerprint } from "../source/importer.js";
import { sourceManifestSchema } from "../source/types.js";
import { atomicWriteJson } from "../storage/atomic-write.js";
import { storyPaths } from "../storage/paths.js";
import { withStoryLock } from "../storage/story-lock.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { bumpChapterStatusReadRevision } from "../studio/chapter-status-revision.js";
import { fileFingerprint } from "../utils/file-fingerprint.js";
import { fingerprint } from "../utils/hash.js";
import { buildSourceNameIndex, loadSourceNameIndex, sourceNameExtractionSchema, sourceNamePassages, sourceNameRevision, sourceNameScanInstructions } from "../naming/source-index.js";
import { publishSourceNameScanWithHolds } from "../naming/source-name-holds.js";
import { recoverTransactions, safeRelative } from "./snapshot.js";

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const runId = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const chapterNumber = z.number().int().positive();
const planInput = z.object({
  story: slugSchema,
  chapters: z.union([z.literal("all"), z.array(chapterNumber).min(1).max(2_000)]),
  agent: z.enum(["codex", "antigravity"]),
  model: z.string().trim().min(1).max(200),
}).strict();
const runSchema = z.object({
  kind: z.literal("sourceNameIndex"), id: runId, input: planInput,
  status: z.enum(["awaiting-confirmation", "running", "needs-input", "complete"]),
  planFingerprint: hash, sourceRevision: hash, promptFingerprint: hash,
  priorIndexFingerprint: z.string().optional(),
  chapters: z.array(chapterNumber), passages: z.array(z.object({ chapter: chapterNumber, offset: z.number().int().nonnegative(), id: hash })),
  cursor: z.number().int().nonnegative(), approvedAt: z.string().optional(), diagnostic: z.string().optional(),
  result: z.object({ entries: z.number().int().nonnegative(), heldRules: z.number().int().nonnegative().optional(), affectedChapters: z.array(chapterNumber).optional() }).optional(),
});
type Run = z.infer<typeof runSchema>;

function directory(root: string, story: string, id: string) {
  return join(storyPaths(root, slugSchema.parse(story), 1).story, "agent-runs", runId.parse(id));
}
function runFile(root: string, story: string, id: string) {
  return join(directory(root, story, id), "source-name-run.json");
}
const save = (root: string, run: Run) => atomicWriteJson(runFile(root, run.input.story, run.id), runSchema.parse(run));
const responseFile = (root: string, run: Run, id: string) => join(directory(root, run.input.story, run.id), "responses", `${hash.parse(id)}.json`);
async function indexFingerprint(root: string, slug: string) {
  const path = join(storyPaths(root, slug, 1).story, "source-name-index");
  return fingerprint(await Promise.all(["index.json", "rules.json", "ambiguous.json"].map(name => fileFingerprint(join(path, name)))));
}

async function readRun(root: string, story: string, id: string) {
  const raw = await readJsonIfExists(runFile(root, story, id));
  if (raw === undefined) return undefined;
  const run = runSchema.parse(raw);
  if (run.id !== id || run.input.story !== story) throw new Error("Source Name Index run identity mismatch");
  return run;
}

async function inputs(root: string, input: z.infer<typeof planInput>) {
  const paths = storyPaths(root, input.story, 1);
  const raw = await readJsonIfExists(paths.sourceManifest);
  if (!raw) throw new Error("Import source chapters before preparing a Source Name Index scan.");
  for (const path of [paths.source, paths.sourceManifest, paths.sourceChapters]) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Source Name Index scans require regular imported source files.");
  }
  const manifest = sourceManifestSchema.parse(raw);
  const story = storySchema.parse(await readJsonIfExists(paths.storyConfig));
  if (story.slug !== input.story) throw new Error("Story configuration slug mismatch");
  const records = new Map(manifest.chapters.map(item => [item.chapter, item]));
  const discovered = manifest.chapters.map(item => ({
    chapter: item.chapter, filename: basename(item.file), path: join(paths.source, safeRelative(item.file)),
    source: { type: item.ref.sourceType, sourceId: item.ref.sourceId, fingerprint: item.contentFingerprint ?? item.fingerprint, metadata: item.ref.metadata },
  }));
  const chapters = selectChapterNumbers(discovered, input.chapters === "all" ? discovered.map(item => item.chapter) : input.chapters, story.title);
  const byChapter = new Map(chapters.map(chapter => [chapter.chapter, chapter]));
  const readSource = async (chapter: number) => {
    const entry = byChapter.get(chapter);
    const record = records.get(chapter);
    if (!entry || !record) throw new Error(`Chapter ${chapter} is outside the approved selection`);
    if (!(await lstat(entry.path)).isFile()) throw new Error(`Chapter ${chapter} is not a regular imported source file.`);
    const text = await readFile(entry.path, "utf8");
    if (importedChapterFingerprint(record.ref, text) !== record.fingerprint) throw new Error(`Imported source changed for chapter ${chapter}. Refresh the import and preview again.`);
    if (!text.trim()) throw new Error(`Imported source is empty for chapter ${chapter}`);
    return text;
  };
  return { chapters, readSource, instructions: sourceNameScanInstructions(story.outputLanguage) };
}

type ScanRequest = {
  id: string; kind: "structured"; schemaName: string; instructions: string; input: string;
  schema: unknown; references: []; chapter: number;
};
function report(run: Run, request?: ScanRequest) {
  return {
    id: run.id, story: run.input.story, agent: run.input.agent, model: run.input.model,
    status: run.status, planFingerprint: run.planFingerprint, approvedAt: run.approvedAt,
    stage: "sourceNameIndex" as const, chapterSelection: formatChapterSelection(run.chapters), chapterCount: run.chapters.length,
    completedPassages: run.cursor, totalPassages: run.passages.length, apiRequests: 0,
    diagnostic: run.diagnostic, result: run.result, ...(request ? { request } : {}),
  };
}

export async function prepareSourceNameAgentRun(root: string, raw: unknown) {
  const input = planInput.parse(raw);
  return withStoryLock(root, input.story, "prepare subscription source name scan", async () => {
    await recoverTransactions(storyPaths(root, input.story, 1).story);
    const { chapters, readSource, instructions } = await inputs(root, input);
    const passages = new Map<string, Run["passages"][number]>();
    for (const { chapter } of chapters) {
      for (const [offset, text] of sourceNamePassages(await readSource(chapter)).entries()) {
        const id = fingerprint(text);
        if (!passages.has(id)) passages.set(id, { id, chapter, offset });
      }
    }
    const baseline = {
      input, chapters: chapters.map(item => item.chapter), passages: [...passages.values()],
      sourceRevision: sourceNameRevision(chapters), promptFingerprint: fingerprint(instructions),
      priorIndexFingerprint: await indexFingerprint(root, input.story),
    };
    const run: Run = { ...baseline, kind: "sourceNameIndex", id: randomUUID(), planFingerprint: fingerprint(baseline), status: "awaiting-confirmation", cursor: 0 };
    await save(root, run);
    return report(run);
  });
}

async function checkBaseline(root: string, run: Run) {
  const current = await inputs(root, run.input);
  if (run.sourceRevision !== sourceNameRevision(current.chapters) || run.promptFingerprint !== fingerprint(current.instructions)
    || run.priorIndexFingerprint !== await indexFingerprint(root, run.input.story)) {
    throw new Error("The selected source, scan instructions, or naming data changed. Prepare and confirm a new preview.");
  }
  return current;
}

async function next(root: string, run: Run) {
  if (!run.approvedAt) throw new Error("Confirm the preview before reading a scan request");
  if (run.status !== "running") return report(run);
  const slug = run.input.story;
  if (run.cursor === run.passages.length) {
    // Recover a publication whose final run-state write was interrupted.
    const existing = await loadSourceNameIndex(root, slug);
    if (existing?.subscription?.runId === run.id) {
      await bumpChapterStatusReadRevision(root, slug);
      run.status = "complete";
      run.result ??= { entries: existing.entries.length };
      await save(root, run);
      return report(run);
    }
  }
  const current = await checkBaseline(root, run);
  const passage = run.passages[run.cursor];
  if (passage) {
    const input = sourceNamePassages(await current.readSource(passage.chapter))[passage.offset];
    if (!input || fingerprint(input) !== passage.id) throw new Error("The approved passage changed. Prepare a new preview.");
    return report(run, {
      id: passage.id, kind: "structured" as const, schemaName: "source_name_index",
      instructions: current.instructions, input, schema: z.toJSONSchema(sourceNameExtractionSchema, { io: "input" }),
      references: [], chapter: passage.chapter,
    });
  }

  for (const chapter of current.chapters) await current.readSource(chapter.chapter);
  const result = await buildSourceNameIndex({
    chapters: current.chapters,
    extract: async text => sourceNameExtractionSchema.parse(await readJsonIfExists(responseFile(root, run, fingerprint(text)))),
  });
  if (result.status !== "ready") throw new Error("The approved index was not ready to publish");
  result.report.subscription = { runId: run.id, agent: run.input.agent, model: run.input.model, apiRequests: 0 };
  const published = await publishSourceNameScanWithHolds(root, slug, result.report, result.ambiguous);
  await bumpChapterStatusReadRevision(root, slug);
  run.result = { entries: published.entries, heldRules: published.heldRules, affectedChapters: published.affectedChapters };
  run.status = "complete";
  await save(root, run);
  return report(run);
}

/** Returns undefined for a legacy chapter-processing run. */
export async function runSourceNameAgentCommand(root: string, story: string, id: string, command: string, flags: Record<string, string | boolean>) {
  if (!await readRun(root, story, id)) return undefined;
  return withStoryLock(root, story, "subscription source name scan", async () => {
    await recoverTransactions(storyPaths(root, story, 1).story);
    const run = (await readRun(root, story, id))!;
    if (command === "report") return report(run);
    if (command === "confirm") {
      if (run.planFingerprint !== flags["--plan"]) throw new Error("Confirmation does not match the preview");
      if (!run.approvedAt) {
        const current = await checkBaseline(root, run);
        for (const chapter of current.chapters) await current.readSource(chapter.chapter);
        run.approvedAt = new Date().toISOString();
        run.status = "running";
        await save(root, run);
      }
      return report(run);
    }
    if (!run.approvedAt) throw new Error("Confirm the preview before execution");
    if (command === "next") return next(root, run);
    if (command === "resume") {
      if (run.status === "needs-input") {
        await checkBaseline(root, run);
        run.status = "running";
        run.diagnostic = undefined;
        await save(root, run);
      }
      return next(root, run);
    }
    const passage = run.passages[run.cursor];
    if (!passage || passage.id !== flags["--request"] || !["running", "needs-input"].includes(run.status)) {
      throw new Error("Response does not match the current approved scan request");
    }
    if (command === "fail") {
      run.status = "needs-input";
      run.diagnostic = z.string().min(1).parse(flags["--reason"]);
      await save(root, run);
      return report(run);
    }
    if (command !== "respond") throw new Error("Unsupported Source Name Index command");
    await checkBaseline(root, run);
    const file = z.string().min(1).parse(flags["--file"]);
    const info = await stat(file);
    if (!info.isFile() || info.size === 0 || info.size > 1024 * 1024) throw new Error("Passage response must be a nonempty JSON file of at most 1 MiB");
    let value;
    try { value = sourceNameExtractionSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
      run.status = "needs-input";
      run.diagnostic = `Invalid Source Name Index response. Correct the JSON and resubmit request ${passage.id}.`;
      await save(root, run);
      return report(run);
    }
    await atomicWriteJson(responseFile(root, run, passage.id), value);
    run.cursor++;
    run.status = "running";
    run.diagnostic = undefined;
    await save(root, run);
    return next(root, run);
  });
}
