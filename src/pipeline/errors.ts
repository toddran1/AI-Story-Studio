export class AppError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = new.target.name; }
}
export class ConfigurationError extends AppError {}
export class ProviderError extends AppError {}
export class TranslationError extends AppError {}
export class NarrationError extends AppError {}
export class StoryBibleError extends AppError {}
export class TTSError extends AppError {}
export class StorageError extends AppError {}
export class PipelineError extends AppError {}
