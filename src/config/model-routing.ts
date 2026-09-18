import {
  LLMProviderName,
  ProviderCapability,
  PROVIDER_CAPABILITIES,
  providerHasCapability,
  StageModelConfig,
} from "../domain/provider.js";

export type ConfigurableAIStage = "translation" | "narration" | "qa" | "storyBible" | "scenePlanner";

export const CONFIGURABLE_AI_STAGES: readonly ConfigurableAIStage[] = [
  "translation",
  "narration",
  "qa",
  "storyBible",
  "scenePlanner",
] as const;

export const STAGE_LABELS: Record<ConfigurableAIStage, string> = {
  translation: "Translation",
  narration: "Narration",
  qa: "QA",
  storyBible: "Story Bible",
  scenePlanner: "Scene Planner",
};

export const STAGE_REQUIRED_CAPABILITIES: Partial<Record<ConfigurableAIStage, ProviderCapability>> = {
  scenePlanner: "structured_output",
};

export type ModelRoutingSource = "project" | "application_default" | "environment_default";

export type ResolvedModelRouting = {
  stage: ConfigurableAIStage;
  provider: LLMProviderName;
  model: string;
  source: ModelRoutingSource;
  isOverride: boolean;
  ready: boolean;
  reason?: string;
  capabilities: ProviderCapability[];
};

export type ModelRoutingContext = {
  stage: ConfigurableAIStage;
  story?: {
    pipeline?: Partial<Record<ConfigurableAIStage, StageModelConfig | undefined>>;
    pipelineOverrides?: Record<string, boolean>;
  };
  globalSettings?: Partial<Record<ConfigurableAIStage, StageModelConfig | undefined>>;
  env?: Record<string, unknown>;
  requiredCapability?: ProviderCapability;
};

const PROVIDER_ENV_KEYS: Record<LLMProviderName, string> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  kimi: "KIMI_API_KEY",
};

export function resolveModelRouting(ctx: ModelRoutingContext): ResolvedModelRouting {
  const env = ctx.env ?? process.env;
  const stage = ctx.stage;
  const requiredCap = ctx.requiredCapability ?? STAGE_REQUIRED_CAPABILITIES[stage];

  const storyConfig = ctx.story?.pipeline?.[stage];
  const isExplicitOverride = ctx.story?.pipelineOverrides?.[stage] === true;
  const isExplicitDefault = ctx.story?.pipelineOverrides?.[stage] === false;
  const globalConfig = ctx.globalSettings?.[stage];

  let resolvedConfig: StageModelConfig;
  let source: ModelRoutingSource;
  let isOverride: boolean;

  if (isExplicitOverride && storyConfig?.provider && storyConfig?.model) {
    resolvedConfig = storyConfig;
    source = "project";
    isOverride = true;
  } else if (isExplicitDefault && globalConfig?.provider && globalConfig?.model) {
    resolvedConfig = globalConfig;
    source = "application_default";
    isOverride = false;
  } else if (storyConfig?.provider && storyConfig?.model) {
    // If not explicitly flagged, compare with globalConfig
    if (
      globalConfig &&
      globalConfig.provider === storyConfig.provider &&
      globalConfig.model === storyConfig.model
    ) {
      resolvedConfig = storyConfig;
      source = "application_default";
      isOverride = false;
    } else {
      resolvedConfig = storyConfig;
      source = "project";
      isOverride = true;
    }
  } else if (globalConfig?.provider && globalConfig?.model) {
    resolvedConfig = globalConfig;
    source = "application_default";
    isOverride = false;
  } else {
    // Environment fallback
    const defaultProvider: LLMProviderName = stage === "translation" || stage === "storyBible" ? "gemini" : "openai";
    const defaultModel = defaultProvider === "gemini"
      ? (typeof env.GEMINI_DEFAULT_MODEL === "string" ? env.GEMINI_DEFAULT_MODEL : "gemini-3.8-flash")
      : (typeof env.OPENAI_DEFAULT_MODEL === "string" ? env.OPENAI_DEFAULT_MODEL : "gpt-5.6-luna");
    resolvedConfig = { provider: defaultProvider, model: defaultModel };
    source = "environment_default";
    isOverride = false;
  }

  const provider = resolvedConfig.provider;
  const model = resolvedConfig.model;
  const capabilities = Array.from(PROVIDER_CAPABILITIES[provider] ?? []);

  // Preflight validation
  let ready = true;
  let reason: string | undefined;

  if (requiredCap && !providerHasCapability(provider, requiredCap)) {
    ready = false;
    reason = `Provider '${provider}' does not support required capability '${requiredCap}'.`;
  } else {
    const envKey = PROVIDER_ENV_KEYS[provider];
    const rawVal = env[envKey];
    const keyVal = typeof rawVal === "string" ? rawVal : undefined;
    if (!keyVal || keyVal.trim() === "" || keyVal.trim() === "missing") {
      ready = false;
      reason = `Missing required ${provider} credential (${envKey}). Add it in Studio Settings or .env.`;
    }
  }

  return {
    stage,
    provider,
    model,
    source,
    isOverride,
    ready,
    reason,
    capabilities,
  };
}

export function resolveAllModelRoutings(
  story?: ModelRoutingContext["story"],
  globalSettings?: ModelRoutingContext["globalSettings"],
  env?: Record<string, unknown>
): Record<ConfigurableAIStage, ResolvedModelRouting> {
  const result: Partial<Record<ConfigurableAIStage, ResolvedModelRouting>> = {};
  for (const stage of CONFIGURABLE_AI_STAGES) {
    result[stage] = resolveModelRouting({ stage, story, globalSettings, env });
  }
  return result as Record<ConfigurableAIStage, ResolvedModelRouting>;
}

