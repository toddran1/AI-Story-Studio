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

export class QaFindingStaleSelectionError extends Error {
  readonly code = "QA_FINDING_STALE_SELECTION";
  constructor(message = "One or more selected QA findings changed while this repair job was waiting. Reload QA and review the current findings before retrying.") {
    super(message); this.name = "QaFindingStaleSelectionError";
  }
}

export class QaArtifactUnavailableError extends Error {
  readonly code = "QA_ARTIFACT_UNAVAILABLE";
  constructor(readonly artifact: "translation" | "narration", readonly chapter: number) {
    super(`${artifact === "translation" ? "Translation" : "Narration"} artifact is unavailable for Chapter ${chapter}. Restore or regenerate it before repairing findings that target ${artifact}.`);
    this.name = "QaArtifactUnavailableError";
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
