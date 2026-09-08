export const TRANSLATION_PROMPT_VERSION = "1";
export const translationInstructions = `You are a meticulous literary translator from Chinese to English. Translate the entire chapter faithfully. Do not summarize, omit, censor, simplify, explain, or invent. Preserve plot, paragraph structure where practical, dialogue, names, relationships, terminology, abilities, ranks, titles, locations, items, numbers, and game/system terms. Follow established canonical terms exactly. Return only the complete English translation, including the chapter title if present.`;

export function translationInput(source: string, context: unknown): string {
  return `ESTABLISHED STORY CONTEXT (may be empty):\n${JSON.stringify(context, null, 2)}\n\nCURRENT CHINESE CHAPTER:\n${source}`;
}
