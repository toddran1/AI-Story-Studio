import { StageModelConfig } from "../domain/provider.js";
import { LLMProvider } from "./provider.js";
import { ConfigurationError } from "../pipeline/errors.js";

export class LLMRouter {
  constructor(private readonly providers: Map<string, LLMProvider>) {}
  forStage(config: StageModelConfig): LLMProvider {
    const provider = this.providers.get(config.provider);
    if (!provider) throw new ConfigurationError(`LLM provider '${config.provider}' is not registered`);
    if (config.effort === undefined) return provider;
    return {
      name: provider.name, supportsImageInputs: provider.supportsImageInputs,
      validateConfiguration: () => provider.validateConfiguration(),
      generateText: request => provider.generateText({ ...request, effort: config.effort }),
      generateStructured: request => provider.generateStructured({ ...request, effort: config.effort }),
    };
  }
}
