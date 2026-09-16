import type { NarrationProfanityMode } from "../domain/story.js";
import type { StoryBible } from "../domain/story-bible.js";

export const QA_PROMPT_VERSION = "6";

export const qaInstructions = `Act as a strict bilingual fiction quality-control editor. Compare the complete source, translation, and narration against the established Story Bible context. Detect substantial omissions or shortening; inconsistent names, places, abilities, factions, classes, ranks, items, and system terms; changed numeric facts; dropped dialogue or merged speaker turns; terminology drift; contradictions with established facts; and narration edits that alter plot, facts, relationships, point of view, or dialogue meaning. Judge omissions against a length tolerance: light condensation of a few percent is normal narration polish; report omissions only when whole sentences, lines of dialogue, events, or facts are missing, or when the narration loses materially more content than the translation (for example more than roughly ten percent).

DIALOGUE AND FORMATTING TOLERANCE: Evaluate speech content, speaker attribution, sequence, and meaningful pauses rather than matching visual line breaks, paragraph counts, or quotation-block counts. Consecutive lines from the same speaker may be regrouped into one quotation or paragraph, and speech may be attached to its attribution sentence, when every utterance retains its meaning and order and no intervening action, speaker change, or deliberate interruption is lost. These harmless presentation changes are authorized audiobook polish: do not report them as dialogue, narrationFidelity, completeness, or formatting issues, do not lower the score for them, and do not label them warn or fail. For example, the same speaker's separate quotations "Cut the crap! The earlier we leave, the earlier we finish!" and "If we leave too late, I'm afraid we'll run into unnecessary trouble!" may become one continuous quotation with both sentences intact. Similarly, the same speaker's "Didn't you say that with you around... there wouldn't be any issues?", "Why would there still be trouble?", and "Are you messing with me?" may form one quotation retaining all three questions. A different paragraph layout alone is not evidence of lost pacing or fidelity. Still flag dropped or materially changed speech, merged speaker turns that misattribute or obscure who is speaking, reordered exchanges, narration/action swallowed into dialogue, missing meaningful interruptions or pauses, unbalanced quotation marks, and punctuation damage that changes meaning or makes speech boundaries unclear. Use the source and surrounding context to verify speaker turns; do not infer different speakers solely from separate quotation blocks. Any formatting finding must identify the concrete reading, meaning, or speaker-boundary defect beyond cosmetic layout.

Honor the Story Bible's narration naming controls. A Preferred Narration Name or localizedNaming entry is an intentional, authorized narration-facing rendering of the same canonical entity. Original names, canonical names, and identity aliases may therefore appear as that authorized name in narration — including inside spoken dialogue, where the translation may still use the canonical name — without constituting a name, fidelity, consistency, or identity error. The AUTHORIZED NARRATION NAMING MAPPINGS section below is the authoritative list of these mappings; applying any of them is correct and must never be flagged, and per-alias narration behavior must be applied as configured. Do not flag an authorized preferred/custom name substitution by itself, whether it comes from a Preferred Narration Name, an alias rule, or localizedNaming. Still flag a genuinely wrong entity, a name that matches neither the translation nor an authorized mapping, inconsistent use of an authorized mapping, or a substitution that breaks a context-sensitive title, dialogue nickname, relationship term, pronoun, secret identity, or deliberate introduction.

Do not rewrite the chapter. Return only the requested structured assessment. OUTPUT CONTRACT: the checks object must contain a status for every category — completeness (omissions or shortening), names (people, places, factions), numbers (quantities, levels, dates, statistics), terminology (abilities, items, classes, ranks, system terms), dialogue (dropped or materially altered speech or broken speaker boundaries), storyConsistency (contradictions with the established Story Bible), and narrationFidelity (narration edits that alter the approved translation beyond authorized polish) — even when that category passes. score is a 0-1 quality estimate where 1.0 means no issues of any severity; lower it as findings accumulate. Severity rubric: use fail only for material factual loss or alteration that must block publication — for example dropped dialogue, merged speaker turns that change attribution, changed numbers or quantities, a wrong entity, a missing event, or a contradiction of an established fact; use warn for concrete minor defects or plausible-but-unconfirmed substantive concerns that merit review — for example meaningfully flattened tone, borderline terminology drift, or a detail you cannot fully verify. Authorized polish described above is neither a warning nor a failure. Use pass when no actionable concern remains. Every issue's message must state whether the fault lies in the TRANSLATION or the NARRATION; when both artifacts are at fault, say "both the translation and narration". Evidence must quote the exact wording from both the translation and the narration that demonstrates the problem.`;

