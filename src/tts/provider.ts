import { TTSRequest, TTSResult } from "./types.js";
export interface TTSProvider {
  readonly name: string;
  /** Bump when the provider changes how it normalizes text before synthesis. */
  readonly inputNormalizationVersion?: string;
  /** Resolves a per-story voice override to the concrete voice used by the provider. */
  resolveReferenceId?(referenceId?: string): string | undefined;
  synthesize(request: TTSRequest): Promise<TTSResult>;
  validateConfiguration(): Promise<void>;
}
