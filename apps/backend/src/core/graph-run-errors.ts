/**
 * The typed refusals of graph run storage (plan P2.1).
 *
 * Every bound a writer can overrun is refused with its own
 * {@link GraphRunLimitCode} and the limit and amount asked for, so the
 * runtime (202–213) can fail an activation or a run with an exact reason
 * instead of a generic storage error. Messages are content-free: ids,
 * counts and bytes only, never payloads.
 */
import type { GraphRunLimitCode, GraphRunLimitViolation } from "@orkestrator/protocol/graphs/run";

export type GraphStorageErrorCode =
  | GraphRunLimitCode
  /** The record changed since the caller read it (compare-and-swap). */
  | "revision-conflict"
  | "run-exists"
  | "run-not-found"
  /** The record fails its guard; `issues` names the first problems. */
  | "invalid-run"
  /** The plan is frozen at launch; a save may not change it. */
  | "plan-changed"
  /** Written by a newer build: this one refuses rather than misreads it. */
  | "newer-format"
  | "environment-not-found"
  /** The environment is being deleted; nothing new is written for it. */
  | "environment-deleting"
  | "invalid-artifact"
  /** An artifact with this id exists with other content: artifacts are never overwritten. */
  | "artifact-conflict"
  | "artifact-not-found";

export class GraphStorageError extends Error {
  readonly code: GraphStorageErrorCode;
  readonly limit?: number;
  readonly actual?: number;
  /** Field paths and codes of a refused record, at most 8; never values. */
  readonly issues?: readonly string[];

  constructor(
    code: GraphStorageErrorCode,
    message: string,
    details: { limit?: number; actual?: number; issues?: readonly string[] } = {},
  ) {
    super(message);
    this.name = "GraphStorageError";
    this.code = code;
    if (details.limit !== undefined) this.limit = details.limit;
    if (details.actual !== undefined) this.actual = details.actual;
    if (details.issues !== undefined) this.issues = details.issues.slice(0, 8);
  }

  static limit(violation: GraphRunLimitViolation): GraphStorageError {
    return new GraphStorageError(violation.code, violation.message, {
      limit: violation.limit,
      actual: violation.actual,
    });
  }
}

export function isGraphStorageError(
  error: unknown,
  code?: GraphStorageErrorCode,
): error is GraphStorageError {
  return error instanceof GraphStorageError && (code === undefined || error.code === code);
}
