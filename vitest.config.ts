import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  // PGlite initialization and the synthetic 1,600-chapter continuity case can
  // be delayed when the full suite starts many workers concurrently.
  test: { include: ["tests/**/*.{test,spec}.{ts,tsx}"], testTimeout: 30_000, hookTimeout: 30_000 },
});
