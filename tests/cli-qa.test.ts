import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseQaArgs, runQaCommand } from "../apps/cli/qa.js";
import { StudioOperations } from "../apps/server/operations.js";
import { loadEnvironment } from "../src/config/env.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { qaStateSchema } from "../src/domain/qa.js";
import { LLMRouter } from "../src/llm/router.js";
import { buildQaState, resolveQaFindingsByIndex } from "../src/qa/review.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { MockLLM, testStory } from "./helpers.js";

const NOW = "2026-09-16T12:00:00.000Z";
const env = loadEnvironment({});

describe("story:qa argument parsing", () => {
  it("parses show filters, recheck flags, and fix-safe dry-run", () => {
    expect(parseQaArgs(["show", "demo-story", "3"])).toEqual({ action: "show", story: "demo-story", chapter: 3, filter: "open" });
    expect(parseQaArgs(["show", "demo-story", "3", "--resolved"])).toMatchObject({ filter: "resolved" });
    expect(parseQaArgs(["recheck", "demo-story", "1"])).toEqual({ action: "recheck", story: "demo-story", chapter: 1, full: false, dryRun: false });
    expect(parseQaArgs(["recheck", "demo-story", "1", "--full", "--dry-run"])).toMatchObject({ full: true, dryRun: true });
    expect(parseQaArgs(["fix-safe", "demo-story", "2", "--dry-run"])).toEqual({ action: "fix-safe", story: "demo-story", chapter: 2, dryRun: true });
  });
  it("parses finding lifecycle actions and exceptions flags", () => {
    const id = "qaf_0123456789abcdef01234567";
    expect(parseQaArgs(["dismiss", "demo-story", "1", id, "--reason", "approved"])).toMatchObject({ action: "dismiss", id, reason: "approved" });
    expect(parseQaArgs(["dismiss", "demo-story", "1", id, "--remember", "--match-kind", "terminology", "--value", "Azure Flame"])).toMatchObject({ remember: { matchKind: "terminology", value: "Azure Flame" } });
    expect(parseQaArgs(["reopen", "demo-story", "1", id])).toEqual({ action: "reopen", story: "demo-story", chapter: 1, id });
    expect(parseQaArgs(["resolve", "demo-story", "1", id])).toEqual({ action: "resolve", story: "demo-story", chapter: 1, id });
    expect(parseQaArgs(["exceptions", "demo-story"])).toEqual({ action: "exceptions", story: "demo-story", remove: undefined });
    expect(parseQaArgs(["exceptions", "demo-story", "--remove", "qax_0123456789abcdef01234567"])).toMatchObject({ remove: "qax_0123456789abcdef01234567" });
    expect(parseQaArgs(["exceptions", "demo-story", "--add", "--category", "names", "--match-kind", "entity", "--value", "Marcus"])).toMatchObject({ add: { category: "names", matchKind: "entity", value: "Marcus" } });
  });
  it("rejects invalid input", () => {
    expect(() => parseQaArgs(["show", "demo-story", "0"])).toThrow(/chapter/i);
    expect(() => parseQaArgs(["show", "demo-story", "1", "--open", "--resolved"])).toThrow(/either/i);
    expect(() => parseQaArgs(["dismiss", "demo-story", "1", "not-an-id"])).toThrow(/qaf_/);
    expect(() => parseQaArgs(["dismiss", "demo-story", "1", "qaf_0123456789abcdef01234567", "--remember"])).toThrow(/match-kind/);
    expect(() => parseQaArgs(["exceptions", "demo-story", "--remove", "nope"])).toThrow(/qax_/);
    expect(() => parseQaArgs(["bogus", "demo-story"])).toThrow(/Unknown qa action/);
  });
  it("parses reset scope flags and rejects invalid combinations", () => {
    expect(parseQaArgs(["reset", "demo-story", "--chapter", "3"])).toEqual({ action: "reset", story: "demo-story", chapter: 3 });
    expect(parseQaArgs(["reset", "demo-story", "--from", "1", "--to", "5"])).toEqual({ action: "reset", story: "demo-story", from: 1, to: 5 });
    expect(parseQaArgs(["reset", "demo-story", "--all"])).toEqual({ action: "reset", story: "demo-story", all: true });
    expect(() => parseQaArgs(["reset", "demo-story"])).toThrow(/requires --chapter/i);
    expect(() => parseQaArgs(["reset", "demo-story", "--chapter", "1", "--all"])).toThrow(/cannot be combined/i);
    expect(() => parseQaArgs(["reset", "demo-story", "--from", "5", "--to", "2"])).toThrow(/greater than or equal/i);
  });
});

