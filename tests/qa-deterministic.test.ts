import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storySchema } from "../src/domain/story.js";
import { emptyStoryBible, storyBibleSchema } from "../src/domain/story-bible.js";
import { runDeterministicQaChecks } from "../src/qa/deterministic.js";
import { addQaException, exceptionsPromptSection, filterExceptedFindings, listQaExceptions, removeQaException } from "../src/qa/exceptions.js";
import { buildQaState } from "../src/qa/review.js";
import { qaModeInstructionsFor } from "../src/qa/prompts.js";
import { validateChapterQuality } from "../src/qa/validator.js";
import { continuityReviewSchema } from "../src/story-bible/continuity.js";
import { atomicWriteJson } from "../src/storage/atomic-write.js";
import { storyPaths } from "../src/storage/paths.js";
import { MockLLM, testStory } from "./helpers.js";

const NOW = "2026-09-16T12:00:00.000Z";
const entity = (overrides: Record<string, unknown>) => ({
  id: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", type: "character", canonicalName: "Su Ming", originalName: "苏明", aliases: [] as string[],
  firstAppearance: 1, lastKnownAppearance: 3, status: "alive", ...overrides,
});

async function setup(root: string, options: { entities?: Record<string, unknown>[]; continuity?: unknown } = {}) {
  const story = testStory();
  const paths = storyPaths(root, story.slug, 1);
  if (options.entities) await atomicWriteJson(paths.bible, storyBibleSchema.parse({ ...emptyStoryBible(), canonicalEntities: options.entities.map(entity) }));
  if (options.continuity) await atomicWriteJson(paths.continuityReview, options.continuity);
  return { story, paths };
}

const run = (root: string, story: ReturnType<typeof testStory>, narration: string, translation = "Translation text.") =>
  runDeterministicQaChecks({ root, story, chapter: 1, source: "源文", translation, narration });

describe("deterministic naming checks", () => {
  it("flags a missing preferred narration name and marks unambiguous single-token substitutions safe to fix", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-det-"));
    const { story } = await setup(root, { entities: [entity({ canonicalName: "Suming", originalName: "", preferredNarrationName: "Asher" })] });
    const { detections } = await run(root, story, "Suming opened the door and left.");
    const finding = detections.find((detection) => detection.category === "names")!;
    expect(finding.message).toContain('"Suming"');
    expect(finding.message).toContain('"Asher"');
    expect(finding).toMatchObject({ origin: "deterministic", safeToFix: true, entityIds: ["ent_aaaaaaaaaaaaaaaaaaaaaaaa"] });
  });

  it("does not flag multi-token substitutions as safe to fix, and passes when the preferred name is used", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-det-"));
    const { story } = await setup(root, { entities: [entity({ originalName: "", preferredNarrationName: "Asher Voss" })] });
    const flagged = await run(root, story, "Su Ming opened the door.");
    const finding = flagged.detections.find((detection) => detection.category === "names")!;
    expect(finding.safeToFix).toBe(false);
    const clean = await run(root, story, "Asher Voss opened the door.");
    expect(clean.detections.filter((detection) => detection.category === "names")).toEqual([]);
  });

  it("flags custom alias rule violations but never no_override or ai_contextual naming", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-det-"));
    const { story } = await setup(root, { entities: [
      entity({ originalName: "", aliases: ["Ming"], preferredNarrationName: "Asher", aliasNarrationRules: [{ alias: "Ming", behavior: "custom", replacement: "Ash" }] }),
      entity({ id: "ent_bbbbbbbbbbbbbbbbbbbbbbbb", canonicalName: "Lian", originalName: "", aliases: ["Lia"], aliasNarrationRules: [{ alias: "Lia", behavior: "no_override" }] }),
      entity({ id: "ent_cccccccccccccccccccccccc", canonicalName: "Rhea", originalName: "", localizedNaming: { locale: "en-US", fullName: "Rhea Voss", shortName: "Rhea", usageMode: "ai_contextual" } }),
    ] });
    const { detections } = await run(root, story, "Ming and Lia followed Rhea inside.");
    const names = detections.filter((detection) => detection.category === "names");
    expect(names).toHaveLength(1);
    expect(names[0]!.message).toContain('"Ming"');
    expect(names[0]!.message).toContain('"Ash"');
    expect(names[0]!.safeToFix).toBe(false);
  });
});

describe("deterministic duplication checks", () => {
  it("flags a verbatim repeated paragraph in narration and translation", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-det-"));
    const { story } = await setup(root);
    const { detections } = await run(root, story, "The lantern burns low tonight.\n\nA wind rises.\n\nThe lantern burns low tonight.", "First line of translation.\n\nFirst line of translation.");
    const duplicates = detections.filter((detection) => detection.category === "completeness");
    expect(duplicates).toHaveLength(2);
    expect(duplicates.map((detection) => detection.safeToFix)).toEqual([false, false]);
    expect(duplicates.some((detection) => detection.message.includes("narration"))).toBe(true);
    expect(duplicates.some((detection) => detection.message.includes("translation"))).toBe(true);
  });
});

