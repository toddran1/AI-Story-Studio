/** K2.5 exposes a thinking switch rather than numbered reasoning levels. */
export function kimiEfforts(model: string): string[] {
  return /^kimi-k2\.5(?:-|$)/.test(model) ? ["disabled", "enabled"] : [];
}
