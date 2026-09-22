import { PricingSnapshot } from "./types.js";

export const PRICING_CATALOG_VERSION = "2026-09-22";
const prices: Array<{ provider: string; model: string; snapshot: PricingSnapshot }> = [
  { provider: "openai", model: "gpt-6-sol", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "openai-gpt-6-sol-standard-2026-09", effectiveFrom: "2026-09-22", currency: "USD", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-sol", basis: "tokens", inputPerMillion: 2, cachedInputPerMillion: .2, outputPerMillion: 10 } },
  { provider: "openai", model: "gpt-6-luna", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "openai-gpt-6-luna-standard-2026-09", effectiveFrom: "2026-09-22", currency: "USD", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-luna", basis: "tokens", inputPerMillion: .1, cachedInputPerMillion: .01, outputPerMillion: .5 } },
  { provider: "openai", model: "gpt-5.6-terra", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "openai-gpt-5.6-terra-standard-2026-09", effectiveFrom: "2026-09-10", currency: "USD", sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-terra", basis: "tokens", inputPerMillion: 2, cachedInputPerMillion: .2, outputPerMillion: 12 } },
  { provider: "gemini", model: "gemini-3.8-flash", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "gemini-3.8-flash-standard-intro-2026", effectiveFrom: "2026-09-10", currency: "USD", sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing", basis: "tokens", inputPerMillion: .75, cachedInputPerMillion: .075, outputPerMillion: 3.75 } },
  { provider: "kimi", model: "kimi-k2-0905-preview", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "kimi-k2-0905-preview-standard-2026-09", effectiveFrom: "2026-09-15", currency: "USD", sourceUrl: "https://platform.moonshot.ai/docs/pricing", basis: "tokens", inputPerMillion: .6, outputPerMillion: 2.5 } },
  { provider: "fish", model: "s2-pro", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "fish-s2-pro-2026", effectiveFrom: "2026-09-10", currency: "USD", sourceUrl: "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits", basis: "utf8_bytes", utf8BytesPerMillion: 15 } },
  { provider: "fish", model: "s1", snapshot: { catalogVersion: PRICING_CATALOG_VERSION, priceId: "fish-s1-2026", effectiveFrom: "2026-09-10", currency: "USD", sourceUrl: "https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits", basis: "utf8_bytes", utf8BytesPerMillion: 15 } },
];

const GPT_IMAGE_1_PRICES: Record<string, Record<string, number>> = {
  low: { "1024x1024": .011, "1024x1536": .016, "1536x1024": .016 },
  medium: { "1024x1024": .042, "1024x1536": .063, "1536x1024": .063 },
  high: { "1024x1024": .167, "1024x1536": .25, "1536x1024": .25 },
};
function scaledImagePrices(multiplier: number): Record<string, Record<string, number>> {
  return Object.fromEntries(Object.entries(GPT_IMAGE_1_PRICES).map(([quality, sizes]) => [quality, Object.fromEntries(Object.entries(sizes).map(([size, price]) => [size, price * multiplier]))]));
}
const OPENAI_IMAGE_PRICE_TABLES: Record<string, Record<string, Record<string, number>>> = {
  "gpt-image-1": GPT_IMAGE_1_PRICES,
  "gpt-image-2.5-flare": scaledImagePrices(.5),
  "gpt-image-2.5-sunburst": scaledImagePrices(1.5),
};
// Gemini image models price per image by output resolution (quality intent maps to 1K/2K/4K).
const GEMINI_IMAGE_PRICES: Record<string, number> = { low: .02, medium: .045, high: .09 };

export function pricingFor(provider: string, model: string, image?: {quality?:string;size?:string}): PricingSnapshot | undefined {
  if (provider === "openai" && image?.quality && image.size) {
    const imagePrice = OPENAI_IMAGE_PRICE_TABLES[model]?.[image.quality]?.[image.size];
    if (imagePrice !== undefined) return { catalogVersion: PRICING_CATALOG_VERSION, priceId: `openai-${model}-${image.quality}-${image.size}-2026-09`, effectiveFrom: "2026-09-10", currency: "USD", sourceUrl: `https://developers.openai.com/api/docs/models/${model}`, basis: "image", imagePrice };
  }
  if (provider === "gemini" && (model === "gemini-3.1-flash-image" || model === "gemini-2.5-flash-image") && image?.quality) {
    const quality = model === "gemini-2.5-flash-image" ? "low" : image.quality;
    const imagePrice = GEMINI_IMAGE_PRICES[quality];
    if (imagePrice !== undefined) return { catalogVersion: PRICING_CATALOG_VERSION, priceId: `gemini-${model}-${quality}-2026-09`, effectiveFrom: "2026-09-19", currency: "USD", sourceUrl: "https://ai.google.dev/gemini-api/docs/pricing", basis: "image", imagePrice };
  }
  return prices.find((item) => item.provider === provider && item.model === model)?.snapshot;
}
export function calculateCost(snapshot: PricingSnapshot | undefined, usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; inputUtf8Bytes?: number; imageCount?: number }): number | undefined {
  if (!snapshot) return undefined;
  if (snapshot.basis === "tokens") {
    if (usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;
    const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens ?? 0); const uncached = Math.max(0, (usage.inputTokens ?? 0) - cached);
    return money((uncached * (snapshot.inputPerMillion ?? 0) + cached * (snapshot.cachedInputPerMillion ?? snapshot.inputPerMillion ?? 0) + (usage.outputTokens ?? 0) * (snapshot.outputPerMillion ?? 0)) / 1_000_000);
  }
  if (snapshot.basis === "utf8_bytes") return usage.inputUtf8Bytes === undefined ? undefined : money(usage.inputUtf8Bytes * (snapshot.utf8BytesPerMillion ?? 0) / 1_000_000);
  return usage.imageCount === undefined || snapshot.imagePrice === undefined ? undefined : money(usage.imageCount * snapshot.imagePrice);
}
function money(value: number) { return Math.round(value * 1e9) / 1e9; }
