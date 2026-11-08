/**
 * Why a capture, a confined read or a Git scope scan stopped.
 *
 * Every reason a change-tracking step throws is a {@link CaptureError} whose
 * `reason` is one of {@link CAPTURE_ERROR_REASONS}, and readers switch on
 * {@link captureErrorReason}, so a misspelt reason is a type error rather than
 * a silent fall into `capture-failed`. The message is the reason itself, so
 * logs and any reader of `message` see what they saw before.
 *
 * Some reasons travel on as data: `capture-timeout` is also a change error
 * code (`CHANGE_ERROR_CODES` in `@orkestrator/protocol/change-resources`), and
 * a capture's `unavailable` reason or a scope's `unavailableReason` carries
 * the reason string unchanged.
 */
import { Data } from "effect";

export const CAPTURE_ERROR_REASONS = [
  // The capture's deadline or abort signal fired.
  "capture-timeout",
  // Confined reads (`confined-read.ts`).
  "unsupported-platform",
  "unsafe-capture-path",
  "unsafe-capture-ancestor",
  "capture-file-missing",
  "capture-file-unavailable",
  "capture-file-unsupported",
  "capture-file-too-large",
  // The container helper could not run (`capture.ts`).
  "capture-executor-unavailable",
  // The object store's hard budget (`object-store.ts`).
  "capture-storage-quota",
  // Git scope scans (`git-scopes.ts`).
  "runtime-unavailable",
  "baseline-unavailable",
  "head-unavailable",
  "commit-not-found",
  "pull-request-base-unavailable",
] as const;

export type CaptureErrorReason = (typeof CAPTURE_ERROR_REASONS)[number];

/** A capture step stopped for `reason`; the message is the reason. */
export class CaptureError extends Data.TaggedError("CaptureError")<{
  readonly message: string;
  readonly reason: CaptureErrorReason;
}> {
  constructor(reason: CaptureErrorReason) {
    super({ message: reason, reason });
  }
}

/** The reason of a {@link CaptureError}, or `undefined` for any other value. */
export function captureErrorReason(error: unknown): CaptureErrorReason | undefined {
  return error instanceof CaptureError ? error.reason : undefined;
}
