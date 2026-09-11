/**
 * Delivery directions are deliberately kept out of the reader-facing narration.
 * Fish S2 recognizes bracketed natural-language cues, while legacy S1 uses a
 * fixed parenthesized vocabulary. Unknown providers/models stay plain-text.
 */
export type NarrationDeliveryProfile = {
  id: "fish-s2" | "fish-s1" | "plain";
  version: string;
  cueSyntax: "brackets" | "parentheses" | "none";
};

const S2_MODELS = new Set(["s2-pro", "s2.1-pro", "s2.1-pro-free"]);
const S2_CUES = [
  "whisper", "whispering", "laugh", "laughing", "emphasis", "sigh", "gasp", "pause", "long-break", "inhale", "exhale",
  "happy", "sad", "angry", "excited", "calm", "nervous", "confident", "surprised", "scared", "worried", "frustrated",
  "empathetic", "mysterious", "determined", "soft", "shouting", "breathless",
];
const S1_CUES = [
  "happy", "sad", "angry", "excited", "surprised", "scared", "worried", "nervous", "frustrated", "confident", "curious",
  "whispering", "soft tone", "shouting", "laughing", "chuckling", "sobbing", "sighing", "gasping", "break", "long-break",
];

export function narrationDeliveryProfile(provider: string | undefined, model: string | undefined): NarrationDeliveryProfile {
  if (provider?.trim().toLowerCase() !== "fish") return { id: "plain", version: "plain-delivery-v1", cueSyntax: "none" };
  const normalized = model?.trim().toLowerCase();
  if (normalized && S2_MODELS.has(normalized)) return { id: "fish-s2", version: "fish-s2-delivery-v1", cueSyntax: "brackets" };
  if (normalized === "s1") return { id: "fish-s1", version: "fish-s1-delivery-v1", cueSyntax: "parentheses" };
  return { id: "plain", version: "plain-delivery-v1", cueSyntax: "none" };
}

export function deliveryInstructions(provider: string | undefined, model: string | undefined, language: string): string {
  const profile = narrationDeliveryProfile(provider, model);
  if (profile.id === "plain") return "Return clean, spoken narration with no TTS control tags.";
  const syntax = profile.cueSyntax === "brackets" ? "square brackets, for example [whisper]" : "parentheses, for example (whispering)";
  const choices = (profile.id === "fish-s2" ? S2_CUES : S1_CUES).map((cue) => profile.cueSyntax === "brackets" ? `[${cue}]` : `(${cue})`).join(", ");
  return `Prepare this ${language} narration for ${profile.id === "fish-s2" ? "Fish Audio S2" : "Fish Audio S1"}. Preserve every spoken word exactly, but you may add sparse delivery-only cues using ${syntax}. Use cues only when the text itself clearly supports the delivery; never invent sounds, actions, emotions, or atmosphere. Do not tag ordinary exposition, do not stack cues, and do not use more than one cue in a sentence. Use [pause]/[long-break] (or the parenthesized equivalent) only at meaningful turns, because mastering already supplies normal paragraph pauses. Use only this controlled vocabulary so the application can keep the reader-facing manuscript clean: ${choices}.`;
}

/** Removes only the controlled cue vocabulary, preserving ordinary bracketed story text such as [System]. */
export function stripDeliveryCues(text: string, provider: string | undefined, model: string | undefined): string {
  const profile = narrationDeliveryProfile(provider, model);
  if (profile.cueSyntax === "none") return text.trim();
  const escaped = (profile.id === "fish-s2" ? S2_CUES : S1_CUES).map(escapeRegExp).join("|");
  const open = profile.cueSyntax === "brackets" ? "\\[" : "\\(";
  const close = profile.cueSyntax === "brackets" ? "\\]" : "\\)";
  return text.replace(new RegExp(`${open}(?:${escaped})${close}`, "gi"), "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
