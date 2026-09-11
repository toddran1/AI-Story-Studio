import { TTSRequest, TTSResult } from "./types.js";
export interface TTSProvider {
  readonly name: "fish";
  /** Resolves a per-story voice override to the concrete voice used by the provider. */
  resolveReferenceId?(referenceId?: string): string | undefined;
  synthesize(request: TTSRequest): Promise<TTSResult>;
  validateConfiguration(): Promise<void>;
}
