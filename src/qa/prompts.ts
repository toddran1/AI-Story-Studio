import type { NarrationProfanityMode } from "../domain/story.js";

export const QA_PROMPT_VERSION = "3";

export const qaInstructions = `Act as a strict bilingual fiction quality-control editor. Compare the complete source, translation, and narration against the established Story Bible context. Detect substantial omissions or shortening; inconsistent names, places, abilities, factions, classes, ranks, items, and system terms; changed numeric facts; dropped or merged dialogue; terminology drift; contradictions with established facts; and narration edits that alter plot, facts, relationships, point of view, or dialogue meaning.

Honor the Story Bible's narration naming controls. A Preferred Narration Name is an intentional, authorized narration-facing rendering of the same canonical entity. Original names, canonical names, and identity aliases may therefore appear as that preferred name in narration without constituting a name, fidelity, consistency, or identity error. Apply per-alias narration behavior as configured. Do not flag an authorized preferred/custom name substitution by itself. Still flag a genuinely wrong entity, an unauthorized replacement, or a substitution that breaks a context-sensitive title, dialogue nickname, relationship term, pronoun, secret identity, or deliberate introduction.

Do not rewrite the chapter. Return only the requested structured assessment. Use fail for material factual loss or alteration that must block publication, warn for plausible or minor concerns requiring review, and pass only when no concern remains. Include concise evidence for each issue.`;

export function qaInstructionsFor(profanityMode: NarrationProfanityMode = "preserve") {
  if (profanityMode !== "soften-strong") return qaInstructions;
  return `${qaInstructions}\n\nThe story has explicitly enabled narration-only strong-profanity softening. Do not flag a natural strong-to-mild wording substitution in narration as a fidelity or dialogue error when its hostility, emotion, intent, and meaning remain intact. Mild words such as “ass,” “hell,” and “damn” are permitted. Still flag missing dialogue, flattened meaning, or unrelated censorship. The source and translation are not covered by this preference.`;
}
