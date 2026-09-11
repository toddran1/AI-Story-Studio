# Provider cost tracking

AI Story Studio records paid provider operations in Postgres and mirrors each accepted record to `stories/<story>/analytics/usage/` so project backups retain a portable audit trail. Records use provider request IDs for idempotency when available and retain the pricing snapshot used at calculation time.

The built-in catalog is versioned `2026-09-10`. It contains standard API rates for GPT-5.6 Terra, Gemini 3.8 Flash's introductory 2026 rate, Fish Audio S2 Pro/S1, and GPT Image 1 by requested quality and size. Sources are the official [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), and [Fish Audio pricing](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits). An unknown model or incomplete usage response is marked `unavailable`; it is never recorded as zero cost.

The production estimator makes no provider requests. It excludes reusable stages and uses the story's priced request history where available. Historical estimates show a directional range and confidence because output length and retries vary. An optional run budget is a soft guard: it is checked after a chapter completes, so an in-flight request can exceed it.

Use `npm run story:cost -- --story <slug>` for a terminal summary. Add `--from`, `--to`, `--provider`, `--stage`, or `--model` filters and `--format json|csv` for exports. The web studio provides the same ledger under **Costs / Analytics**.
