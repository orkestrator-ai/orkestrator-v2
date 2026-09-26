import type { PublicErrorCode, PublicReceipt } from "@orkestrator/protocol/public-api";

/**
 * A failure the client reports with a stable public error code. Messages must
 * never contain credentials, prompt bodies, or file contents.
 */
export class CliError extends Error {
  readonly code: PublicErrorCode;
  readonly details?: Record<string, unknown>;
  readonly receipt?: PublicReceipt;
  readonly retryable?: boolean;
  /** Action label for the error envelope when it differs from the command's. */
  readonly action?: string;

  constructor(
    code: PublicErrorCode,
    message: string,
    options: {
      details?: Record<string, unknown>;
      receipt?: PublicReceipt;
      retryable?: boolean;
      action?: string;
    } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = options.details;
    this.receipt = options.receipt;
    this.retryable = options.retryable;
    this.action = options.action;
  }
}

export function invalidInput(message: string, details?: Record<string, unknown>): CliError {
  return new CliError("invalid-input", message, { details });
}