const detections = [
  { category: "terminology" as const, severity: "warn" as const, message: "Use the canonical ability name", evidence: "Azure Flame is the locked term." },
  { category: "names" as const, severity: "warn" as const, message: "A name drifted", evidence: "Su Ming became Marcus." },
];

async function fixture(options: { safeFinding?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "cli-qa-"));
  const story = testStory();
  const paths = storyPaths(root, story.slug, 1);
  const now = new Date().toISOString();
  const complete = { status: "complete" as const, fingerprint: "in", outputFingerprint: "out" };
  await atomicWriteJson(paths.storyConfig, story);
  await atomicWriteJson(paths.chapterMeta, chapterSchema.parse({
    chapter: 1, sourceLanguage: story.sourceLanguage, outputLanguage: story.outputLanguage,
    counts: { originalCharacters: 100, englishWords: 10, narrationWords: 10 }, createdAt: now, updatedAt: now,
    stages: { ingestion: complete, translation: complete, narration: complete, qa: complete, storyBible: { status: "pending" }, tts: { status: "pending" } },
  }));
  const text = "The keeper raised the Azure Flame above the gate.";
  await atomicWrite(paths.original, "原文");
  await atomicWrite(paths.english, text);
  await atomicWrite(paths.narration, text);
  await atomicWriteJson(paths.storyContext, {});
  const detectionList = options.safeFinding
    ? [{ category: "names" as const, severity: "warn" as const, message: `Narration uses "Suming" but the authorized narration rendering is "Asher".`, evidence: `Narration contains "Suming" but never "Asher".`, origin: "deterministic" as const, safeToFix: true, entityIds: ["ent_aaaaaaaaaaaaaaaaaaaaaaaa"] }]
    : detections;
  let state = buildQaState(undefined, detectionList, { chapter: 1, translation: text, narration: text, now: NOW }).state;
  if (!options.safeFinding) state = resolveQaFindingsByIndex(state, [1], "dismissed", NOW, 1);
  await atomicWriteJson(paths.qa, state);
  return { root, story, paths, state };
}

const llmRouter = (mock: MockLLM) => new LLMRouter(new Map([["openai", mock], ["gemini", mock]]));
const collect = () => { let output = ""; return { stdout: (text: string) => { output += text; }, get: () => output }; };
const readState = async (paths: ReturnType<typeof storyPaths>) => qaStateSchema.parse(JSON.parse(await readFile(paths.qa, "utf8")));

