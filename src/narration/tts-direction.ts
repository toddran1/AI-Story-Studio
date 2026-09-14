import { FISH_S2_CONTROL_CUES, FISH_S2_MODELS } from "../tts/fish/control-cues.js";

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
export type DeliveryIntensity = "none" | "restrained" | "expressive";

const S1_CUES = [
  "happy", "sad", "angry", "excited", "surprised", "scared", "worried", "nervous", "frustrated", "confident", "curious",
  "whispering", "soft tone", "shouting", "laughing", "chuckling", "sobbing", "sighing", "gasping", "break", "long-break",
];

export function narrationDeliveryProfile(provider: string | undefined, model: string | undefined): NarrationDeliveryProfile {
  if (provider?.trim().toLowerCase() !== "fish") return { id: "plain", version: "plain-delivery-v1", cueSyntax: "none" };
  const normalized = model?.trim().toLowerCase();
  if (normalized && FISH_S2_MODELS.has(normalized)) return { id: "fish-s2", version: "fish-s2-delivery-v1", cueSyntax: "brackets" };
  if (normalized === "s1") return { id: "fish-s1", version: "fish-s1-delivery-v1", cueSyntax: "parentheses" };
  return { id: "plain", version: "plain-delivery-v1", cueSyntax: "none" };
}

export function deliveryInstructions(provider: string | undefined, model: string | undefined, language: string, intensity: DeliveryIntensity = "restrained"): string {
  const profile = narrationDeliveryProfile(provider, model);
  if (profile.id === "plain" || intensity === "none") return "Return clean, spoken narration with no TTS control tags.";
  const syntax = profile.cueSyntax === "brackets" ? "square brackets, for example [whisper]" : "parentheses, for example (whispering)";
  const choices = (profile.id === "fish-s2" ? FISH_S2_CONTROL_CUES : S1_CUES).map((cue) => profile.cueSyntax === "brackets" ? `[${cue}]` : `(${cue})`).join(", ");
  const frequency = intensity === "restrained"
    ? "Keep delivery restrained: prefer punctuation over tags, avoid dramatic cues in ordinary dialogue, and use at most one cue across any three paragraphs."
    : "Use expressive cues where the text clearly supports them, without inventing emotion or tagging ordinary exposition.";
  return `Prepare this ${language} narration for ${profile.id === "fish-s2" ? "Fish Audio S2" : "Fish Audio S1"}. Preserve every spoken word exactly, but you may add delivery-only cues using ${syntax}. ${frequency} Never invent sounds, actions, emotions, or atmosphere. Do not stack cues or use more than one cue in a sentence. Use [pause]/[long-break] (or the parenthesized equivalent) only at meaningful turns, because mastering already supplies normal paragraph pauses. Use only this controlled vocabulary so the application can keep the reader-facing manuscript clean: ${choices}.`;
}

/** Removes only the controlled cue vocabulary, preserving ordinary bracketed story text such as [System]. */
export function stripDeliveryCues(text: string, provider: string | undefined, model: string | undefined): string {
  const profile = narrationDeliveryProfile(provider, model);
  if (profile.cueSyntax === "none") return text.trim();
  const escaped = (profile.id === "fish-s2" ? FISH_S2_CONTROL_CUES : S1_CUES).map(escapeRegExp).join("|");
  const open = profile.cueSyntax === "brackets" ? "\\[" : "\\(";
  const close = profile.cueSyntax === "brackets" ? "\\]" : "\\)";
  return text.replace(new RegExp(`${open}(?:${escaped})${close}`, "gi"), "").replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
