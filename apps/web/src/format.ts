export function pretty(value: string) {
  const words = value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("-", " ").split(" ");
  const acronyms: Record<string, string> = { qa: "QA", tts: "TTS", api: "API", llm: "LLM" };
  return words.map((word, index) => acronyms[word.toLowerCase()] ?? (index === 0 ? word.replace(/^./, (character) => character.toUpperCase()) : word)).join(" ");
}
