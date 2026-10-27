/** Supported Responses reasoning levels; unknown/custom models retain provider defaults. */
export function openAiEfforts(model: string): string[] {
  if (/^gpt-(?:6(?:\.1)?|5\.6)-(?:sol|terra|luna|astra)(?:-|$)/.test(model)) {
    const levels = ["low", "medium", "high", "xhigh", "max"];
    return /^gpt-(?:6-astra|6\.1-sol)(?:-|$)/.test(model) ? levels : ["none", ...levels];
  }
  if (/^(?:o1|o3|o4-mini)(?:-|$)/.test(model)) return ["low", "medium", "high"];
  return [];
}