describe("story:qa commands", () => {
  it("show lists open findings by default and resolved ones with --resolved", async () => {
    const { root, story, state } = await fixture();
    const operations = new StudioOperations(root, env);
    try {
      const open = collect();
      await runQaCommand(parseQaArgs(["show", story.slug, "1"]), { root, operations, llm: llmRouter(new MockLLM()), stdout: open.stdout });
      expect(open.get()).toContain(state.findings.find((finding) => finding.category === "terminology")!.id);
      expect(open.get()).not.toContain(state.findings.find((finding) => finding.category === "names")!.id);
      expect(open.get()).toContain("open=1 resolved=1 safeFixesAvailable=0");
      const resolved = collect();
      await runQaCommand(parseQaArgs(["show", story.slug, "1", "--resolved"]), { root, operations, llm: llmRouter(new MockLLM()), stdout: resolved.stdout });
      expect(resolved.get()).toContain("dismissed (dismiss)");
      expect(resolved.get()).toContain(state.findings.find((finding) => finding.category === "names")!.id);
    } finally { await operations.close(); }
  });

  it("recheck --dry-run safely falls back for legacy QA without dependency snapshots", async () => {
    const { root, story, paths } = await fixture();
    const mock = new MockLLM("openai");
    const operations = new StudioOperations(root, env);
    try {
      const out = collect();
      await runQaCommand(parseQaArgs(["recheck", story.slug, "1", "--dry-run"]), { root, operations, llm: llmRouter(mock), stdout: out.stdout });
      expect(mock.calls).toHaveLength(0);
      expect(out.get()).toContain("mode=full (falls back to full)");
      expect(out.get()).toContain("previous findings supplied=2");
      expect(out.get()).toContain("exceptions applied=0");
      // Without content spans or a dependency snapshot the dry run reports the full-mode fallback.
      const state = await readState(paths);
      await atomicWriteJson(paths.qa, { ...state, contentSpans: undefined });
      const fallback = collect();
      await runQaCommand(parseQaArgs(["recheck", story.slug, "1", "--dry-run"]), { root, operations, llm: llmRouter(mock), stdout: fallback.stdout });
      expect(mock.calls).toHaveLength(0);
      expect(fallback.get()).toContain("mode=full (falls back to full)");
    } finally { await operations.close(); }
  });

  it("fix-safe --dry-run lists safe findings without mutating anything", async () => {
    const { root, story, paths, state } = await fixture({ safeFinding: true });
    const operations = new StudioOperations(root, env);
    try {
      const narrationBefore = await readFile(paths.narration, "utf8");
      const out = collect();
      await runQaCommand(parseQaArgs(["fix-safe", story.slug, "1", "--dry-run"]), { root, operations, llm: llmRouter(new MockLLM()), stdout: out.stdout });
      expect(out.get()).toContain("Would apply 1 safe fix(es)");
      expect(out.get()).toContain(state.findings[0]!.id);
      expect(await readFile(paths.narration, "utf8")).toBe(narrationBefore);
    } finally { await operations.close(); }
  });

  it("exceptions add, list, and remove round-trip through the shared operations", async () => {
    const { root, story } = await fixture();
    const operations = new StudioOperations(root, env);
    try {
      const empty = collect();
      await runQaCommand(parseQaArgs(["exceptions", story.slug]), { root, operations, llm: llmRouter(new MockLLM()), stdout: empty.stdout });
      expect(empty.get()).toContain("No QA exceptions.");
      const added = collect();
      await runQaCommand(parseQaArgs(["exceptions", story.slug, "--add", "--category", "terminology", "--match-kind", "terminology", "--value", "Azure Flame", "--reason", "Approved"]), { root, operations, llm: llmRouter(new MockLLM()), stdout: added.stdout });
      expect(added.get()).toMatch(/Added\tqax_[a-f0-9]{24}\tterminology\/terminology\t"Azure Flame"/);
      const listed = collect();
      await runQaCommand(parseQaArgs(["exceptions", story.slug]), { root, operations, llm: llmRouter(new MockLLM()), stdout: listed.stdout });
      const id = /qax_[a-f0-9]{24}/.exec(listed.get())![0];
      const removed = collect();
      await runQaCommand(parseQaArgs(["exceptions", story.slug, "--remove", id]), { root, operations, llm: llmRouter(new MockLLM()), stdout: removed.stdout });
      expect(removed.get()).toContain(`Removed ${id}`);
    } finally { await operations.close(); }
  });

  it("dismiss and reopen a finding by id through the shared operations", async () => {
    const { root, story, paths, state } = await fixture();
    const operations = new StudioOperations(root, env);
    try {
      const id = state.findings.find((finding) => finding.category === "terminology")!.id;
      const dismissed = collect();
      await runQaCommand(parseQaArgs(["dismiss", story.slug, "1", id, "--reason", "accepted wording"]), { root, operations, llm: llmRouter(new MockLLM()), stdout: dismissed.stdout });
      expect(dismissed.get()).toContain(`dismissed\t${id}`);
      let after = await readState(paths);
      expect(after.findings.find((finding) => finding.id === id)).toMatchObject({ status: "dismissed", resolution: { action: "dismiss", reason: "accepted wording" } });
      const reopened = collect();
      await runQaCommand(parseQaArgs(["reopen", story.slug, "1", id]), { root, operations, llm: llmRouter(new MockLLM()), stdout: reopened.stdout });
      expect(reopened.get()).toContain(`reopened\t${id}`);
      after = await readState(paths);
      expect(after.findings.find((finding) => finding.id === id)).toMatchObject({ status: "open", resolution: { action: "dismiss" } });
    } finally { await operations.close(); }
  });

  it("reset command resets QA data cleanly via CLI", async () => {
    const { root, story, paths } = await fixture();
    const operations = new StudioOperations(root, env);
    try {
      const out = collect();
      await runQaCommand(parseQaArgs(["reset", story.slug, "--chapter", "1"]), { root, operations, llm: llmRouter(new MockLLM()), stdout: out.stdout });
      expect(out.get()).toContain("Reset QA data for Chapter 1. Other stages were not changed.");
      const meta = chapterSchema.parse(JSON.parse(await readFile(paths.chapterMeta, "utf8")));
      expect(meta.stages.qa).toEqual({ status: "pending" });
    } finally { await operations.close(); }
  });
});
