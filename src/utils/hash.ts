import { createHash } from "node:crypto";

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as unknown[]).map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
