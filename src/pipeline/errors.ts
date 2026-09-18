export class AppError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = new.target.name; }
}
export class ConfigurationError extends AppError {}
export class ProviderError extends AppError {
  readonly status?: number;
  readonly code?: string;
  readonly category?: string;
  readonly requestId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly retryable?: boolean;
  constructor(message: string, options?: ErrorOptions & {
    status?: number;
    code?: string;
    category?: string;
    requestId?: string;
    provider?: string;
    model?: string;
    retryable?: boolean;
  }) {
    super(message, options);
    this.status = options?.status;
    this.code = options?.code;
    this.category = options?.category;
    this.requestId = options?.requestId;
    this.provider = options?.provider;
    this.model = options?.model;
    this.retryable = options?.retryable;
  }
}
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
export class SceneError extends AppError {}
export class ArtworkError extends AppError {}
