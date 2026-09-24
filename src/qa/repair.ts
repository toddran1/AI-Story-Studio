import { QaResult, QaState } from "../domain/qa.js";
import { CanonicalEntity, storyBibleSchema } from "../domain/story-bible.js";
import { StageModelConfig } from "../domain/provider.js";
import { LLMProvider } from "../llm/provider.js";
import { assertUsableTranslation } from "../translation/translator.js";
import type { NarrationProfanityMode } from "../domain/story.js";
import { softenStrongProfanity } from "../narration/profanity.js";
import { removeLeadingChapterTitle } from "../narration/narration-editor.js";
import { authorizedNarrationNaming } from "./prompts.js";
import type { QaFinding } from "../domain/qa.js";
import { findingFingerprint, normalizeQaText } from "./findings.js";
import { QaFindingStaleSelectionError, QaRepairTargetAmbiguousError } from "./errors.js";
import { fingerprint } from "../utils/hash.js";

export type QaRepairTextSnapshot = { translationTextFingerprint: string; narrationTextFingerprint: string };
export type QaRepairFindingSnapshot = { id: string; fingerprint: string } & Partial<QaRepairTextSnapshot>;
export type QaRepairTargetChoice = "translation" | "narration" | "both";

const staleTextMessage = "The chapter text changed after this QA repair was selected. Reload QA and review the current finding before retrying.";

/** Hash presence as well as content so missing and present-but-empty artifacts differ. */
function repairTextFingerprint(text: string | undefined) {
  return fingerprint(text === undefined ? { present: false } : { present: true, text });
}

export function captureQaRepairTextSnapshot(translation: string | undefined, narration: string | undefined): QaRepairTextSnapshot {
  return { translationTextFingerprint: repairTextFingerprint(translation), narrationTextFingerprint: repairTextFingerprint(narration) };
}

export function validateQaRepairTextSnapshot(snapshot: Partial<QaRepairTextSnapshot>, translation: string | undefined, narration: string | undefined) {
  const current = captureQaRepairTextSnapshot(translation, narration);
  if (!snapshot.translationTextFingerprint || !snapshot.narrationTextFingerprint
    || current.translationTextFingerprint !== snapshot.translationTextFingerprint || current.narrationTextFingerprint !== snapshot.narrationTextFingerprint) {
    throw new QaFindingStaleSelectionError(staleTextMessage);
  }
}

/** Re-key legacy index-based UI overrides onto the preflighted persistent finding identities. */
export function targetOverridesByFindingId(
  issueIndexes: number[],
  snapshots: QaRepairFindingSnapshot[],
  overrides: Record<string, QaRepairTargetChoice> | undefined,
): Record<string, QaRepairTargetChoice> {
  const result: Record<string, QaRepairTargetChoice> = {};
  for (const [position, index] of [...new Set(issueIndexes)].entries()) {
    const choice = overrides?.[String(index)];
    const snapshot = snapshots[position];
    if (choice && snapshot) result[snapshot.id] = choice;
  }
  return result;
}

/** Resolve legacy issue positions once, before a queued repair can wait on a lock. */
export function captureQaRepairFindingSnapshotsFromIssues(
  qaIssues: QaState["issues"],
  findings: QaFinding[],
  issueIndexes: number[],
): QaRepairFindingSnapshot[] {
  const indexes = [...new Set(issueIndexes)];
  if (!indexes.length) throw new QaFindingStaleSelectionError("Select one or more current QA findings, then retry.");
  return indexes.map((index) => {
    const issue = Number.isSafeInteger(index) && index >= 0 ? qaIssues[index] : undefined;
    if (!issue) throw new QaFindingStaleSelectionError("One or more selected QA findings no longer exist. Reload QA and select the current findings again.");
    const matches = findings.filter((finding) => finding.category === issue.category
      && finding.severity === issue.severity
      && finding.message === issue.message
      && finding.evidence === issue.evidence);
    if (matches.length !== 1) {
      throw new QaFindingStaleSelectionError("The selected QA finding can no longer be mapped safely to the current QA state. Reload QA and select the current finding again.");
    }
    const finding = matches[0]!;
    if (finding.status !== "open") {
      throw new QaFindingStaleSelectionError("One or more selected QA findings are no longer open. Reload QA and select the current findings again.");
    }
    return { id: finding.id, fingerprint: finding.fingerprint };
  });
}

