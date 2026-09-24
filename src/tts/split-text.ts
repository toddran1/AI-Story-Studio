export function splitForTTS(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const push = (part: string) => {
    if (!current) current = part;
    else if (current.length + part.length + 2 <= maxChars) current += `\n\n${part}`;
    else { chunks.push(current); current = part; }
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) { push(paragraph); continue; }
    // Closing quotes belong to the preceding sentence; never begin a Fish
    // request with a detached closing quote after a boundary.
    for (const sentence of paragraph.match(/[^.!?。！？]+[.!?。！？]+[”"'’)]*|[^.!?。！？]+$/g) ?? [paragraph]) {
      const trimmed = sentence.trim();
      if (trimmed.length <= maxChars) push(trimmed);
      else for (let start = 0; start < trimmed.length;) {
        let end = Math.min(trimmed.length, start + maxChars);
        // Hard slices back off to the last whitespace so provider control tags
        // (e.g. [laugh], <|speaker:0|>) and words are never cut in half.
        if (end < trimmed.length) { const boundary = trimmed.lastIndexOf(" ", end); if (boundary > start) end = boundary; }
        push(trimmed.slice(start, end).trim()); start = end;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Split one failed segment for a bounded opening repair. No audio slicing. */
export function splitOpeningSentenceForTTSRepair(text: string): [string, string] | undefined {
  const trimmed = text.trim();
  // Speaker assignment can carry across sentences; splitting would lose that
  // state in the second exactChunk request. Fall back to one-segment retry.
  if (/<\|speaker:\d+\|>/u.test(trimmed)) return undefined;
  const first = /^(.*?[.!?。！？]+[”"'’)]*)(?:\s+|$)/u.exec(trimmed)?.[1]?.trim();
  if (!first || first.length < 15 || first.length > 400) return undefined;
  const remainder = trimmed.slice(first.length).trim();
  if (remainder.length < 10) return undefined;
  return [first, remainder];
}
