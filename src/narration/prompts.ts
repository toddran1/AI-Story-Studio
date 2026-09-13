import { deliveryInstructions } from "./tts-direction.js";
import type { NarrationProfanityMode } from "../domain/story.js";

export const NARRATION_PROMPT_VERSION = "8";
export const narrationInstructions = (language: string, ttsProvider?: string, ttsModel?: string, profanityMode: NarrationProfanityMode = "preserve") => `Edit the supplied ${language} chapter into natural audiobook narration in ${language}. This is not a creative rewrite. Preserve every plot detail, fact, line of dialogue, name, ability, rank, point of view, tense, and chapter title. Do not summarize, omit, invent, or explain.${profanityMode === "soften-strong" ? " The sole authorized wording change is the narration profanity preference below." : " Do not censor."} Improve awkward phrasing, spoken rhythm, punctuation, and overly long sentences.

${profanityMode === "soften-strong" ? "NARRATION PROFANITY PREFERENCE: Soften strong profanity in this narration only. Replace harsh terms such as forms of “fuck,” “bitch,” “shit,” or “cunt” with natural milder wording appropriate to the sentence. Mild words such as “ass,” “hell,” and “damn” are allowed and should not be sanitized. Preserve the hostility, humor, emotion, dialogue intent, and plot meaning; do not omit lines, flatten the scene, or mention that wording was changed." : "NARRATION PROFANITY PREFERENCE: Preserve the source's level of profanity faithfully."}

System panels, status windows, stat blocks, and game interfaces (for example [Level: ...], [EXP: ...], attribute tables, skill descriptions, damage numbers) must be reproduced verbatim, character for character${profanityMode === "soften-strong" ? ", apart from the explicitly authorized strong-profanity substitutions" : ""}. Never fill in, estimate, round, normalize, or invent numeric values, and never alter quantities, totals, rates, or ranges anywhere in the chapter. If a value is blank, partial, or malformed in the source, keep it exactly as written.

Entity naming preferences are provided in the relevant Story Bible context. Aliases, original names, and the canonical name identify the same entity. When an entity has a Preferred Narration Name, use it as the default narration-facing name in place of the canonical/original name and ordinary aliases. Per-alias narration rules may explicitly preserve normal contextual behavior, select the preferred name, or require a custom phrase. This is an authorized narration rendering preference, not a factual identity change. Apply it consistently and naturally according to grammar and context; never perform blind literal replacement. Preserve dialogue-specific nicknames and vocatives, formal titles, honorifics, family or relationship terms, pronouns, possessives, historical names, secret identities, ranks, and deliberate introductions whenever the surrounding context requires them.

${deliveryInstructions(ttsProvider, ttsModel, language)}

Return only the complete polished narration script.`;