/** Revalidate identity and open status after the queued job acquires the story lock. */
export function validateQaRepairFindingSnapshots(state: QaState, snapshots: QaRepairFindingSnapshot[]): QaFinding[] {
  const ids = new Set<string>();
  const findings: QaFinding[] = [];
  for (const snapshot of snapshots) {
    if (ids.has(snapshot.id)) continue;
    ids.add(snapshot.id);
    const finding = state.findings.find((item) => item.id === snapshot.id);
    if (!finding || finding.status !== "open" || finding.fingerprint !== snapshot.fingerprint) throw new QaFindingStaleSelectionError();
    findings.push(finding);
  }
  if (!findings.length) throw new QaFindingStaleSelectionError();
  return findings;
}

export function selectRepairStage(qa: QaResult): "translation" | "narration" {
  const translationCategories = new Set(["completeness", "names", "numbers", "terminology", "dialogue"]);
  return qa.issues.some((issue) => translationCategories.has(issue.category)) ? "translation" : "narration";
}

export type QaRepairTarget = "translation" | "narration";

export type QaRepairInference = { targets: QaRepairTarget[]; confidence: "high" | "medium" | "ambiguous"; reason: string };

/** Infer the artifact(s) supported by finding evidence; never guess translation by default. */
export function inferQaRepairTargets(finding: Pick<QaFinding, "category" | "message" | "evidence" | "provenance" | "origin">, texts: { translation: string; narration: string }): QaRepairInference {
  const description = `${finding.message}\n${finding.evidence}`;
  if (finding.category === "narrationFidelity") return { targets: ["narration"], confidence: "high", reason: "Narration Fidelity findings belong to the narration artifact." };
  if (/both (?:the )?translation and narration/i.test(description)) return { targets: ["translation", "narration"], confidence: "high", reason: "The finding explicitly identifies both artifacts." };
  if (finding.provenance?.stage === "translation" || finding.provenance?.stage === "narration") return { targets: [finding.provenance.stage], confidence: "high", reason: `Finding provenance identifies ${finding.provenance.stage}.` };
  if (/\btranslation\s+(?:contains|repeats|uses|adds|omits|changes)\b/i.test(description) && !/\bnarration\s+(?:contains|repeats|uses|adds|omits|changes)\b/i.test(description)) return { targets: ["translation"], confidence: "high", reason: "The finding attributes the defect to translation." };
  if (/\bnarration\s+(?:contains|repeats|uses|adds|omits|changes)\b/i.test(description) && !/\btranslation\s+(?:contains|repeats|uses|adds|omits|changes)\b/i.test(description)) return { targets: ["narration"], confidence: "high", reason: "The finding attributes the defect to narration." };
  const quotedEvidence = [...finding.evidence.matchAll(/["“]([^"”]{8,})["”]/g)].map((match) => normalizeQaText(match[1]!));
  const snippets = [...quotedEvidence, normalizeQaText(finding.evidence)].filter((value) => value.length >= 16);
  const present = (text: string) => snippets.some((snippet) => normalizeQaText(text).includes(snippet));
  const inTranslation = present(texts.translation);
  const inNarration = present(texts.narration);
  if (inTranslation !== inNarration) {
    const target = inTranslation ? "translation" : "narration";
    return { targets: [target], confidence: "high", reason: `Finding evidence occurs only in ${target}.` };
  }
  if (finding.origin === "deterministic" && /duplicate paragraph/i.test(description)) {
    if (/\btranslation\b/i.test(description) && !/\bnarration\b/i.test(description)) return { targets: ["translation"], confidence: "high", reason: "Deterministic duplicate rule identifies translation." };
    if (/\bnarration\b/i.test(description) && !/\btranslation\b/i.test(description)) return { targets: ["narration"], confidence: "high", reason: "Deterministic duplicate rule identifies narration." };
  }
  return { targets: [], confidence: "ambiguous", reason: inTranslation && inNarration ? "The evidence appears in both artifacts but the finding does not specify which one is wrong." : "The finding does not identify a single repair artifact." };
}

export function repairTargets(issues: QaResult["issues"]): QaRepairTarget[] {
  const targets = new Set<QaRepairTarget>();
  for (const issue of issues) for (const target of issueRepairTargets(issue)) targets.add(target);
  // Translation must be repaired first because saving it invalidates narration.
  return (["translation", "narration"] as const).filter((target) => targets.has(target));
}

export function issueRepairTargets(issue: QaResult["issues"][number]): QaRepairTarget[] {
  const result = inferQaRepairTargets(issue as QaFinding, { translation: "", narration: "" });
  if (result.confidence === "ambiguous") throw new QaRepairTargetAmbiguousError(["translation", "narration", "both"]);
  return result.targets;
}

export async function repairQaText(provider: LLMProvider, config: StageModelConfig, input: {
  target: QaRepairTarget; chapter: number; sourceLanguage: string; outputLanguage: string; source: string;
  translation: string; narration: string; issues: QaResult["issues"]; context?: unknown; authorizedNarrationEntities?: CanonicalEntity[]; profanityMode?: NarrationProfanityMode; includeChapterTitle?: boolean;
}) {
  const current = input.target === "translation" ? input.translation : input.narration;
  if (!current.trim()) throw new Error(`Chapter ${input.chapter} has no ${input.target} to repair`);
  const contextBible = storyBibleSchema.safeParse(input.context ?? {});
  const namingEntities = input.authorizedNarrationEntities ?? (contextBible.success ? contextBible.data.canonicalEntities : []);
  const hasNamingOverrides = namingEntities.some((entity) => entity.localizedNaming || entity.preferredNarrationName || entity.aliasNarrationRules.length);
  const instructions = [
    `You are repairing a complete chapter ${input.target} after a quality review.`,
    "Return only the complete corrected text, with no preface, explanation, markdown fence, or change log.",
    "Preserve every unaffected detail, paragraph, event, number, proper name, and line of dialogue.",
    "Make the smallest changes necessary to resolve every supplied QA finding. Never shorten the chapter into a summary.",
    "If a supplied finding is wrong, already resolved, or contradicts the source, make no change for that finding rather than inventing changes.",
    "System panels, status windows, stat blocks, and game interfaces must remain verbatim, character for character; never fill in, estimate, round, or normalize numeric values.",
    input.target === "translation"
      ? `Keep the result faithful to the ${input.sourceLanguage} source and natural in ${input.outputLanguage}.`
      : `Keep the narration faithful to the approved ${input.outputLanguage} translation; do not introduce new story information.`,
    hasNamingOverrides
      ? `${authorizedNarrationNaming(namingEntities)} Repairs must never revert an authorized narration-name substitution back to the canonical name.`
      : "",
    input.target === "narration" && input.profanityMode === "soften-strong"
      ? "Honor the story's narration-only preference: replace strong profanity with natural milder wording while preserving hostility, emotion, intent, and meaning. Ass, hell, and damn are allowed."
      : "",
    input.target === "narration" && input.includeChapterTitle === false
      ? "The story omits chapter titles from narration. Return the complete narration body without a chapter heading or title."
      : "",
  ].join(" ");
  const result = await provider.generateText({
    model: config.model,
    instructions,
    input: [
      `CHAPTER: ${input.chapter}`,
      `SELECTED QA FINDINGS:\n${JSON.stringify(input.issues, null, 2)}`,
      `RELEVANT STORY CONTEXT:\n${JSON.stringify(input.context ?? {}, null, 2)}`,
      `ORIGINAL SOURCE:\n${input.source}`,
      `CURRENT TRANSLATION:\n${input.translation}`,
      `CURRENT NARRATION:\n${input.narration}`,
      `TEXT TO REPAIR (${input.target.toUpperCase()}):\n${current}`,
    ].join("\n\n"),
  });
  let text = softenStrongProfanity(stripFence(result.text), input.target === "narration" ? (input.profanityMode ?? "preserve") : "preserve");
  if (input.target === "narration" && input.includeChapterTitle === false) text = removeLeadingChapterTitle(text);
  validateRepair(text, current, input.target);
  return { ...result, text };
}

function stripFence(text: string) {
  const trimmed = text.trim();
  const fenced = /^```(?:text|markdown)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function validateRepair(text: string, current: string, target: QaRepairTarget) {
  if (!text) throw new Error(`AI returned an empty ${target} repair`);
  if (text === current.trim()) throw new Error(`AI returned an unchanged ${target} repair; no changes were saved. Review or dismiss the finding, or edit the text manually.`);
  if (target === "translation") assertUsableTranslation(text);
  const ratio = [...text].length / Math.max(1, [...current].length);
  if (ratio < 0.65 || ratio > 1.6) throw new Error(`AI ${target} repair changed the chapter length implausibly (${Math.round(ratio * 100)}% of the current text); no changes were saved`);
}