describe("deterministic speech-readiness checks", () => {
  it("never flags a covered token (23:57 with default settings)", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-det-"));
    const { story } = await setup(root);
    const { detections } = await run(root, story, "The shift changes at 23:57, right after the 50% bonus ends.");
    expect(detections.filter((detection) => detection.category === "narrationFidelity")).toEqual([]);
  });

  it("flags an uncovered abbreviation token", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-det-"));
    const { story } = await setup(root);
    const { detections } = await run(root, story, "The QTE event caught him off guard.");
    const finding = detections.find((detection) => detection.category === "narrationFidelity")!;
    expect(finding.message).toContain('"QTE"');
    expect(finding).toMatchObject({ origin: "deterministic", safeToFix: false });
  });
});

describe("deterministic pronunciation checks", () => {
  it("flags needsReview pronunciation and missing pronunciation for foreign-named spoken entities", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-det-"));
    const { story } = await setup(root, { entities: [
      entity({ pronunciation: { mode: "automatic", needsReview: true } }),
      entity({ id: "ent_dddddddddddddddddddddddd", canonicalName: "Kael", originalName: "凯尔" }),
      entity({ id: "ent_eeeeeeeeeeeeeeeeeeeeeeee", canonicalName: "Bone Cage", originalName: "" }),
    ] });
    const { detections } = await run(root, story, "Su Ming and Kael entered the Bone Cage.");
    const findings = detections.filter((detection) => detection.category === "names");
    expect(findings).toHaveLength(2);
    expect(findings.find((detection) => detection.entityIds?.[0] === "ent_aaaaaaaaaaaaaaaaaaaaaaaa")!.message).toContain("needsReview");
    expect(findings.find((detection) => detection.entityIds?.[0] === "ent_dddddddddddddddddddddddd")!.message).toContain("no pronunciation guidance");
    // Ordinary translated English terms need no pronunciation record.
    expect(findings.some((detection) => detection.entityIds?.[0] === "ent_eeeeeeeeeeeeeeeeeeeeeeee")).toBe(false);
  });
});

describe("continuity consumption", () => {
  const continuityFinding = (status: string) => continuityReviewSchema.parse({
    version: 1, analyzedThroughChapter: 3, inputFingerprint: "fp", updatedAt: NOW,
    findings: [{
      id: "ctf_aaaaaaaaaaaaaaaaaaaaaaaa", type: "status_conflict", severity: "critical", entityIds: ["ent_aaaaaaaaaaaaaaaaaaaaaaaa"], chapters: [2, 3],
      explanation: "Su Ming appears after being recorded dead without an intervening resurrection.",
      supportingFacts: [{ entityId: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", chapter: 2, summary: "Su Ming dies.", provenanceKind: "extraction" }],
      evidenceFingerprint: "fp", status,
    }],
  });

  it("loads intentional/accepted_new continuity findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-det-"));
    const { story } = await setup(root, { continuity: continuityFinding("intentional") });
    const { acceptedContinuity } = await run(root, story, "Su Ming walked in.");
    expect(acceptedContinuity).toEqual([{ id: "ctf_aaaaaaaaaaaaaaaaaaaaaaaa", entityIds: ["ent_aaaaaaaaaaaaaaaaaaaaaaaa"], explanation: expect.stringContaining("recorded dead") }]);
  });

  it("suppresses a new LLM storyConsistency finding duplicating an intentional continuity decision", () => {
    const acceptedContinuity = [{ id: "ctf_aaaaaaaaaaaaaaaaaaaaaaaa", entityIds: ["ent_aaaaaaaaaaaaaaaaaaaaaaaa"], explanation: "Su Ming appears after death, which is intentional." }];
    const duplicate = { category: "storyConsistency" as const, severity: "fail" as const, message: "Su Ming appears in chapter 3 after dying in chapter 2.", evidence: "Narration: Su Ming walked in. Bible: recorded dead." };
    const entities = storyBibleSchema.parse({ ...emptyStoryBible(), canonicalEntities: [entity({})] }).canonicalEntities;
    const suppressed = buildQaState(undefined, [duplicate], { chapter: 3, canonicalEntities: entities, translation: "T", narration: "Su Ming walked in.", now: NOW, acceptedContinuity });
    expect(suppressed.state.findings).toEqual([]);
    const unrelated = { ...duplicate, message: "The faction's name changed between chapters.", evidence: "Iron Hall became Bronze Hall." };
    const kept = buildQaState(undefined, [unrelated], { chapter: 3, canonicalEntities: entities, translation: "T", narration: "N", now: NOW, acceptedContinuity });
    expect(kept.state.findings).toHaveLength(1);
    expect(kept.state.findings[0]!.status).toBe("open");
  });
});

