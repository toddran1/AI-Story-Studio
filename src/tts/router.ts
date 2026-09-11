import { ConfigurationError } from "../pipeline/errors.js";
import { TTSProvider } from "./provider.js";

export class TTSProviderRouter {
  private readonly providers: Map<string, TTSProvider>;

  constructor(providers: Map<string, TTSProvider> | TTSProvider) {
    this.providers = providers instanceof Map ? new Map(providers) : new Map([[providers.name, providers]]);
    for (const [name, provider] of this.providers) if (name !== provider.name) throw new Error(`TTS provider key '${name}' does not match provider name '${provider.name}'`);
  }

  forName(name: string): TTSProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new ConfigurationError(`TTS provider '${name}' is not installed. Available providers: ${this.names().join(", ") || "none"}`);
    return provider;
  }

  names(): string[] { return [...this.providers.keys()].sort(); }
}
