import { NovelProviderDescriptor, NovelSourceProvider } from "./novel-provider.js";

const DEFAULT_RATE = { minimumDelayMs: 500, maximumConcurrency: 2 };

export function providerDescriptor(provider: NovelSourceProvider): NovelProviderDescriptor {
  return provider.descriptor ?? {
    id: provider.id,
    displayName: provider.displayName,
    domains: [],
    languages: ["zh-CN"],
    priority: provider.id === "fanqie" ? 900 : 100,
    reliability: provider.id === "fanqie" ? "limited" : "standard",
    enabledByDefault: true,
    capabilities: provider.capabilities,
    rateLimit: DEFAULT_RATE,
  };
}

export type ProviderHealthStatus = "healthy" | "degraded" | "cooldown" | "disabled" | "unknown";
export type ProviderHealth = {
  provider: string;
  status: ProviderHealthStatus;
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  cooldownUntil?: string;
};

export class ProviderCircuitBreaker {
  private readonly states = new Map<string, ProviderHealth>();
  constructor(private readonly failureThreshold = 3, private readonly cooldownMs = 60_000) {}
  state(provider: string): ProviderHealth {
    const current = this.states.get(provider) ?? { provider, status: "unknown", consecutiveFailures: 0 };
    if (current.status === "cooldown" && current.cooldownUntil && Date.parse(current.cooldownUntil) <= Date.now()) {
      const recovered = { ...current, status: "degraded" as const, cooldownUntil: undefined }; this.states.set(provider, recovered); return recovered;
    }
    return { ...current };
  }
  assertAvailable(provider: string) {
    const current = this.state(provider); if (current.status === "disabled") throw new Error(`Novel provider '${provider}' is disabled`);
    if (current.status === "cooldown" && current.cooldownUntil) throw new Error(`Novel provider '${provider}' is cooling down until ${current.cooldownUntil}`);
  }
  success(provider: string) { this.states.set(provider, { ...this.state(provider), status: "healthy", consecutiveFailures: 0, lastSuccessAt: new Date().toISOString(), cooldownUntil: undefined, lastError: undefined }); }
  failure(provider: string, error: unknown) {
    const previous = this.state(provider); const failures = previous.consecutiveFailures + 1; const cooldownUntil = failures >= this.failureThreshold ? new Date(Date.now() + this.cooldownMs).toISOString() : undefined;
    this.states.set(provider, { ...previous, status: cooldownUntil ? "cooldown" : "degraded", consecutiveFailures: failures, lastFailureAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : String(error), cooldownUntil });
  }
  disable(provider: string) { this.states.set(provider, { ...this.state(provider), status: "disabled" }); }
  enable(provider: string) { this.states.set(provider, { ...this.state(provider), status: "unknown", consecutiveFailures: 0, cooldownUntil: undefined, lastError: undefined }); }
}
