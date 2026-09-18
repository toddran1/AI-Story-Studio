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
  readonly dependencyFingerprint?: string;
  constructor(message: string, public readonly result: import("../domain/qa.js").QaResult, options: { dependencyFingerprint?: string } = {}) {
    super(message);
    this.dependencyFingerprint = options.dependencyFingerprint;
  }
}
export class BatchValidationError extends AppError {}
export class BatchError extends AppError {}
export class AudioError extends AppError {}
export class SubtitleError extends AppError {}
export class VideoError extends AppError {}
export class SceneError extends AppError {}
export class ArtworkError extends AppError {}
export interface RollbackFailure {
  phase: string;
  error: unknown;
}

export class ReconciliationError extends AppError {
  readonly rollbackError?: unknown;
  readonly rollbackFailures?: RollbackFailure[];
  readonly storySlug?: string;
  readonly targetEntityId?: string;
  readonly sourceEntityIds?: string[];
  readonly mergeId?: string;
  readonly failedPhase?: string;

  constructor(
    message: string,
    options?: ErrorOptions & {
      rollbackError?: unknown;
      rollbackFailures?: RollbackFailure[];
      storySlug?: string;
      targetEntityId?: string;
      sourceEntityIds?: string[];
      mergeId?: string;
      failedPhase?: string;
    }
  ) {
    super(message, options);
    this.rollbackFailures = options?.rollbackFailures;
    this.rollbackError = options?.rollbackError ?? options?.rollbackFailures?.[0]?.error;
    this.storySlug = options?.storySlug;
    this.targetEntityId = options?.targetEntityId;
    this.sourceEntityIds = options?.sourceEntityIds;
    this.mergeId = options?.mergeId;
    this.failedPhase = options?.failedPhase;
  }
}
