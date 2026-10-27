/** Interactions thinking levels from the Gemini thinking model table. */
export function geminiEfforts(model: string): string[] {
  if (/^gemini-(?:3\.6-flash|3\.5-flash-lite|3-flash-preview|robotics-er-2-preview)(?:-|$)/.test(model)) return ["minimal", "low", "medium", "high"];
  if (/^gemini-3\.1-flash-lite-image(?:-|$)/.test(model)) return ["minimal", "high"];
  if (/^gemini-3-pro-preview(?:-|$)/.test(model)) return ["low", "high"];
  if (/^gemini-(?:4-argon|3\.8-flash|3\.1-pro-preview|2\.5-(?:pro|flash|flash-lite))(?:-|$)/.test(model)) return ["low", "medium", "high"];
  return [];
}
