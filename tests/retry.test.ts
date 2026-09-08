import { describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../src/pipeline/errors.js";
import { withRetry } from "../src/batch/retry.js";

const retry = { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100 };
describe("retry", () => {
  it("retries transient failures with bounded attempts", async () => {
    const operation = vi.fn().mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 })).mockResolvedValue("ok");
    const sleep = vi.fn(async () => undefined);
    await expect(withRetry(operation, retry, { sleep, random: () => 0 })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2); expect(sleep).toHaveBeenCalledTimes(1);
  });
  it("does not retry permanent configuration errors", async () => {
    const operation = vi.fn(async () => { throw new ConfigurationError("invalid API key"); });
    await expect(withRetry(operation, retry, { sleep: async () => undefined })).rejects.toThrow(/invalid API key/);
    expect(operation).toHaveBeenCalledTimes(1);
  });
  it("respects max attempts", async () => {
    const operation = vi.fn(async () => { throw Object.assign(new Error("unavailable"), { status: 503 }); });
    await expect(withRetry(operation, retry, { sleep: async () => undefined })).rejects.toThrow(/unavailable/);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
