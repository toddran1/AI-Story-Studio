import { Story } from "../domain/story.js";
import { CanonicalEntity, hasActivePronunciation } from "../domain/story-bible.js";
import { continuityReviewSchema } from "../story-bible/continuity.js";
import { loadNarrationNamingEntities } from "../story-bible/narration-names.js";
import { loadPronunciationEntities } from "../story-bible/pronunciation.js";
import { normalizeSpeechText, speechNormalizationSettingsFromNarration } from "../tts/speech-normalization.js";
import { detectVocalizations } from "../tts/vocalizations.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { storyPaths } from "../storage/paths.js";
import { normalizeQaText } from "./findings.js";
import { QaPrerequisiteError } from "./errors.js";
import type { FreshQaDetection } from "./review.js";
import { authorizedNarrationNames } from "../narration/naming-preferences.js";

export type AcceptedContinuity = { id: string; entityIds: string[]; explanation: string };
export type DeterministicQaResult = { detections: FreshQaDetection[]; acceptedContinuity: AcceptedContinuity[] };

function containsName(text: string, name: string): boolean {
  if (!name.trim()) return false;
  if (!/^[a-z0-9][a-z0-9 .'-]*$/i.test(name)) return text.includes(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(text);
}

function nameOccurrences(text: string, name: string): Array<{ start: number; end: number }> {
  if (!name.trim()) return [];
  const pattern = /^[a-z0-9][a-z0-9 .'-]*$/i.test(name)
    ? new RegExp(`(?<![a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "gi")
    : new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu");
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
}

function hasUnauthorizedOccurrence(text: string, written: string, authorized: string[]): boolean {
  const allowedSpans = authorized.flatMap((name) => nameOccurrences(text, name));
  return nameOccurrences(text, written).some((occurrence) => !allowedSpans.some((allowed) => allowed.start <= occurrence.start && allowed.end >= occurrence.end));
}

/** Confirmed violations of explicit narration-facing naming rules. */
function namingDetections(entities: CanonicalEntity[], translation: string, narration: string): FreshQaDetection[] {
  const detections: FreshQaDetection[] = [];
  const emitted = new Set<string>();
  const flag = (entity: CanonicalEntity, written: string, required: string | string[], reason: string, safeToFix: boolean) => {
    const forms = Array.isArray(required) ? required : [required];
    const key = `${entity.id}\0${normalizeQaText(written)}\0${forms.map(normalizeQaText).join("|")}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    const translatedIdentity = [entity.canonicalName, entity.originalName, ...entity.aliases].find((name) => name && containsName(translation, name));
    const translationEvidence = translatedIdentity ?? translation.slice(0, 120);
    const requiredText = forms.map((form) => `"${form}"`).join(" or ");
    detections.push({
      category: "names", severity: "fail", origin: "deterministic", safeToFix, entityIds: [entity.id],
      message: `The fault lies in the NARRATION: it uses "${written}" instead of ${forms.length > 1 ? "an authorized localized form" : "the required"} ${requiredText} under the ${reason} rule.`,
      evidence: `Translation: "${translationEvidence}". Narration: "${written}". Authorized narration rendering: ${requiredText} (${reason}).`,
    });
  };
  for (const entity of entities) {
    const naming = entity.localizedNaming;
    const noOverrideNames = new Set(entity.aliasNarrationRules.filter((rule) => rule.behavior === "no_override").map((rule) => normalizeQaText(rule.alias)));
    const identityForms = [entity.canonicalName, entity.originalName, naming?.fullName ?? "", naming?.shortName ?? ""]
      .filter((name) => name.trim() && !noOverrideNames.has(normalizeQaText(name)));

    // Contextual localization permits either configured full or short form, but
    // it does not permit the unrelated canonical/source name in narration.
    // Manual mode can authorize additional forms through editorial notes, so
    // only that mode remains exempt from deterministic enforcement.
    if (naming?.usageMode !== "manual") {
      for (const written of identityForms) {
        const authorized = authorizedNarrationNames(entity, written);
        const required = authorized[0];
        if (!required || normalizeQaText(written) === normalizeQaText(required)) continue;
        if (hasUnauthorizedOccurrence(narration, written, authorized)) {
          const safe = !naming && entity.preferredNarrationName === required && !required.includes(" ") && !written.includes(" ");
          flag(entity, written, naming?.usageMode === "ai_contextual" ? authorized : required, naming ? `localizedNaming ${naming.usageMode}` : "Preferred Narration Name", safe);
        }
      }
    }

    // Ordinary aliases follow the configured preferred/deterministic localized
    // name, while alias-specific rules override that behavior.
    for (const alias of entity.aliases) {
      const rule = entity.aliasNarrationRules.find((candidate) => normalizeQaText(candidate.alias) === normalizeQaText(alias));
      if (rule?.behavior === "no_override") continue;
      if (naming?.usageMode === "manual" && rule?.behavior !== "custom") continue;
      const authorized = authorizedNarrationNames(entity, alias);
      const required = rule?.behavior === "custom" ? rule.replacement : authorized[0];
      if (!required || normalizeQaText(alias) === normalizeQaText(required)) continue;
      if (hasUnauthorizedOccurrence(narration, alias, authorized)) {
        const reason = rule?.behavior === "custom" ? "custom alias rule" : rule?.behavior === "use_preferred" ? "use_preferred alias rule" : naming ? `localizedNaming ${naming.usageMode}` : "Preferred Narration Name";
        flag(entity, alias, naming?.usageMode === "ai_contextual" && rule?.behavior !== "custom" ? authorized : required, reason, false);
      }
    }
  }
  return detections;
}

const MIN_DUPLICATE_LENGTH = 12;

function duplicateParagraphDetections(translation: string, narration: string): FreshQaDetection[] {
  const detections: FreshQaDetection[] = [];
  const scan = (artifact: "translation" | "narration", text: string) => {
    const paragraphs = text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
    const seen = new Map<string, number>();
    paragraphs.forEach((paragraph, index) => {
      const key = normalizeQaText(paragraph);
      if (key.length < MIN_DUPLICATE_LENGTH) return;
      const first = seen.get(key);
      if (first === undefined) { seen.set(key, index); return; }
      detections.push({
        category: "completeness", severity: "warn", origin: "deterministic", safeToFix: false,
        ruleKey: `completeness:duplicate-paragraph:${key.slice(0, 48)}`,
        message: `The ${artifact} repeats a paragraph verbatim (paragraphs ${first + 1} and ${index + 1}); this is usually a duplication defect.`,
        evidence: `Paragraph ${index + 1} duplicates paragraph ${first + 1}: "${paragraph.slice(0, 160)}${paragraph.length > 160 ? "…" : ""}"`,
      });
    });
  };
  scan("translation", translation);
  scan("narration", narration);
  return detections;
}

const SPEECH_TOKEN_PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: "time", pattern: /(?<![\p{L}\p{N}])(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[AaPp]\.?\s*[Mm]\.)?(?![\p{L}\p{N}])/gu },
  { kind: "percentage", pattern: /(?<![\p{L}\p{N}])\d+(?:\.\d+)?%(?![\p{L}\p{N}])/gu },
  { kind: "currency", pattern: /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?![\d.])/g },
  { kind: "abbreviation", pattern: /(?<![\p{L}\p{N}])[A-Z][A-Z0-9]{1,9}(?![\p{L}\p{N}])/gu },
];

