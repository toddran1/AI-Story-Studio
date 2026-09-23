export class QaPrerequisiteError extends Error {
  constructor(readonly code: "QA_CONTEXT_INVALID" | "QA_CONTINUITY_INVALID", message: string, readonly details?: { path?: string; chapter?: number }) {
    super(message); this.name = "QaPrerequisiteError";
  }
}

export class QaRepairTargetAmbiguousError extends Error {
  readonly code = "QA_REPAIR_TARGET_AMBIGUOUS";
  constructor(readonly possibleTargets: ("translation" | "narration" | "both")[], message = "Choose whether to repair translation, narration, or both.") {
    super(message); this.name = "QaRepairTargetAmbiguousError";
  }
}

export class QaExceptionTooBroadError extends Error {
  readonly code = "QA_EXCEPTION_TOO_BROAD";
  constructor(message: string) { super(message); this.name = "QaExceptionTooBroadError"; }
}

export class QaPersistenceRollbackError extends AggregateError {
  readonly code = "QA_PERSISTENCE_ROLLBACK_FAILED";
  constructor(errors: unknown[], message: string) { super(errors, message); this.name = "QaPersistenceRollbackError"; }
}
