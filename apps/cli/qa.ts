#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { StudioOperations } from "../server/operations.js";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { loadStory } from "../../src/config/load-config.js";
import { QaFinding, qaExceptionSchema } from "../../src/domain/qa.js";
import { LLMRouter } from "../../src/llm/router.js";
import { createPipelineRuntime } from "../../src/pipeline/create-pipeline.js";
import { migrateQaState, qaCounts, resolvedFindings, openFindings } from "../../src/qa/findings.js";
import { inspectQaRecheck, recheckChapterQa, type QaRecheckSummary } from "../../src/qa/review.js";
import { readJsonIfExists } from "../../src/storage/story-files.js";
import { storyPaths } from "../../src/storage/paths.js";
import { withStoryLock } from "../../src/storage/story-lock.js";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const findingPattern = /^qaf_[a-f0-9]{24}$/;
const exceptionPattern = /^qax_[a-f0-9]{24}$/;

export type QaCommand =
  | { action: "show"; story: string; chapter: number; filter: "open" | "resolved" }
  | { action: "recheck"; story: string; chapter: number; full: boolean; dryRun: boolean }
  | { action: "fix-safe"; story: string; chapter: number; dryRun: boolean }
  | { action: "exceptions"; story: string; remove?: string; add?: { category: string; matchKind: string; value: string; reason?: string } }
  | { action: "dismiss"; story: string; chapter: number; id: string; reason?: string; remember?: { matchKind: string; value: string } }
  | { action: "reopen"; story: string; chapter: number; id: string }
  | { action: "resolve"; story: string; chapter: number; id: string }
  | { action: "reset"; story: string; chapter?: number; from?: number; to?: number; all?: boolean };

function flag(values: string[], name: string) { return values.includes(name); }
function option(values: string[], name: string) { const index = values.indexOf(name); return index >= 0 ? values[index + 1] : undefined; }
function chapterArg(value: string | undefined) {
  const chapter = Number(value);
  if (!value || !Number.isSafeInteger(chapter) || chapter < 1) throw new Error("A positive chapter number is required");
  return chapter;
}

export function parseQaArgs(values: string[]): QaCommand {
  const [action, story, third, ...rest] = values;
  if (!action || !story || !slugPattern.test(story)) throw new Error("A valid story slug is required");
  const chapterActions = ["show", "recheck", "fix-safe", "dismiss", "reopen", "resolve"];
  if (chapterActions.includes(action)) {
    const chapter = chapterArg(third);
    if (action === "show") {
      const resolved = flag(rest, "--resolved");
      if (resolved && flag(rest, "--open")) throw new Error("Choose either --open or --resolved, not both");
      if (rest.some((value) => value !== "--open" && value !== "--resolved")) throw new Error("Show accepts [--open|--resolved]");
      return { action, story, chapter, filter: resolved ? "resolved" : "open" };
    }
    if (action === "recheck") {
      if (rest.some((value) => value !== "--full" && value !== "--dry-run")) throw new Error("Recheck accepts [--full] [--dry-run]");
      return { action, story, chapter, full: flag(rest, "--full"), dryRun: flag(rest, "--dry-run") };
    }
    if (action === "fix-safe") {
      if (rest.some((value) => value !== "--dry-run")) throw new Error("Fix-safe accepts [--dry-run]");
      return { action, story, chapter, dryRun: flag(rest, "--dry-run") };
    }
    const id = rest[0];
    if (!id || !findingPattern.test(id)) throw new Error(`${action} requires a finding ID (qaf_...)`);
    if (action === "dismiss") {
      const reason = option(rest, "--reason");
      const remember = flag(rest, "--remember") ? { matchKind: option(rest, "--match-kind"), value: option(rest, "--value") } : undefined;
      if (remember && (!remember.matchKind || !remember.value)) throw new Error("--remember requires --match-kind terminology|entity|rule|other and --value text");
      return { action, story, chapter, id, reason, remember: remember as { matchKind: string; value: string } | undefined };
    }
    if (rest.length !== 1) throw new Error(`${action} accepts no extra arguments`);
    return { action, story, chapter, id } as QaCommand;
  }
  if (action === "exceptions") {
    const remove = option(values, "--remove");
    if (remove !== undefined && !exceptionPattern.test(remove)) throw new Error("--remove requires an exception ID (qax_...)");
    if (flag(values, "--add")) {
      const category = option(values, "--category"); const matchKind = option(values, "--match-kind"); const value = option(values, "--value"); const reason = option(values, "--reason");
      if (!category || !matchKind || !value) throw new Error("--add requires --category, --match-kind, and --value");
      return { action, story, add: { category, matchKind, value, reason } };
    }
    if (values.slice(2).some((value) => value !== "--remove" && value !== remove)) throw new Error("Exceptions accepts [--remove qax_...] or --add flags");
    return { action, story, remove };
  }
  if (action === "reset") {
    const chapterStr = option(values, "--chapter");
    const fromStr = option(values, "--from");
    const toStr = option(values, "--to");
    const all = flag(values, "--all");

    const hasChapter = chapterStr !== undefined || (Boolean(third) && /^\d+$/.test(third));
    const hasRange = fromStr !== undefined || toStr !== undefined;
    const modeCount = (hasChapter ? 1 : 0) + (hasRange ? 1 : 0) + (all ? 1 : 0);
    if (modeCount > 1) {
      throw new Error("Reset modes (--chapter, --from/--to, --all) cannot be combined");
    }

    if (all) {
      return { action: "reset", story, all: true };
    }
    if (hasRange) {
      if (fromStr === undefined || toStr === undefined) throw new Error("Range reset requires both --from and --to");
      const from = Number(fromStr);
      const to = Number(toStr);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
        throw new Error("Invalid chapter range: --to must be greater than or equal to --from and both >= 1");
      }
      return { action: "reset", story, from, to };
    }
    if (chapterStr !== undefined) {
      const chapter = chapterArg(chapterStr);
      return { action: "reset", story, chapter };
    }
    if (third && /^\d+$/.test(third)) {
      const chapter = chapterArg(third);
      return { action: "reset", story, chapter };
    }
    throw new Error("Reset requires --chapter <n>, --from <f> --to <t>, or --all");
  }
  throw new Error(`Unknown qa action: ${action}`);
}

