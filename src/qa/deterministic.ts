import { Story } from "../domain/story.js";
import { CanonicalEntity } from "../domain/story-bible.js";
import { continuityReviewSchema } from "../story-bible/continuity.js";
import { loadNarrationNamingEntities } from "../story-bible/narration-names.js";
import { loadPronunciationEntities } from "../story-bible/pronunciation.js";
import { normalizeSpeechText, speechNormalizationSettingsFromNarration } from "../tts/speech-normalization.js";
import { detectVocalizations } from "../tts/vocalizations.js";
import { readJsonIfExists } from "../storage/story-files.js";
import { storyPaths } from "../storage/paths.js";
import { normalizeQaText } from "./findings.js";
import type { FreshQaDetection } from "./review.js";

export type AcceptedContinuity = { id: string; entityIds: string[]; explanation: string };
export type DeterministicQaResult = { detections: FreshQaDetection[]; acceptedContinuity: AcceptedContinuity[] };

function containsName(text: string, name: string): boolean {
  if (!name.trim()) return false;
  if (!/^[a-z0-9][a-z0-9 .'-]*$/i.test(name)) return text.includes(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(text);
}

/** Conservative required-rendering violations in narration only. */
function namingDetections(entities: CanonicalEntity[], narration: string): FreshQaDetection[] {
  const detections: FreshQaDetection[] = [];
  const flag = (entity: CanonicalEntity, written: string, required: string, reason: string, safeToFix: boolean) => {
    detections.push({
      category: "names", severity: "warn", origin: "deterministic", safeToFix, entityIds: [entity.id],
      message: `Narration uses "${written}" for ${entity.canonicalName}, but the authorized narration rendering is "${required}" (${reason}), which never appears in the narration.`,
      evidence: `Narration contains "${written}" but never "${required}".`,
    });
  };
  for (const entity of entities) {
    const naming = entity.localizedNaming;
    // ai_contextual and manual localized naming are model-contextual by design;
    // deterministic checks must never second-guess them.
    const contextualNaming = naming && (naming.usageMode === "ai_contextual" || naming.usageMode === "manual");
    if (entity.preferredNarrationName && !contextualNaming) {
      const preferred = entity.preferredNarrationName;
      const identity = [entity.canonicalName, entity.originalName].filter((name) => name && normalizeQaText(name) !== normalizeQaText(preferred));
      const used = identity.find((name) => containsName(narration, name));
      if (used && !containsName(narration, preferred)) {
        const unambiguous = !preferred.includes(" ") && !used.includes(" ") && !naming;
        flag(entity, used, preferred, "Preferred Narration Name", unambiguous);
        continue;
      }
    }
    for (const rule of entity.aliasNarrationRules) {
      if (rule.behavior === "no_override") continue;
      const required = rule.behavior === "custom" ? rule.replacement : entity.preferredNarrationName;
      if (!required || !containsName(narration, rule.alias)) continue;
      if (normalizeQaText(rule.alias) === normalizeQaText(required)) continue;
      if (!containsName(narration, required)) flag(entity, rule.alias, required, rule.behavior === "custom" ? "custom alias rule" : "alias rule prefers the authorized narration name", false);
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
      message: `TTS vocalization may synthesize unnaturally: the ${kind} "${written}" is left in the spoken text unchanged.`,
      evidence: `"${written}" appears in the narration without a speech-normalization rewrite.`,
      suggestedFix: `Enable automatic vocalization handling with the safe_normalize fallback, or accept the literal "${written}" rendering.`,
    });
  }
  return detections;
}

/** Spoken entities whose pronunciation is missing (foreign-named) or needs review. */
function pronunciationDetections(entities: CanonicalEntity[], narration: string): FreshQaDetection[] {
  const detections: FreshQaDetection[] = [];
  for (const entity of entities) {
    const names = [entity.canonicalName, entity.originalName, ...entity.aliases, entity.preferredNarrationName ?? "", entity.localizedNaming?.fullName ?? "", entity.localizedNaming?.shortName ?? ""];
    if (!names.some((name) => containsName(narration, name))) continue;
    if (!entity.pronunciation) {
      // Ordinary translated English terms need no guidance; flag only entities
      // with a distinct original-language name actually spoken in narration.
      if (entity.originalName && normalizeQaText(entity.originalName) !== normalizeQaText(entity.canonicalName)) {
        detections.push({
          category: "names", severity: "warn", origin: "deterministic", safeToFix: false, entityIds: [entity.id],
          message: `${entity.canonicalName} (${entity.id}) is spoken in the narration but has no pronunciation guidance; TTS will guess at "${entity.canonicalName}".`,
          evidence: `Narration names ${entity.canonicalName}; the entity has original name "${entity.originalName}" and no pronunciation record.`,
        });
      }
    } else if (entity.pronunciation.needsReview) {
      detections.push({
        category: "names", severity: "warn", origin: "deterministic", safeToFix: false, entityIds: [entity.id],
        message: `The pronunciation for ${entity.canonicalName} (${entity.id}) is marked needsReview; confirm it before producing audio for this chapter.`,
        evidence: `Narration names ${entity.canonicalName}; pronunciation mode "${entity.pronunciation.mode}" has needsReview=true.`,
      });
    }
  }
  return detections;
}

async function loadAcceptedContinuity(root: string, slug: string): Promise<AcceptedContinuity[]> {
  const raw = await readJsonIfExists(storyPaths(root, slug, 1).continuityReview);
  if (!raw) return [];
  const parsed = continuityReviewSchema.safeParse(raw);
  if (!parsed.success) return [];
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
    ...namingDetections(namingEntities, narration),
    ...duplicateParagraphDetections(translation, narration),
    ...speechReadinessDetections(story, narration),
    ...pronunciationDetections(pronunciationEntities, narration),
  ];
  return { detections, acceptedContinuity };
}
