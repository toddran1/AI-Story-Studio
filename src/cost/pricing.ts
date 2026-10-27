import { PricingSnapshot } from "./types.js";

export const PRICING_CATALOG_VERSION = "2026-10-26";
const prices: Array<{ provider: string; model: string; snapshot: PricingSnapshot }> = [
  { provider: "openai", model: "gpt-6-sol", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "openai-gpt-6-sol-standard-2026-09", effectiveFrom: "2026-09-22", currency: "USD", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-sol", basis: "tokens", inputPerMillion: 2, cachedInputPerMillion: .2, outputPerMillion: 10 } },
  { provider: "openai", model: "gpt-6-luna", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "openai-gpt-6-luna-standard-2026-09", effectiveFrom: "2026-09-22", currency: "USD", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-luna", basis: "tokens", inputPerMillion: .1, cachedInputPerMillion: .01, outputPerMillion: .5 } },
  { provider: "openai", model: "gpt-5.6-terra", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "openai-gpt-5.6-terra-standard-2026-09", effectiveFrom: "2026-09-10", currency: "USD", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-terra", basis: "tokens", inputPerMillion: 2, cachedInputPerMillion: .2, outputPerMillion: 12 } },
  { provider: "gemini", model: "gemini-3.8-flash", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "gemini-3.8-flash-standard-intro-2026", effectiveFrom: "2026-09-10", currency: "USD", sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing", basis: "tokens", inputPerMillion: .75, cachedInputPerMillion: .075, outputPerMillion: 3.75 } },
  { provider: "kimi", model: "kimi-k2-0905-preview", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "kimi-k2-0905-preview-standard-2026-09", effectiveFrom: "2026-09-15", currency: "USD", sourceUrl: "https://platform.moonshot.ai/docs/pricing", basis: "tokens", inputPerMillion: .6, outputPerMillion: 2.5 } },
  { provider: "fish", model: "s2.1-pro", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "fish-s2.1-pro-2026", effectiveFrom: "2026-09-22", currency: "USD", sourceUrl: "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits", basis: "utf8_bytes", utf8BytesPerMillion: 15 } },
  { provider: "fish", model: "s2-pro", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "fish-s2-pro-2026", effectiveFrom: "2026-09-10", currency: "USD", sourceUrl: "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits", basis: "utf8_bytes", utf8BytesPerMillion: 15 } },
  { provider: "fish", model: "s1", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "fish-s1-2026", effectiveFrom: "2026-09-10", currency: "USD", sourceUrl: "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits", basis: "utf8_bytes", utf8BytesPerMillion: 15 } },
  { provider: "openai", model: "gpt-6-astra", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "openai-gpt-6-astra-standard-2026-10", effectiveFrom: "2026-10-26", verifiedAt: "2026-10-26", currency: "USD", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-astra", basis: "tokens", inputPerMillion: 10, cachedInputPerMillion: 1, outputPerMillion: 50 } },
  { provider: "openai", model: "gpt-6.1-sol", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "openai-gpt-6.1-sol-standard-2026-10", effectiveFrom: "2026-10-26", verifiedAt: "2026-10-26", currency: "USD", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6.1-sol", basis: "tokens", inputPerMillion: 2, cachedInputPerMillion: 0.1, outputPerMillion: 10 } },
  { provider: "openai", model: "gpt-6.1-terra", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "openai-gpt-6.1-terra-standard-2026-10", effectiveFrom: "2026-10-26", verifiedAt: "2026-10-26", currency: "USD", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6.1-terra", basis: "tokens", inputPerMillion: 1, cachedInputPerMillion: 0.05, outputPerMillion: 5 } },
  { provider: "openai", model: "gpt-5.6-sol", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "openai-gpt-5.6-sol-standard-2026-10", effectiveFrom: "2026-10-26", verifiedAt: "2026-10-26", currency: "USD", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-sol", basis: "tokens", inputPerMillion: 4, cachedInputPerMillion: 0.4, outputPerMillion: 20 } },
  { provider: "openai", model: "gpt-5.6-luna", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "openai-gpt-5.6-luna-standard-2026-10", effectiveFrom: "2026-10-26", verifiedAt: "2026-10-26", currency: "USD", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-luna", basis: "tokens", inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.2 } },
];

const GPT_IMAGE_1_PRICES: Record<string, Record<string, number>> = {
  low: { "1024x1024": .011, "1024x1536": .016, "1536x1024": .016 },
  medium: { "1024x1024": .042, "1024x1536": .063, "1536x1024": .063 },
  high: { "1024x1024": .167, "1024x1536": .25, "1536x1024": .25 },
};
const OPENAI_IMAGE_PRICE_TABLES: Record<string, Record<string, Record<string, number>>> = { "gpt-image-1": GPT_IMAGE_1_PRICES };
// Current image models use reported token usage; legacy GPT Image 1 retains per-image estimates.


export function normalizeFishPricingModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized;
}

export function pricingFor(provider: string, model: string, image?: {quality?:string;size?:string}, at = new Date()): PricingSnapshot | undefined {
  if (provider === "openai" && ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].includes(model)) return { catalogVersion: PRICING_CATALOG_VERSION, priceId: `openai-${model}-tokens-2026-10`, effectiveFrom: "2026-10-26", verifiedAt: "2026-10-26", currency: "USD", sourceUrl: `https://developers.openai.com/api/docs/models/${model}`, basis: "image_tokens", inputPerMillion: 5, cachedInputPerMillion: 1.25, inputImagePerMillion: 8, cachedImageInputPerMillion: 2, outputPerMillion: 30 };
  if (provider === "fish" && model.trim().toLowerCase() === "s2.1-pro-free") return { catalogVersion: PRICING_CATALOG_VERSION, priceId: "fish-s2.1-pro-free-2026-10", effectiveFrom: "2026-10-26", verifiedAt: "2026-10-26", currency: "USD", sourceUrl: "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits", basis: "utf8_bytes", utf8BytesPerMillion: 0 };
  if (provider === "openai" && image?.quality && image.size) {
    const imagePrice = OPENAI_IMAGE_PRICE_TABLES[model]?.[image.quality]?.[image.size];
    if (imagePrice !== undefined) return { catalogVersion: PRICING_CATALOG_VERSION, priceId: `openai-${model}-${image.quality}-${image.size}-2026-09`, effectiveFrom: "2026-09-10", currency: "USD", sourceUrl: `https://developers.openai.com/api/docs/models/${model}`, basis: "image", imagePrice };
  }
  if (provider === "gemini" && model === "gemini-3.1-flash-image") return { catalogVersion: PRICING_CATALOG_VERSION, priceId: "gemini-3.1-flash-image-tokens-2026-10", effectiveFrom: "2026-10-26", verifiedAt: "2026-10-26", currency: "USD", sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing", basis: "image_tokens", inputPerMillion: .5, inputImagePerMillion: .5, outputTextPerMillion: 3, outputPerMillion: 60 };
  if (provider === "gemini" && model === "gemini-2.5-flash-image") return undefined; // Retired; no verified complete token billing in this adapter.
  if (provider === "gemini" && model === "gemini-3.8-flash" && at >= new Date("2027-01-01T00:00:00Z")) return { ...prices.find(item => item.model === model)!.snapshot, priceId: "gemini-3.8-flash-standard-2027", effectiveFrom: "2027-01-01", inputPerMillion: 1.5, cachedInputPerMillion: .15, outputPerMillion: 7.5 };
  const effectiveModel = provider === "fish" ? normalizeFishPricingModel(model) : model;
  return prices.find((item) => item.provider === provider && item.model === effectiveModel)?.snapshot;
}
export function calculateCost(snapshot: PricingSnapshot | undefined, usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; inputUtf8Bytes?: number; imageCount?: number; inputTextTokens?: number; inputImageTokens?: number; cachedTextTokens?: number; cachedImageTokens?: number; outputImageTokens?: number }): number | undefined {
  if (!snapshot) return undefined;
  if (snapshot.basis === "image_tokens") {
    if (usage.inputTextTokens === undefined || usage.inputImageTokens === undefined || usage.outputTokens === undefined) return undefined;
    if ((usage.cachedInputTokens ?? 0) > 0 && usage.cachedTextTokens === undefined && usage.cachedImageTokens === undefined) return undefined;
    if (snapshot.outputTextPerMillion !== undefined && usage.outputImageTokens === undefined) return undefined;
    const imageOutput = usage.outputImageTokens ?? usage.outputTokens;
    const textCached = Math.min(usage.cachedTextTokens ?? 0, usage.inputTextTokens), imageCached = Math.min(usage.cachedImageTokens ?? 0, usage.inputImageTokens);
    return money(((usage.inputTextTokens - textCached) * (snapshot.inputPerMillion ?? 0) + textCached * (snapshot.cachedInputPerMillion ?? 0) + (usage.inputImageTokens - imageCached) * (snapshot.inputImagePerMillion ?? 0) + imageCached * (snapshot.cachedImageInputPerMillion ?? 0) + imageOutput * (snapshot.outputPerMillion ?? 0) + Math.max(0, usage.outputTokens - imageOutput) * (snapshot.outputTextPerMillion ?? 0)) / 1_000_000);
  }
  if (snapshot.basis === "tokens") {
    if (usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
    const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens ?? 0); const uncached = Math.max(0, (usage.inputTokens ?? 0) - cached);
    return money((uncached * (snapshot.inputPerMillion ?? 0) + cached * (snapshot.cachedInputPerMillion ?? snapshot.inputPerMillion ?? 0) + (usage.outputTokens ?? 0) * (snapshot.outputPerMillion ?? 0)) / 1_000_000);
  }
  if (snapshot.basis === "utf8_bytes") return usage.inputUtf8Bytes === undefined ? undefined : money(usage.inputUtf8Bytes * (snapshot.utf8BytesPerMillion ?? 0) / 1_000_000);
  return usage.imageCount === undefined || snapshot.imagePrice === undefined ? undefined : money(usage.imageCount * snapshot.imagePrice);
}
function money(value: number) { return Math.round(value * 1e9) / 1e9; }