const truncate = (text: string, length = 120) => text.length > length ? `${text.slice(0, length)}…` : text;

function printFinding(finding: QaFinding, stdout: (text: string) => unknown) {
  const resolution = finding.status === "open" ? "open" : `${finding.status} (${finding.resolution?.action ?? "resolved"}${finding.resolution?.reason ? `: ${finding.resolution.reason}` : ""})`;
  stdout(`${finding.id}\t${finding.category}\t${finding.severity}\t${resolution}\t${truncate(finding.message)}\n`);
}

function printSummary(story: string, chapter: number, summary: QaRecheckSummary, stdout: (text: string) => unknown) {
  stdout(`Rechecked ${story} chapter ${chapter}: mode=${summary.mode}${summary.fellBackToFull ? " (fell back to full)" : ""}\n`);
  stdout(`verified=${summary.verified} respected=${summary.respected} reopened=${summary.reopened} new=${summary.newFindings} obsolete=${summary.obsoleted}\n`);
  stdout(`open=${summary.open}${summary.open ? " (needs attention)" : ""} resolved=${summary.resolved} safeFixesAvailable=${summary.safeFixesAvailable}\n`);
}

type QaOperations = Pick<StudioOperations, "dismissQaFinding" | "reopenQaFinding" | "resolveQaFindingManually" | "listQaExceptions" | "addQaException" | "removeQaException" | "applyQaSafeFixes" | "resetChapterQa" | "resetQaBatch">;

async function main() {
  const command = parseQaArgs(process.argv.slice(2)); const env = loadEnvironment(); const root = resolveStudioRoot(env); const operations = new StudioOperations(root, env); const runtime = createPipelineRuntime(env);
  try { await runQaCommand(command, { root, operations, llm: runtime.router, stdout: (text) => process.stdout.write(text) }); } finally { await operations.close(); }
}

