/**
 * The read-only guard's baseline as a single pipeline stage session stores it.
 *
 * The guard itself is generic (`workspace-read-only-guard.ts`). A pipeline
 * session predates it and keeps its baseline in three flat fields
 * (`validationHeadAtStart`, `validationWorktreeStatusAtStart`,
 * `validationUncommittedPathsAtStart`), which snapshots already on disk carry.
 * This module reads and writes those fields and keeps the Verify wording
 * ("validation") its callers and tests have always used.
 */
import type { PipelineSession } from "@orkestrator/protocol/build-pipeline";
import type { WorkflowResultError } from "@orkestrator/protocol/workflow-results";
import type { ObservedWorktreeSnapshot, ReviewWorktreeSnapshot } from "./build-pipeline-prompts.js";
import {
  compareWorkspace,
  readOnlyViolationMessage,
  readOnlyViolationRefusal,
  type WorkspaceBaselineState,
  type WorkspaceChange,
} from "./workspace-read-only-guard.js";

export type ValidationWorktreeChange = WorkspaceChange;

type ValidationBaseline = Pick<
  PipelineSession,
  "validationHeadAtStart" | "validationWorktreeStatusAtStart" | "validationUncommittedPathsAtStart"
>;

/**
 * The HEAD and path set a guarded turn started from, or null when they were
 * not recorded.
 */
export function sessionWorkspaceBaseline(
  session: ValidationBaseline,
): WorkspaceBaselineState | null {
  // A snapshot written before the path list existed still carries a status, and
  // "clean" pins the baseline to the empty set without it. "dirty" does not,
  // so that one case still fails closed rather than guessing.
  const paths =
    session.validationUncommittedPathsAtStart ??
    (session.validationWorktreeStatusAtStart === "clean" ? [] : undefined);
  return session.validationHeadAtStart && paths
    ? { head: session.validationHeadAtStart, paths }
    : null;
}

/** The session fields that persist a baseline observed before dispatch. */
export function sessionWorkspaceBaselineFields(
  snapshot: ObservedWorktreeSnapshot | undefined,
): ValidationBaseline {
  return {
    validationHeadAtStart: snapshot?.head,
    validationWorktreeStatusAtStart: snapshot?.status,
    validationUncommittedPathsAtStart: snapshot
      ? snapshot.status === "dirty"
        ? [...snapshot.paths]
        : []
      : undefined,
  };
}

/** Whether there is anything to compare, so a caller can skip the probe. */
export function hasValidationBaseline(session: ValidationBaseline): boolean {
  return sessionWorkspaceBaseline(session) !== null;
}

/** See `compareWorkspace` for exactly what counts as a change. */
export function compareValidationWorktree(
  session: ValidationBaseline,
  current: ReviewWorktreeSnapshot,
): ValidationWorktreeChange {
  return compareWorkspace(sessionWorkspaceBaseline(session), current);
}

/** The pipeline error for a validation change, or null when it can be certified. */
export function validationWorktreeError(
  stage: string,
  change: ValidationWorktreeChange,
): string | null {
  return readOnlyViolationMessage({ stage, activity: "validation" }, change);
}

/** The correctable tool error for a validation change, or null to accept. */
export function validationWorktreeRefusal(
  change: ValidationWorktreeChange,
): WorkflowResultError | null {
  return readOnlyViolationRefusal({ stage: "Verification", activity: "validation" }, change);
}