describe("QA exceptions", () => {
  it("round-trips add/list/remove with stable content-derived ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "qa-exc-"));
    const story = testStory();
    const added = await addQaException(root, story.slug, { category: "terminology", matchKind: "terminology", value: "Bone Cage", reason: "Author-approved term" });
    expect(added.created).toBe(true);
    expect(added.exception.id).toMatch(/^qax_[a-f0-9]{24}$/);
    expect((await addQaException(root, story.slug, { category: "terminology", matchKind: "terminology", value: "bone  cage" })).created).toBe(false);
    expect(await listQaExceptions(root, story.slug)).toHaveLength(1);
    const removed = await removeQaException(root, story.slug, added.exception.id);
    expect(removed.removed).toBe(true);
    expect(await listQaExceptions(root, story.slug)).toEqual([]);
    expect((await removeQaException(root, story.slug, added.exception.id)).removed).toBe(false);
  });

  it("suppresses only detections matching an exception", () => {
    const exception = { id: "qax_aaaaaaaaaaaaaaaaaaaaaaaa", category: "terminology" as const, matchKind: "terminology" as const, value: "Bone Cage", createdAt: NOW };
    const detections = [
      { category: "terminology" as const, severity: "warn" as const, message: "The term Bone Cage drifts.", evidence: "Bone Prison is used instead of Bone Cage." },
      { category: "terminology" as const, severity: "warn" as const, message: "Azure Flame is inconsistent.", evidence: "Azure Flame vs Blue Flame." },
      { category: "names" as const, severity: "warn" as const, message: "Bone Cage renamed.", evidence: "Bone Cage became Bone Prison." },
    ];
    const filtered = filterExceptedFindings(detections, [exception]);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((detection) => detection.message)).toEqual(["Azure Flame is inconsistent.", "Bone Cage renamed."]);
  });

  it("matches entity exceptions by detection entity ids", () => {
    const exception = { id: "qax_bbbbbbbbbbbbbbbbbbbbbbbb", category: "names" as const, matchKind: "entity" as const, value: "ent_aaaaaaaaaaaaaaaaaaaaaaaa", createdAt: NOW };
    const detections = [{ category: "names" as const, severity: "warn" as const, message: "Unrelated wording.", evidence: "No overlap here.", entityIds: ["ent_aaaaaaaaaaaaaaaaaaaaaaaa"] }];
    expect(filterExceptedFindings(detections, [exception])).toEqual([]);
  });

  it("renders a prompt section only when exceptions exist", () => {
    expect(exceptionsPromptSection([])).toBeUndefined();
    const section = exceptionsPromptSection([{ id: "qax_aaaaaaaaaaaaaaaaaaaaaaaa", category: "terminology", matchKind: "rule", value: "Bone Cage", reason: "Approved", createdAt: NOW }])!;
    expect(section).toContain("APPROVED QA EXCEPTIONS");
    expect(section).toContain('"Bone Cage"');
    expect(section).toContain("Approved");
  });
});

describe("QA mode", () => {
  it("parses a story.json without qaMode as production", () => {
    const { qaMode, ...legacy } = testStory();
    expect(storySchema.parse(legacy).qaMode).toBe("production");
    expect(testStory().qaMode).toBe("production");
  });

  it("adds style instructions in thorough mode and forbids them in production mode", async () => {
    expect(qaModeInstructionsFor("thorough")).toContain("THOROUGH MODE");
    expect(qaModeInstructionsFor("thorough")).toContain("awkward phrasing");
    expect(qaModeInstructionsFor("production")).toContain("PRODUCTION MODE");
    expect(qaModeInstructionsFor("production")).not.toContain("awkward phrasing");
    const input = { chapter: 1, sourceLanguage: "zh-CN", outputLanguage: "en-US", source: "源文", translation: "Translation", narration: "Narration", context: emptyStoryBible() };
    const thorough = new MockLLM("openai");
    await validateChapterQuality(thorough, { provider: "openai", model: "qa-model" }, { ...input, mode: "thorough" });
    expect(String(thorough.calls[0] && (thorough.calls[0] as { instructions?: string }).instructions)).toContain("THOROUGH MODE");
    const production = new MockLLM("openai");
    await validateChapterQuality(production, { provider: "openai", model: "qa-model" }, { ...input, mode: "production" });
    expect(String((production.calls[0] as { instructions?: string }).instructions)).toContain("PRODUCTION MODE");
  });

  it("persists the mode used into the QA state", () => {
    const { state } = buildQaState(undefined, [], { chapter: 1, translation: "T", narration: "N", now: NOW, mode: "thorough" });
    expect(state.mode).toBe("thorough");
    const again = buildQaState(state, [], { chapter: 1, translation: "T", narration: "N", now: NOW });
    expect(again.state.mode).toBe("thorough");
  });
});