export async function runQaCommand(command: QaCommand, d: { root: string; operations: QaOperations; llm: LLMRouter; stdout: (text: string) => unknown }) {
  if (command.action === "reset") {
    if (command.chapter !== undefined) {
      const result = await d.operations.resetChapterQa(command.story, command.chapter);
      if (result.reset) {
        d.stdout(`Reset QA data for Chapter ${command.chapter}. Other stages were not changed.\n`);
      } else {
        d.stdout(`Chapter ${command.chapter} already has no QA data (QA not run). Other stages were not changed.\n`);
      }
      return;
    }
    const batchOptions = command.all
      ? { all: true as const }
      : command.from !== undefined && command.to !== undefined
        ? { from: command.from, to: command.to }
        : { all: true as const };
    const result = await d.operations.resetQaBatch(command.story, batchOptions);
    d.stdout(`Reset QA data for ${result.reset} of ${result.requested} chapter(s). Other stages were not changed.\n`);
    if (result.failed > 0) {
      d.stdout(`Failures (${result.failed}):\n`);
      for (const fail of result.failures) {
        d.stdout(`  Chapter ${fail.chapter}: ${fail.reason}\n`);
      }
    }
    return;
  }
  const paths = storyPaths(d.root, command.story, "chapter" in command ? command.chapter : 1);
  if (command.action === "show") {
    const raw = await readJsonIfExists(paths.qa);
    if (!raw) throw new Error(`Chapter ${command.chapter} does not have a QA result`);
    const state = migrateQaState(raw, { chapter: command.chapter });
    const findings = command.filter === "open" ? openFindings(state) : resolvedFindings(state);
    if (findings.length) for (const finding of findings) printFinding(finding, d.stdout);
    else d.stdout(`No ${command.filter} QA findings.\n`);
    const counts = qaCounts(state);
    d.stdout(`open=${counts.open} resolved=${counts.resolved} safeFixesAvailable=${counts.safeFixesAvailable}\n`);
    return;
  }
  if (command.action === "recheck") {
    const story = await loadStory(paths.storyConfig);
    const mode = command.full ? "full" as const : "changed" as const;
    if (command.dryRun) {
      const inspection = await inspectQaRecheck({ root: d.root, story, chapter: command.chapter, mode });
      d.stdout(`Would recheck ${command.story} chapter ${command.chapter}: mode=${inspection.mode}${inspection.fellBackToFull ? " (falls back to full)" : ""}\n`);
      if (inspection.mode === "changed") d.stdout(`changed paragraphs=${inspection.changedCount}/${inspection.totalCount}; sending [${inspection.selectedLabels.join(", ")}] (+neighbors)\n`);
      d.stdout(`previous findings supplied=${inspection.previousFindings} exceptions applied=${inspection.exceptions}\n`);
      return;
    }
    await withStoryLock(d.root, command.story, "QA recheck", async () => {
      const result = await recheckChapterQa({ root: d.root, story, chapter: command.chapter, provider: d.llm.forStage(story.pipeline.qa), mode });
      printSummary(command.story, command.chapter, result.summary, d.stdout);
    });
    return;
  }
  if (command.action === "fix-safe") {
    if (command.dryRun) {
      const raw = await readJsonIfExists(paths.qa);
      if (!raw) throw new Error(`Chapter ${command.chapter} does not have a QA result`);
      const safe = migrateQaState(raw, { chapter: command.chapter }).findings.filter((finding) => finding.status === "open" && finding.safeToFix === true);
      if (!safe.length) { d.stdout("No safe-to-fix open QA findings.\n"); return; }
      d.stdout(`Would apply ${safe.length} safe fix(es):\n`);
      for (const finding of safe) printFinding(finding, d.stdout);
      return;
    }
    await withStoryLock(d.root, command.story, "QA safe fixes", async () => {
      const result = await d.operations.applyQaSafeFixes(command.story, command.chapter);
      d.stdout(`fixed=${result.fixed.length} failed=${result.failed.length}\n`);
      for (const id of result.fixed) d.stdout(`fixed\t${id}\n`);
      for (const failure of result.failed) d.stdout(`failed\t${failure.id}\t${truncate(failure.message)}\n`);
      if (result.summary) printSummary(command.story, command.chapter, result.summary, d.stdout);
    });
    return;
  }
  if (command.action === "exceptions") {
    if (command.add) {
      const input = { category: command.add.category, matchKind: command.add.matchKind, value: command.add.value, reason: command.add.reason };
      const parsed = qaExceptionSchema.omit({ id: true, createdAt: true }).parse(input);
      const result = await d.operations.addQaException(command.story, parsed);
      d.stdout(`${result.created ? "Added" : "Already present"}\t${result.exception.id}\t${result.exception.category}/${result.exception.matchKind}\t"${result.exception.value}"\n`);
      return;
    }
    if (command.remove) {
      await d.operations.removeQaException(command.story, command.remove);
      d.stdout(`Removed ${command.remove}\n`);
      return;
    }
    const { exceptions } = await d.operations.listQaExceptions(command.story);
    d.stdout(exceptions.length ? exceptions.map((exception) => `${exception.id}\t${exception.category}/${exception.matchKind}\t"${exception.value}"${exception.reason ? `\t${exception.reason}` : ""}`).join("\n") + "\n" : "No QA exceptions.\n");
    return;
  }
  if (command.action === "dismiss") {
    const remember = command.remember ? { matchKind: qaExceptionSchema.shape.matchKind.parse(command.remember.matchKind), value: command.remember.value } : undefined;
    const result = await d.operations.dismissQaFinding(command.story, command.chapter, command.id, { reason: command.reason, remember });
    d.stdout(`dismissed\t${result.finding.id}${result.exception ? `\texception=${result.exception.id}` : ""}\n`);
    return;
  }
  if (command.action === "reopen") {
    const result = await d.operations.reopenQaFinding(command.story, command.chapter, command.id);
    d.stdout(`reopened\t${result.finding.id}\n`);
    return;
  }
  const result = await d.operations.resolveQaFindingManually(command.story, command.chapter, command.id, {});
  d.stdout(`resolved\t${result.finding.id}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
