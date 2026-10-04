/** Removes paired Markdown emphasis without consuming literal multiplication. */
export function stripSpeechMarkdownEmphasis(text: string): string {
  let normalized = text;
  let previous: string | undefined;
  do {
    previous = normalized;
    normalized = normalized.replace(/(^|[^\p{L}\p{N}_])\*{1,3}(?=\S)([^*\n]*?\S)\*{1,3}(?=$|[^\p{L}\p{N}_])/gmu, "$1$2");
  } while (normalized !== previous);
  return normalized;
}
