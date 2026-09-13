export class SourceOperationError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 422 | 502, options?: ErrorOptions) { super(message, options); this.name = "SourceOperationError"; }
}
export class SourceInputError extends SourceOperationError { constructor(message: string, options?: ErrorOptions) { super(message, 400, options); this.name = "SourceInputError"; } }
export class SourceConflictError extends SourceOperationError { constructor(message: string, options?: ErrorOptions) { super(message, 409, options); this.name = "SourceConflictError"; } }
export class SourceValidationError extends SourceOperationError { constructor(message: string, options?: ErrorOptions) { super(message, 422, options); this.name = "SourceValidationError"; } }
export class SourceUpstreamError extends SourceOperationError { constructor(message: string, options?: ErrorOptions) { super(message, 502, options); this.name = "SourceUpstreamError"; } }
