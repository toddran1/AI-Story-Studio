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
    for (const sentence of paragraph.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g) ?? [paragraph]) {
      const trimmed = sentence.trim();
      if (trimmed.length <= maxChars) push(trimmed);
      else for (let start = 0; start < trimmed.length; start += maxChars) push(trimmed.slice(start, start + maxChars));
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