/** Narration tokens a TTS engine will read aloud but speech normalization does not cover. */
function speechReadinessDetections(story: Story, narration: string): FreshQaDetection[] {
  // QA runs provider-neutrally: the safe_normalize fallback is the baseline, so a
  // provider with native tags can only do better than what is checked here.
  const speechSettings = speechNormalizationSettingsFromNarration(story.narrationSettings);
  const normalized = normalizeSpeechText(narration, story.outputLanguage, speechSettings);
  const covered = new Set(normalized.transformations.map((transformation) => transformation.written));
  const flagged = new Map<string, string>();
  for (const { kind, pattern } of SPEECH_TOKEN_PATTERNS) {
    for (const match of narration.matchAll(pattern)) {
      const written = match[0];
      // Covered tokens are already rewritten for speech: never flag them.
      if (covered.has(written) || flagged.has(written)) continue;
      flagged.set(written, kind);
    }
  }
  const detections: FreshQaDetection[] = [...flagged].map(([written, kind]) => ({
    category: "narrationFidelity" as const, severity: "warn" as const, origin: "deterministic" as const, safeToFix: false,
    ruleKey: `narrationFidelity:speech:${kind}:${written}`,
    message: `Narration contains the ${kind} "${written}", which speech normalization does not rewrite; the TTS engine may read it unnaturally.`,
    evidence: `"${written}" appears in the narration without a speech-normalization transformation.`,
  }));
  const vocalizationTransformations = normalized.transformations.filter((transformation) => transformation.kind === "vocalization");
  // A recorded transformation under active automatic handling means normalization
  // consciously rendered the vocalization (its canonical spoken form can equal the
  // written form — that is still synthesis-safe). Preserve/disabled handling and
  // the preserve fallback leave the text to the provider blind, so those stay suspicious.
  const vocalizationHandlingActive = (speechSettings.vocalizations?.mode ?? "automatic") === "automatic"
    && (speechSettings.vocalizations?.fallback ?? "safe_normalize") !== "preserve";
  const unhandled = new Map<string, string>();
  for (const vocalization of detectVocalizations(narration)) {
    if (unhandled.has(vocalization.sourceText)) continue;
    const handled = vocalizationHandlingActive
      && vocalizationTransformations.some((transformation) => transformation.written.includes(vocalization.sourceText));
    if (!handled) unhandled.set(vocalization.sourceText, vocalization.vocalization);
  }
  for (const [written, kind] of unhandled) {
    detections.push({
      category: "narrationFidelity", severity: "warn", origin: "deterministic", safeToFix: false,
      ruleKey: `narrationFidelity:vocalization:${kind}:${written}`,
      message: `TTS vocalization may synthesize unnaturally: the ${kind} "${written}" is left in the spoken text unchanged.`,
      evidence: `"${written}" appears in the narration without a speech-normalization rewrite.`,
      suggestedFix: `Enable automatic vocalization handling with the safe_normalize fallback, or accept the literal "${written}" rendering.`,
    });
  }
  return detections;
}

