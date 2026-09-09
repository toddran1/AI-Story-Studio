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
export class QualityGateError extends PipelineError {
  constructor(message: string, public readonly result: import("../domain/qa.js").QaResult) { super(message); }
}
export class BatchValidationError extends AppError {}
export class BatchError extends AppError {}
export class AudioError extends AppError {}
export class SubtitleError extends AppError {}
export class VideoError extends AppError {}
