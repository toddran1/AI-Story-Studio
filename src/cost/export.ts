import type { CostFilters, ProviderUsageRecord } from "./types.js";

export const usageExportColumns = ["attemptedAt", "story", "chapter", "stage", "provider", "model", "effort", "operation", "success", "inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "inputTextTokens", "inputImageTokens", "outputImageTokens", "cachedTextTokens", "cachedImageTokens", "inputUtf8Bytes", "imageCount", "providerRequests", "durationMs", "serviceTier", "costUsd", "costStatus", "costUnavailableReason", "errorCategory", "requestId"] as const;
export function usageCsv(records: ProviderUsageRecord[]) {
  const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [usageExportColumns.join(","), ...records.map(record => usageExportColumns.map(key => cell(record[key])).join(","))].join("\n");
}
export async function allUsageRecords(repository: { list(filters: CostFilters): Promise<{ items: ProviderUsageRecord[]; pages: number }> }, filters: CostFilters) {
  const items: ProviderUsageRecord[] = [];
  let pages = 1;
  for (let page = 1; page <= pages; page++) { const result = await repository.list({ ...filters, page, pageSize: 200 }); items.push(...result.items); pages = result.pages; }
  return items;
}
