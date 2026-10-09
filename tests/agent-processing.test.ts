import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testStory, pngWithDims } from "./helpers.js";
import { atomicWrite, atomicWriteJson } from "../src/storage/atomic-write.js";
import * as atomicWrites from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { chapterSchema } from "../src/domain/chapter.js";
import { qaStateSchema } from "../src/domain/qa.js";
import { transitionQaFinding } from "../src/qa/review.js";
import { prepareAgentRun, confirmAgentRun, nextAgentRequest, submitAgentResponse, failAgentRequest, reportAgentRun, resumeAgentRun, type AgentRun } from "../src/agent-processing/service.js";
import { inventory, inventoryFingerprint, recoverTransactions, commitSnapshot, copySnapshot } from "../src/agent-processing/snapshot.js";
import { fingerprint } from "../src/utils/hash.js";
import { runAgentCommand } from "../apps/cli/agent.js";
import { sceneManifestSchema } from "../src/scenes/types.js";

const translation = 'Chapter 1\nThe star lamp lit up. He said, "Welcome."';
const source = '第一章\n星灯亮起。他说道：“欢迎。”';
const pass = { status: "pass", score: 1, issues: [], checks: { completeness: "pass", names: "pass", numbers: "pass", terminology: "pass", dialogue: "pass", storyConsistency: "pass", narrationFidelity: "pass" } };
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "story-agent-"));
  await atomicWriteJson(storyPaths(root, "demo-story", 1).storyConfig, testStory());
  for (const number of [1, 2, 3]) await atomicWrite(storyPaths(root, "demo-story", number).original, source);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in agent tests"); }));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
async function plan(stages = ["translation", "narration"] as string[], chapters = [1], extra = {}) {
  return prepareAgentRun(root, { story: "demo-story", chapters, stages, agent: "codex", model: "session-model", ...extra });
}
async function start(run: AgentRun) {
  await confirmAgentRun(root, run.input.story, run.id, run.planFingerprint);
  return nextAgentRequest(root, run.input.story, run.id);
}
async function respond(run: AgentRun, value: unknown) {
  const file = join(root, "response");
  await writeFile(file, Buffer.isBuffer(value) ? value : typeof value === "string" ? value : JSON.stringify(value));
  return submitAgentResponse(root, run.input.story, run.id, run.request!.id, file);
}
async function core() {
  let run = await start(await plan());
  run = await respond(run, translation);
  return respond(run, translation);
}
async function metadata(chapter = 1) { return chapterSchema.parse(JSON.parse(await readFile(storyPaths(root, "demo-story", chapter).chapterMeta, "utf8"))); }