export function qaInstructionsFor(profanityMode: NarrationProfanityMode = "preserve", includeChapterTitle = true) {
  const preferences = [
    profanityMode === "soften-strong" ? "The story has explicitly enabled narration-only strong-profanity softening. Do not flag a natural strong-to-mild wording substitution in narration — for example forms of “fuck,” “bitch,” “shit,” or “cunt” rendered as milder wording — as a fidelity or dialogue error when its hostility, emotion, intent, and meaning remain intact. Mild words such as “ass,” “hell,” and “damn” are permitted. Still flag missing dialogue, flattened meaning, or unrelated censorship. The source and translation are not covered by this preference." : "",
    !includeChapterTitle ? "The story has explicitly disabled chapter titles in narration. The source and translation must retain the title, but its omission from the narration alone is intentional and must not be reported as an omission or fidelity problem." : "",
  ].filter(Boolean);
  return preferences.length ? `${qaInstructions}\n\n${preferences.join("\n\n")}` : qaInstructions;
}

const usageModeDescription: Record<string, string> = {
  ai_contextual: "the narration chooses fullName for introductions, formal references, or ambiguity and shortName for established narration and familiar dialogue",
  always_full: "the fullName is used wherever the entity is named",
  always_short: "the shortName is used wherever the entity is named",
  manual: "the localizedNaming notes direct the narration-facing name",
};

/** Renders the explicit canonical-name → authorized narration-name mappings QA must treat as correct. */
export function authorizedNarrationNaming(context: StoryBible): string {
  const entities = context.canonicalEntities.filter((entity) => entity.localizedNaming || entity.preferredNarrationName || entity.aliasNarrationRules.length);
  if (!entities.length) {
    return "AUTHORIZED NARRATION NAMING MAPPINGS:\nNone. No entity has an authorized narration-name override, so narration must use the same names as the translation; any substitution is unauthorized and must be flagged.";
  }
  const lines = ["AUTHORIZED NARRATION NAMING MAPPINGS (authoritative; derived from the canonical Story Bible including manual overrides):"];
  for (const entity of entities) {
    const identity = [`canonical "${entity.canonicalName}"`];
    if (entity.originalName) identity.push(`original "${entity.originalName}"`);
    if (entity.aliases.length) identity.push(`aliases ${entity.aliases.map((alias) => `"${alias}"`).join(", ")}`);
    lines.push(`- Entity ${entity.id} (${entity.type}): identity names are ${identity.join("; ")}.`);
    if (entity.localizedNaming) {
      const naming = entity.localizedNaming;
      const names = [naming.fullName ? `fullName "${naming.fullName}"` : "", naming.shortName ? `shortName "${naming.shortName}"` : ""].filter(Boolean).join(", ");
      lines.push(`  Authorized narration rendering: localizedNaming for locale ${naming.locale} (${names}), usageMode "${naming.usageMode}" — ${usageModeDescription[naming.usageMode] ?? "as configured"}. This takes precedence over the Preferred Narration Name.${naming.notes ? ` Notes: ${naming.notes}` : ""}`);
    } else if (entity.preferredNarrationName) {
      lines.push(`  Authorized narration rendering: Preferred Narration Name "${entity.preferredNarrationName}" replaces the canonical name, original name, and ordinary aliases everywhere in narration, including inside spoken dialogue.`);
    }
    for (const rule of entity.aliasNarrationRules) {
      const behavior = rule.behavior === "no_override" ? "keeps normal contextual behavior (no forced replacement)" : rule.behavior === "custom" ? `is rendered as the custom phrase "${rule.replacement}"` : `is rendered as the authorized narration name`;
      lines.push(`  Alias rule: the alias "${rule.alias}" ${behavior}.`);
    }
    if (entity.canonicalNameLocked) lines.push(`  The canonical name is locked: the translation-facing identity name must remain "${entity.canonicalName}".`);
  }
  lines.push("Applying any of these authorized mappings — including inside dialogue — is CORRECT and must not be flagged as a name, fidelity, consistency, or identity problem. Flag only narration names that match neither the translation nor an authorized mapping, inconsistent application of a mapping, or a name attached to the wrong entity.");
  return lines.join("\n");
}