/**
 * Pronunciation QA applies only to active, user-configured pronunciations.
 * No record, an AI suggestion, or an unaccepted analysis means default TTS —
 * a valid state that never produces a finding.
 */
function pronunciationDetections(entities: CanonicalEntity[], narration: string): FreshQaDetection[] {
  const detections: FreshQaDetection[] = [];
  for (const entity of entities) {
    const pronunciation = entity.pronunciation;
    if (!hasActivePronunciation(pronunciation)) continue;
    const names = [entity.canonicalName, entity.originalName, ...entity.aliases, entity.preferredNarrationName ?? "", entity.localizedNaming?.fullName ?? "", entity.localizedNaming?.shortName ?? ""];
    if (!names.some((name) => containsName(narration, name))) continue;
    if (pronunciation!.mode === "custom" && !pronunciation!.customPronunciation) {
      detections.push({
        category: "names", severity: "warn", origin: "deterministic", safeToFix: false, entityIds: [entity.id],
        ruleKey: `names:pronunciation-invalid:${entity.id}`,
        message: `The custom pronunciation for ${entity.canonicalName} (${entity.id}) has no spoken form; TTS cannot apply it.`,
        evidence: `Narration names ${entity.canonicalName}; the active custom pronunciation lacks customPronunciation.`,
      });
    } else if (pronunciation!.needsReview) {
      detections.push({
        category: "names", severity: "warn", origin: "deterministic", safeToFix: false, entityIds: [entity.id],
        ruleKey: `names:pronunciation-review:${entity.id}`,
        message: `The pronunciation for ${entity.canonicalName} (${entity.id}) is marked needsReview; confirm it before producing audio for this chapter.`,
        evidence: `Narration names ${entity.canonicalName}; pronunciation mode "${pronunciation!.mode}" has needsReview=true.`,
      });
    }
  }
  return detections;
}

export async function loadAcceptedContinuity(root: string, slug: string): Promise<AcceptedContinuity[]> {
  const path = storyPaths(root, slug, 1).continuityReview;
  let raw: unknown;
  try { raw = await readJsonIfExists(path); }
  catch { throw new QaPrerequisiteError("QA_CONTINUITY_INVALID", "QA could not load the current Continuity Review safely. Repair or rerun Continuity Review before rechecking this chapter.", { path }); }
  if (!raw) return [];
  const parsed = continuityReviewSchema.safeParse(raw);
  if (!parsed.success) throw new QaPrerequisiteError("QA_CONTINUITY_INVALID", "QA could not load the current Continuity Review safely because it does not match the expected schema. Repair or rerun Continuity Review before rechecking this chapter.", { path });
  return parsed.data.findings
    .filter((finding) => finding.status === "intentional" || finding.status === "accepted_new")
    .map((finding) => ({ id: finding.id, entityIds: finding.entityIds, explanation: finding.explanation }));
}

/**
 * Local, zero-cost QA checks. Each detection is deterministic given the same
 * inputs, so reconciliation matches them across runs by content-derived id.
 */
export async function runDeterministicQaChecks(deps: {
  root: string;
  story: Story;
  chapter: number;
  source: string;
  translation: string;
  narration: string;
}): Promise<DeterministicQaResult> {
  const { root, story, translation, narration } = deps;
  const [namingEntities, pronunciationEntities, acceptedContinuity] = await Promise.all([
    loadNarrationNamingEntities(root, story.slug),
    loadPronunciationEntities(root, story.slug),
    loadAcceptedContinuity(root, story.slug),
  ]);
  const detections: FreshQaDetection[] = [
    ...namingDetections(namingEntities, translation, narration),
    ...(story.qaPolicy.disabledRules.includes("duplicateParagraph") ? [] : duplicateParagraphDetections(translation, narration)),
    ...speechReadinessDetections(story, narration),
    ...pronunciationDetections(pronunciationEntities, narration),
  ];
  return { detections, acceptedContinuity };
}
