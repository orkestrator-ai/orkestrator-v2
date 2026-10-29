/**
 * The read-only guard applied to the build pipeline's non-writing turns:
 * Review (one reviewer, or every reviewer of a panel), the panel's
 * consolidation, and Verify.
 *
 * Verify may write ignored compiler output and caches but must not commit or
 * leave Git-visible changes. Reviewers and the consolidator run in provider
 * read-only mode where the provider supports it; the guard is the backstop on
 * every provider. The generic mechanics live in `workspace-read-only-guard.ts`;
 * this module knows only where a pipeline keeps each baseline and which turn a
 * submitted result belongs to.
 *
 * - A single Review or Verify session keeps its baseline in its own session
 *   fields (`build-pipeline-validation-worktree.ts`).
 * - A panel pass keeps one baseline on `reviewFanout.workspaceBaseline`,
 *   captured before any reviewer is dispatched. Reviewers and the consolidator
 *   share the worktree, so they share it too.
 *
 * Sessions and passes recorded before the guard existed have no baseline. A
 * Review without one is not certified (an upgrade must not fail a review in
 * flight); a Verify without one fails, as it always has.
 */
import {
  isBuildPipeline,
  type BuildPipeline,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import type { WorkspaceGitBaseline } from "@orkestrator/protocol/workspace-guard";
import type { WorkflowResultError } from "@orkestrator/protocol/workflow-results";
import type { ObservedWorktreeSnapshot } from "./build-pipeline-prompts.js";
import { sessionForCurrentPhase } from "./build-pipeline-service-helpers.js";
import { sessionWorkspaceBaseline } from "./build-pipeline-validation-worktree.js";
import type { StorageService } from "./storage.js";
import {
  WorkspaceReadOnlyGuard,
  WorkspaceReadOnlyViolationError,
  readOnlyAcceptanceCheck,
  type ReadOnlyGuardSubject,
  type ReadOnlyGuardedAttempt,
  type WorkspaceSnapshotProbe,
} from "./workspace-read-only-guard.js";
import type { WorkflowResultAttempt, WorkflowResultService } from "./workflow-result-service.js";

/** How each guarded pipeline turn is named in errors and refusals. */
export const PIPELINE_READ_ONLY_SUBJECTS = {
  review: { stage: "Review", activity: "review" },
  consolidation: { stage: "Review consolidation", activity: "consolidation" },
  verify: { stage: "Verification", activity: "validation" },
} as const satisfies Record<string, ReadOnlyGuardSubject>;

/** The result kinds whose submissions belong to a guarded pipeline turn. */
const GUARDED_RESULT_KINDS = [
  "review-report",
  "consolidated-review",
  "verification-result",
] as const;

export class BuildPipelineReadOnlyGuard {
  readonly guard: WorkspaceReadOnlyGuard;

  constructor(
    private readonly storage: Pick<StorageService, "listBuildPipelines">,
    probe: WorkspaceSnapshotProbe,
  ) {
    this.guard = new WorkspaceReadOnlyGuard(probe);
  }

  /**
   * Registers the submit-time check for every guarded result kind. Each check
   * judges only the attempt a pipeline is currently waiting on and lets every
   * other attempt of the same kind through, so Multi Review and graph checks
   * registered for the same kinds are unaffected.
   */
  register(workflowResults: Pick<WorkflowResultService, "addAcceptanceCheck">): void {
    const check = readOnlyAcceptanceCheck(this.guard, (attempt) => this.ownedAttempt(attempt));
    for (const kind of GUARDED_RESULT_KINDS) workflowResults.addAcceptanceCheck(kind, check);
  }

  /**
   * Before a single Review or Verify session is created. Throws
   * `WorkspaceBaselineUnavailableError` when the state cannot be observed, so
   * the stage fails without a session or a spent turn.
   */
  async captureSession(
    pipeline: BuildPipeline,
    phase: "review" | "verify",
  ): Promise<ObservedWorktreeSnapshot> {
    return (await this.guard.capture(pipeline.environmentId, PIPELINE_READ_ONLY_SUBJECTS[phase]))
      .snapshot;
  }

  /** Before a panel pass dispatches its first reviewer. Fails closed like {@link captureSession}. */
  async capturePanel(pipeline: BuildPipeline): Promise<WorkspaceGitBaseline> {
    return (await this.guard.capture(pipeline.environmentId, PIPELINE_READ_ONLY_SUBJECTS.review))
      .baseline;
  }

  /**
   * When a single Review or Verify result is consumed. Throws
   * `WorkspaceReadOnlyViolationError`; the supervisor fails the stage with its
   * message and leaves the worktree as the evidence.
   */
  async certifySession(
    pipeline: BuildPipeline,
    session: PipelineSession,
    options: { repairableOnly?: boolean } = {},
  ): Promise<void> {
    const baseline = sessionWorkspaceBaseline(session);
    if (session.phase === "review" && !baseline) return;
    await this.guard.certify(
      pipeline.environmentId,
      baseline,
      session.phase === "review"
        ? PIPELINE_READ_ONLY_SUBJECTS.review
        : PIPELINE_READ_ONLY_SUBJECTS.verify,
      options,
    );
  }

  /**
   * When a panel pass consumes reviewer reports or the consolidated report:
   * the stage error, or null when the worktree still matches (or the pass
   * predates the guard).
   */
  async panelViolation(
    pipeline: BuildPipeline,
    subject: "review" | "consolidation",
  ): Promise<string | null> {
    const baseline = pipeline.reviewFanout?.workspaceBaseline;
    if (!baseline) return null;
    try {
      await this.guard.certify(
        pipeline.environmentId,
        baseline,
        PIPELINE_READ_ONLY_SUBJECTS[subject],
      );
      return null;
    } catch (error) {
      if (error instanceof WorkspaceReadOnlyViolationError) return error.message;
      throw error;
    }
  }

  /** The submit-time refusal for an attempt, or null. Exposed for tests. */
  async acceptanceRefusal(attempt: WorkflowResultAttempt): Promise<WorkflowResultError | null> {
    const owned = await this.ownedAttempt(attempt);
    return owned ? this.guard.refusal(owned.environmentId, owned.baseline, owned.subject) : null;
  }

  /** The guarded turn this attempt belongs to, or null when no pipeline is waiting on it. */
  private async ownedAttempt(
    attempt: WorkflowResultAttempt,
  ): Promise<ReadOnlyGuardedAttempt | null> {
    for (const record of await this.storage.listBuildPipelines(attempt.projectId)) {
      const pipeline = record.snapshot;
      if (record.environmentId !== attempt.environmentId || !isBuildPipeline(pipeline)) continue;
      const owned = ownedByPipeline(pipeline, attempt);
      if (owned) return owned;
    }
    return null;
  }
}

function ownedByPipeline(
  pipeline: BuildPipeline,
  attempt: WorkflowResultAttempt,
): ReadOnlyGuardedAttempt | null {
  const environmentId = pipeline.environmentId;
  if (attempt.kind === "verification-result") {
    if (pipeline.phase !== "verifying") return null;
    const session = sessionForCurrentPhase(pipeline);
    if (session?.phase !== "verify" || session.structuredRequestId !== attempt.resultKey)
      return null;
    return {
      environmentId,
      baseline: sessionWorkspaceBaseline(session),
      subject: PIPELINE_READ_ONLY_SUBJECTS.verify,
    };
  }
  if (pipeline.phase !== "reviewing") return null;
  const panel = pipeline.reviewFanout;
  if (panel) {
    const baseline = panel.workspaceBaseline ?? null;
    if (
      attempt.kind === "review-report" &&
      panel.reviewers.some((reviewer) => reviewer.requestId === attempt.resultKey)
    ) {
      return { environmentId, baseline, subject: PIPELINE_READ_ONLY_SUBJECTS.review };
    }
    if (
      attempt.kind === "consolidated-review" &&
      panel.consolidation?.requestId === attempt.resultKey
    ) {
      return { environmentId, baseline, subject: PIPELINE_READ_ONLY_SUBJECTS.consolidation };
    }
    return null;
  }
  if (attempt.kind !== "review-report") return null;
  const session = sessionForCurrentPhase(pipeline);
  if (session?.phase !== "review" || session.structuredRequestId !== attempt.resultKey) return null;
  return {
    environmentId,
    baseline: sessionWorkspaceBaseline(session),
    subject: PIPELINE_READ_ONLY_SUBJECTS.review,
  };
}
