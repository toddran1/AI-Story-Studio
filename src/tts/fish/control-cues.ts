export const FISH_S2_MODELS = new Set(["s2-pro", "s2.1-pro", "s2.1-pro-free"]);

export const FISH_S2_CONTROL_CUES = [
  "whisper", "whispering", "laugh", "laughing", "clears throat", "cough", "emphasis", "sigh", "gasp", "pause", "long-break", "inhale", "exhale",
  "happy", "sad", "angry", "excited", "calm", "nervous", "confident", "surprised", "scared", "worried", "frustrated",
  "empathetic", "mysterious", "determined", "soft", "shouting", "breathless",
] as const;

const cueSet = new Set<string>(FISH_S2_CONTROL_CUES);

export function isFishS2Model(model?: string): boolean {
  return Boolean(model && FISH_S2_MODELS.has(model.trim().toLowerCase()));
}

/**
 * Fish S2 treats square brackets as delivery controls. Keep only the cues the
 * application deliberately emits; ordinary story text loses the control
 * delimiters but keeps every spoken word.
 */
export function disambiguateFishS2Brackets(text: string, model?: string): string {
  if (!isFishS2Model(model)) return text;
  return text.replace(/\[([^\[\]\r\n]{1,240})\]/g, (_match, content: string) => {
    const spoken = content.trim();
    return cueSet.has(spoken.toLowerCase()) ? `[${spoken.toLowerCase()}]` : spoken;
  });
}
