import { TTSRequest, TTSResult } from "./types.js";
import type { PronunciationCapabilities } from "./pronunciation.js";
import type { VocalizationCapabilities, VocalizationRenderStrategy } from "./vocalizations.js";
export interface TTSProvider {
  readonly name: string;
  /** Bump when the provider changes how it normalizes text before synthesis. */
  readonly inputNormalizationVersion?: string;
  readonly pronunciationCapabilities?: PronunciationCapabilities;
  readonly vocalizationCapabilities?: VocalizationCapabilities;
  /** How detected vocalizations should be rendered for the given model. */
  vocalizationStrategy?(model?: string): VocalizationRenderStrategy;
  /** Resolves a per-story voice override to the concrete voice used by the provider. */
  resolveReferenceId?(referenceId?: string): string | undefined;
  synthesize(request: TTSRequest): Promise<TTSResult>;
  validateConfiguration(): Promise<void>;
}
