import { StageModelConfig } from "../domain/provider.js";
import { LLMProvider } from "./provider.js";
import { ConfigurationError } from "../pipeline/errors.js";

export class LLMRouter {
  constructor(private readonly providers: Map<string, LLMProvider>) {}
  forStage(config: StageModelConfig): LLMProvider {
    const provider = this.providers.get(config.provider);
    if (!provider) throw new ConfigurationError(`LLM provider '${config.provider}' is not registered`);
    return provider;
  }
}