describe("subscription processing", () => {
  it("requires matching confirmation and preserves all content during preview and requests", async () => {
    const story = storyPaths(root, "demo-story", 1).story;
    const before = inventoryFingerprint(await inventory(story));
    const run = await plan();
    await expect(nextAgentRequest(root, "demo-story", run.id)).rejects.toThrow("Confirm");
    await expect(confirmAgentRun(root, "demo-story", run.id, "incorrect")).rejects.toThrow("preview");
    const request = await start(run);
    expect(request.request?.instructions).toContain("translate");
    expect(inventoryFingerprint(await inventory(story))).toBe(before);
    expect(await reportAgentRun(root, "demo-story", run.id)).toEqual(request);
  });
  it("commits translation/narration using ordinary artifacts, fingerprints, provenance, and reuse", async () => {
    const run = await core();
    expect(run.status).toBe("complete");
    expect(run.steps.map((step) => step.status)).toEqual(["complete", "complete"]);
    const chapter = await metadata();
    expect(chapter.stages.translation.provider).toBe("codex");
    expect(chapter.stages.narration.model).toBe("session-model");
    expect(chapter.stages.narration.execution?.apiRequests).toBe(0);
    expect(chapter.stages.narration.outputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(chapter.stages.narration.manualAcceptance).toBeDefined();
    expect(chapter.stages.tts.status).toBe("pending");
    expect(await readFile(storyPaths(root, "demo-story", 1).narrationTts, "utf8")).toBe(translation);
    const reused = await start(await plan());
    expect(reused.steps.map((step) => step.status)).toEqual(["reused", "reused"]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects stale previews and paused requests without overwriting manual edits", async () => {
    const preview = await plan();
    await atomicWrite(storyPaths(root, "demo-story", 1).original, source + "新内容");
    await expect(start(preview)).rejects.toThrow("Story changed");
    const run = await start(await plan(["translation"]));
    await atomicWrite(storyPaths(root, "demo-story", 1).english, "Manual translation");
    const stopped = await respond(run, translation);
    expect(stopped.status).toBe("needs-input");
    expect(await readFile(storyPaths(root, "demo-story", 1).english, "utf8")).toBe("Manual translation");
  });
  it("continues after refusal/summary substitution and blocks dependent work", async () => {
    let run = await start(await plan(undefined, [2, 1]));
    run = await respond(run, "I cannot provide a translation of this chapter. I can offer a summary instead.");
    expect(run.steps[0]?.status).toBe("refused");
    expect(run.steps[1]?.status).toBe("blocked");
    expect(run.steps[2]?.chapter).toBe(2);
    expect(run.request?.kind).toBe("text");
    run = await respond(run, translation); run = await respond(run, translation);
    expect(run.status).toBe("complete");
    expect((await metadata(1)).stages.translation.status).toBe("failed");
  });
  it("reports explicit tool refusals and missing scene prerequisites without paying for audio", async () => {
    const run = await start(await plan(["translation"], [1, 2]));
    const next = await failAgentRequest(root, "demo-story", run.id, run.request!.id, "refused", "Model refused the chapter");
    expect(next.steps[0]?.status).toBe("refused");
    expect(next.request).toBeDefined();
    const scenes = await start(await plan(["scenePlanning", "artwork"]));
    expect(scenes.steps.every((step) => step.status === "blocked")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("persists critical QA and continues batch QA while retaining dismissals", async () => {
    await core();
    let chapter2 = await start(await plan(undefined, [2]));
    chapter2 = await respond(chapter2, translation); await respond(chapter2, translation);
    let qa = await start(await plan(["qa"], [1, 2], { force: true }));
    expect(qa.request?.schemaName).toBe("chapter_qa");
    const failure = { ...pass, status: "fail", score: .5, checks: { ...pass.checks, numbers: "fail" }, issues: [{ category: "numbers", severity: "fail", message: "A numeric fact changed", evidence: "The lamp was described as seven rather than six" }] };
    qa = await respond(qa, failure);
    expect(qa.steps[0]?.quality).toBe("fail");
    expect(qa.request).toBeDefined();
    await respond(qa, pass);
    const paths = storyPaths(root, "demo-story", 1);
    const saved = qaStateSchema.parse(JSON.parse(await readFile(paths.qa, "utf8")));
    expect((await metadata()).stages.qa.status).toBe("complete");
    expect(saved.findings.some((finding) => finding.severity === "fail")).toBe(true);
    await atomicWriteJson(paths.qa, transitionQaFinding(saved, saved.findings.find((finding) => finding.severity === "fail")!.id, "dismiss"));
    let recheck = await start(await plan(["qa"], [1], { force: true }));
    expect(recheck.request?.input).toContain("dismissed");
    recheck = await respond(recheck, pass);
    expect(recheck.status).toBe("complete");
    const retained = qaStateSchema.parse(JSON.parse(await readFile(paths.qa, "utf8")));
    expect(retained.findings.some((finding) => finding.status === "dismissed")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects invalid structured output without committing corrupt QA", async () => {
    await core();
    const run = await start(await plan(["qa"]));
    const failed = await respond(run, { status: "pass" });
    expect(failed.status).toBe("needs-input");
    await expect(readFile(storyPaths(root, "demo-story", 1).qa)).rejects.toThrow();
    const corrected = await respond(failed, pass);
    expect(corrected.steps[0]?.status).toBe("complete");
  });
  it("pauses on requested stop-on-error and resumes at the next chapter", async () => {
    const run = await start(await plan(["translation"], [1, 2], { continueOnError: false }));
    const stopped = await failAgentRequest(root, "demo-story", run.id, run.request!.id, "refused", "Refused");
    expect(stopped.status).toBe("needs-input");
    expect(stopped.cursor).toBe(1);
    const resumed = await resumeAgentRun(root, "demo-story", run.id);
    expect(resumed.request).toBeDefined();
    expect(resumed.steps[resumed.cursor]?.chapter).toBe(2);
  });
  it("preserves a valid translation on a failed regeneration and records the attempt", async () => {
    await core();
    const run = await start(await plan(["translation"], [1], { force: true }));
    await respond(run, "I cannot provide a translation of this chapter. I can offer a summary instead.");
    expect(await readFile(storyPaths(root, "demo-story", 1).english, "utf8")).toBe(translation);
    const retained = await metadata();
    expect(retained.stages.translation.status).toBe("complete");
    expect(retained.stages.translation.lastAgentAttempt?.status).toBe("refused");
  });
  it("blocks later canonical updates across an earlier refused chapter", async () => {
    const run = await start(await plan(["translation", "narration", "qa", "storyBible"], [1, 2]));
    let next = await failAgentRequest(root, "demo-story", run.id, run.request!.id, "refused", "Refused");
    next = await respond(next, translation); next = await respond(next, translation); next = await respond(next, pass);
    expect(next.status).toBe("complete");
    expect(next.contextGaps).toContain(1);
    expect(next.steps.find((step) => step.chapter === 2 && step.stage === "storyBible")?.reason).toContain("context gap");
  });
  it("commits Story Bible updates and runs local continuity without an API request", async () => {
    await core();
    await respond(await start(await plan(["qa"])), pass);
    let run = await start(await plan(["storyBible", "continuity"]));
    expect(run.request?.schemaName).toBe("story_bible_update");
    run = await respond(run, { chapterSummary: "The star lamp lit up and a welcome was spoken." });
    expect(run.steps.map((step) => step.status)).toEqual(["complete", "complete"]);
    expect((await metadata()).stages.continuity.provider).toBe("local");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("imports native image results through normal artwork version and review handling", async () => {
    await core();
    const paths = storyPaths(root, "demo-story", 1);
    const manifest = sceneManifestSchema.parse({ version: 1, chapter: 1, durationSeconds: 20, planningFingerprint: "fixture", planner: { provider: "openai", model: "fixture", promptVersion: "fixture" }, manualRevision: 0, manuallyEdited: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), scenes: [{ id: "scene-001", startSeconds: 0, endSeconds: 20, durationSeconds: 20, summary: "A lamp lights up", narrationExcerpt: translation, visualPrompt: "A star lamp lighting up in an empty room", characters: [], artwork: { status: "pending" } }] });
    await atomicWriteJson(paths.scenesManifest, manifest);
    const run = await start(await plan(["artwork"], [1], { imageModel: "native-image-model", force: true }));
    expect(run.request?.kind).toBe("image");
    await expect(readFile(join(paths.scenesDirectory, "scene-001.png"))).rejects.toThrow();
    const complete = await respond(run, pngWithDims(1536, 1024));
    expect(complete.steps[0]?.status, complete.steps[0]?.reason).toBe("complete");
    const saved = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    expect(saved.scenes[0]?.artwork.versions?.[0]?.model).toBe("native-image-model");
    expect(saved.scenes[0]?.artwork.review).toBe("unreviewed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("plans timed scenes from existing mastered audio without requesting paid audio", async () => {
    await core();
    await respond(await start(await plan(["qa"])), pass);
    await respond(await start(await plan(["storyBible"])), { chapterSummary: "A star lamp lights up." });
    const paths = storyPaths(root, "demo-story", 1);
    const chapter = await metadata();
    chapter.audio = { durationSeconds: 20, codec: "mp3", container: "mp3" };
    chapter.stages.audioMastering.status = "complete";
    await atomicWrite(paths.audio, "ID3 existing mastered audio");
    await atomicWriteJson(paths.chapterMeta, chapter);
    let run = await start(await plan(["scenePlanning"]));
    expect(run.request?.schemaName).toBe("chapter_scene_plan");
    run = await respond(run, { scenes: [{ summary: "The star lamp lights up.", startSeconds: 0, endSeconds: 20, characters: [], visualPrompt: "An illuminated star lamp in a room", importance: "standard" }] });
    expect(run.steps[0]?.status, run.steps[0]?.reason).toBe("complete");
    const saved = sceneManifestSchema.parse(JSON.parse(await readFile(paths.scenesManifest, "utf8")));
    expect(saved.planner.provider).toBe("codex");
    expect(saved.durationSeconds).toBe(20);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rolls back a durable interrupted commit on recovery", async () => {
    const run = await plan();
    const story = storyPaths(root, "demo-story", 1).story;
    const transaction = join(story, "agent-runs", run.id, "transaction");
    await atomicWrite(join(transaction, "before", "story.json"), await readFile(join(story, "story.json")));
    await atomicWriteJson(join(transaction, "journal.json"), { version: 1, paths: ["story.json", "new.txt"], existing: ["story.json"] });
    await atomicWrite(join(story, "story.json"), "broken"); await atomicWrite(join(story, "new.txt"), "new");
    await recoverTransactions(story);
    expect(JSON.parse(await readFile(join(story, "story.json"), "utf8")).slug).toBe("demo-story");
    await expect(readFile(join(story, "new.txt"))).rejects.toThrow();
  });
  it("rolls back artifacts and the run checkpoint if publication fails", async () => {
    const run = await plan();
    const story = storyPaths(root, "demo-story", 1).story;
    const runDir = join(story, "agent-runs", run.id);
    const before = await inventory(story);
    const snapshot = join(root, "snapshot-fixture");
    await copySnapshot(story, snapshot, before);
    await atomicWrite(join(snapshot, "new.txt"), "generated output");
    const checkpointPath = join("agent-runs", run.id, "run.json");
    const originalCheckpoint = await readFile(join(story, checkpointPath), "utf8");
    const originalWrite = atomicWrites.atomicWrite;
    const spy = vi.spyOn(atomicWrites, "atomicWrite").mockImplementation(async (path, data) => {
      if (path === join(story, checkpointPath)) { spy.mockRestore(); throw new Error("Simulated checkpoint failure"); }
      return originalWrite(path, data);
    });
    await expect(commitSnapshot(story, snapshot, runDir, before, await inventory(snapshot), { path: checkpointPath, data: "new checkpoint" })).rejects.toThrow("checkpoint failure");
    await expect(readFile(join(story, "new.txt"))).rejects.toThrow();
    expect(await readFile(join(story, checkpointPath), "utf8")).toBe(originalCheckpoint);
  });
  it("protects a manual edit made after an interrupted commit", async () => {
    const run = await plan();
    const story = storyPaths(root, "demo-story", 1).story;
    const transaction = join(story, "agent-runs", run.id, "transaction");
    const hash = (text: string) => fingerprint(Buffer.from(text).toString("base64"));
    await atomicWrite(join(transaction, "before", "protected.txt"), "old");
    await atomicWriteJson(join(transaction, "journal.json"), { version: 1, paths: ["protected.txt"], existing: ["protected.txt"], beforeHashes: { "protected.txt": hash("old") }, afterHashes: { "protected.txt": hash("generated") } });
    await atomicWrite(join(story, "protected.txt"), "manual correction");
    await expect(recoverTransactions(story)).rejects.toThrow("Recovery blocked");
    expect(await readFile(join(story, "protected.txt"), "utf8")).toBe("manual correction");
  });
  it("cleans a committed journal without rolling back completed outputs", async () => {
    const run = await plan();
    const story = storyPaths(root, "demo-story", 1).story;
    const transaction = join(story, "agent-runs", run.id, "transaction");
    await atomicWriteJson(join(transaction, "journal.json"), { version: 1, paths: ["done.txt"], existing: [], committed: true });
    await atomicWrite(join(story, "done.txt"), "completed output");
    await recoverTransactions(story);
    expect(await readFile(join(story, "done.txt"), "utf8")).toBe("completed output");
  });
  it("parses mixed chapter selections and rejects paid stages and unsafe identities", async () => {
    const run = await runAgentCommand(["prepare", "--story", "demo-story", "--chapters", "3,1-2,1", "--stages", "translation", "--agent", "antigravity", "--model", "unknown"], root) as AgentRun;
    expect(run.input.chapters).toEqual([1, 2, 3]);
    await expect(plan(["tts"])).rejects.toThrow();
    await expect(prepareAgentRun(root, { story: "../private", chapters: [1], stages: ["translation"], agent: "codex", model: "unknown" })).rejects.toThrow();
  });
});
