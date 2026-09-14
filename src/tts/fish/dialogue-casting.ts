/**
 * Assigns all quoted dialogue to one secondary Fish voice. The quote marks stay
 * in the script as punctuation; only Fish sees the speaker tags.
 */
export function castQuotedDialogue(text: string): string {
  let speaker: 0 | 1 = 0;
  let output = "<|speaker:0|>";
  const openToClose: Record<string, string> = { "“": "”", "\u300c": "\u300d", "\u300e": "\u300f", "\u00ab": "\u00bb" };
  let expectedClose: string | undefined;

  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    const isStraightQuote = character === "\"";
    const opensPair = openToClose[character];
    const closesPair = expectedClose === character;
    if (isStraightQuote || opensPair || closesPair) {
      if (speaker === 0) {
        speaker = 1;
        expectedClose = opensPair;
        output += `<|speaker:1|>${character}`;
      } else {
        output += `${character}<|speaker:0|>`;
        speaker = 0;
        expectedClose = undefined;
      }
      continue;
    }
    output += character;
  }

  return output.replace(/<\|speaker:0\|>\s*<\|speaker:1\|>/g, "<|speaker:1|>").trim();
}

/**
 * Keeps Fish on one reference voice while giving quoted speech a small,
 * provider-only delivery shift. These cues are never written to narration.
 */
export function directQuotedDialogue(text: string): string {
  const openToClose: Record<string, string> = { "\"": "\"", "“": "”", "\u300c": "\u300d", "\u300e": "\u300f", "\u00ab": "\u00bb" };
  let output = "";

  for (let index = 0; index < text.length;) {
    const close = openToClose[text[index]!];
    if (!close) {
      output += text[index]!;
      index += 1;
      continue;
    }

    const closeIndex = text.indexOf(close, index + 1);
    if (closeIndex < 0) {
      output += text.slice(index);
      break;
    }

    // Preserve a deliberate emotion cue already placed immediately before a
    // quote. Otherwise use a restrained direction and reset after the line.
    const alreadyDirected = /\[[a-z][a-z -]*\]\s*$/i.test(output);
    if (!alreadyDirected) output += "[soft] ";
    output += `${text.slice(index, closeIndex + 1)}[calm]`;
    index = closeIndex + 1;
  }

  return output.trim();
}

/** Ensures independently submitted chunks retain the speaker active at a split. */
export function ensureChunkSpeakers(chunks: string[]): string[] {
  let speaker: 0 | 1 = 0;
  return chunks.map((chunk) => {
    const text = chunk.startsWith("<|speaker:") ? chunk : `<|speaker:${speaker}|>${chunk}`;
    for (const match of text.matchAll(/<\|speaker:([01])\|>/g)) speaker = match[1] === "1" ? 1 : 0;
    return text;
  });
}
