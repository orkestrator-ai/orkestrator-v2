/**
 * Multi Review and review validation commands (plan item 7007, the
 * `multi-review` domain), through the domain client (`multiReview(client)`),
 * so a node that advertises the domain gets typed, enveloped calls and every
 * other node today's calls by name.
 *
 * Controller leases are backend-only. The renderer has no caller for
 * claim/validate/release, and backend-owned records reject renderer writes, so
 * keeping wrappers here would only advertise an API the renderer must not use.
 *
 * Split out of `workflows.ts`, whose `createWorkflowsApi` spreads this API and
 * whose named exports still include these functions.
 */
import { hydrationRequests } from "@/lib/hydration-request-limiter";
import { multiReview } from "@/lib/node-scope/domains/multi-review";
import { asWebModel } from "@/lib/node-scope/domains/native-sessions";
import type { BuildPipelineCodeRewindPreview } from "@orkestrator/protocol/build-pipeline";
import type {
  ReviewValidationOutput,
  ReviewValidationOutputKnown,
  ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import {
  isMultiReviewReviewerHistoryPage,
  type MultiReviewWorkflow as BackendMultiReviewWorkflow,
  type MultiReviewReviewerHistoryPage,
  type MultiReviewReviewerTranscript,
  type MultiReviewStepKind,
  type MultiReviewStepTranscript,
  type StartMultiReviewCustomAddressFindingsInput,
  type StartMultiReviewInput,
  type MultiReviewModelSelection,
  type MultiReviewRewindStep,
  type MultiReviewSkippableStep,
} from "@orkestrator/protocol/multi-review";
import type {
  NativeAgentSessionProjection,
  NativeAgentToolDetails,
} from "@orkestrator/protocol/native-agent";
import type { PersistedWorkflowRecord } from "@/types";
import { isRecord } from "./shared";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * This file's commands on `client`'s node (plan item 3002). `createWorkflowsApi`
 * includes them, so its scoped callers keep one factory.
 */
export function createMultiReviewsApi(client: BackendClient) {
  const domain = () => multiReview(client);

  /**
   * Bounded validation output. With `known` (the size and anchor of the tail the
   * caller holds per stream) a current backend answers only the appended bytes;
   * an older backend ignores it and answers a full tail.
   */
  async function getReviewValidationOutput(
    environmentId: string,
    runId: string,
    resultId: string,
    known?: ReviewValidationOutputKnown,
  ): Promise<ReviewValidationOutput> {
    return domain().get_review_validation_output({
      environmentId,
      runId,
      resultId,
      ...(known && (known.stdout || known.stderr) ? { known } : {}),
    });
  }

  /**
   * Stop one validation command. The environment-owned worker records it as
   * incomplete with its partial output and keeps running the remaining commands.
   */
  async function stopReviewValidationCommand(
    environmentId: string,
    run: ReviewValidationRun,
    resultId: string,
  ): Promise<ReviewValidationRun> {
    return domain().stop_review_validation_command({ environmentId, run, resultId });
  }

  async function startMultiReview(
    input: StartMultiReviewInput,
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().start_multi_review({ ...input });
  }

  async function addressMultiReviewFindings(
    workflowId: string,
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().address_multi_review({ workflowId });
  }

  async function startMultiReviewCustomAddressFindings(
    input: StartMultiReviewCustomAddressFindingsInput,
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().start_multi_review_custom_fix({ ...input });
  }

  async function retryMultiReview(workflowId: string): Promise<BackendMultiReviewWorkflow> {
    return domain().retry_multi_review({ workflowId });
  }

  async function recoverMultiReviewAddressFindingsSession(input: {
    environmentId: string;
    tabId: string;
    expectedProviderSessionId: string;
    replacementProviderSessionId: string;
  }): Promise<BackendMultiReviewWorkflow> {
    return domain().recover_multi_review_fix_session(input);
  }

  async function cancelMultiReview(workflowId: string): Promise<BackendMultiReviewWorkflow> {
    return domain().cancel_multi_review({ workflowId });
  }

  /**
   * Retire one reviewer and let the review continue without it. The backend
   * aborts that reviewer's session best-effort and consolidates from whatever the
   * remaining reviewers produced.
   */
  async function stopMultiReviewReviewer(
    workflowId: string,
    reviewerId: string,
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().stop_multi_review_reviewer({ workflowId, reviewerId });
  }

  /** Stop validation commands and continue Multi Review with the evidence collected so far. */
  async function stopMultiReviewValidation(
    workflowId: string,
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().stop_multi_review_validation({ workflowId });
  }

  /** A `model` is "Restart in…": the reviewer runs on it from now on. */
  async function restartMultiReviewReviewer(
    workflowId: string,
    reviewerId: string,
    model?: MultiReviewModelSelection,
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().restart_multi_review_reviewer({
      workflowId,
      reviewerId,
      ...(model ? { model } : {}),
    });
  }

  /** Moves on without a step's result: the reviewers still working, or Address Findings. */
  async function skipMultiReviewStep(
    workflowId: string,
    step: MultiReviewSkippableStep,
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().skip_multi_review_step({ workflowId, step });
  }

  /** What "Rewind code to here" on a step would drop, and why it cannot run now, if it cannot. */
  async function previewMultiReviewCodeRewind(
    workflowId: string,
    step: MultiReviewRewindStep,
  ): Promise<BuildPipelineCodeRewindPreview> {
    return domain().preview_multi_review_code_rewind({ workflowId, step });
  }

  /** Resets the worktree to the commit a step started from and restarts that step. */
  async function rewindMultiReviewCode(
    workflowId: string,
    step: MultiReviewRewindStep,
    expectedHead: string,
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().rewind_multi_review_code({ workflowId, step, expectedHead });
  }

  async function restartMultiReviewStep(
    workflowId: string,
    kind: "prepare" | "consolidate" | "fix",
    model?: BackendMultiReviewWorkflow["fixModel"],
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().restart_multi_review_step({
      workflowId,
      kind,
      ...(model ? { model } : {}),
    });
  }

  async function pauseMultiReviewStep(
    workflowId: string,
    kind: "prepare" | "consolidate" | "fix",
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().pause_multi_review_step({ workflowId, kind });
  }

  async function resumeMultiReviewStep(
    workflowId: string,
    kind: "prepare" | "consolidate" | "fix",
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().resume_multi_review_step({ workflowId, kind });
  }

  async function unstickMultiReviewReviewer(
    workflowId: string,
    reviewerId: string,
  ): Promise<BackendMultiReviewWorkflow> {
    return domain().unstick_multi_review_reviewer({ workflowId, reviewerId });
  }

  async function getMultiReviewWorkflow<T = unknown>(
    workflowId: string,
  ): Promise<PersistedWorkflowRecord<T> | null> {
    // Without `knownRevision` the answer is the record or `null`.
    return asWebModel<PersistedWorkflowRecord<T> | null>(
      domain().get_multi_review_workflow({ workflowId }),
    );
  }

  /**
   * `unchanged` when the record is still at `knownRevision`, otherwise the
   * record. A backend that predates the conditional read ignores the revision
   * and always answers with the record.
   */
  async function getMultiReviewWorkflowConditional<T = unknown>(
    workflowId: string,
    knownRevision?: number,
  ): Promise<{ unchanged: true; revision: number } | PersistedWorkflowRecord<T> | null> {
    const response: unknown = await domain().get_multi_review_workflow({
      workflowId,
      ...(knownRevision === undefined ? {} : { knownRevision }),
    });
    if (response === null || response === undefined) return null;
    if (
      isRecord(response) &&
      response.unchanged === true &&
      Number.isSafeInteger(response.revision) &&
      (response.revision as number) >= 0
    ) {
      return response as { unchanged: true; revision: number };
    }
    if (!isRecord(response) || "unchanged" in response || typeof response.id !== "string") {
      throw new Error("Invalid get_multi_review_workflow response");
    }
    return response as unknown as PersistedWorkflowRecord<T>;
  }

  async function listMultiReviewWorkflows<T = unknown>(
    environmentId: string,
  ): Promise<Array<PersistedWorkflowRecord<T>>> {
    // Without a manifest generation the answer is the record list.
    return hydrationRequests.run(() =>
      asWebModel<Array<PersistedWorkflowRecord<T>>>(
        domain().list_multi_review_workflows({ environmentId }),
      ),
    );
  }

  /**
   * Reads a bounded reviewer transcript tail. Passing the previous response's
   * `sourceToken` lets the backend answer `transcript: "unchanged"` with no
   * messages when nothing moved; the caller then keeps what it already shows.
   */
  async function getMultiReviewReviewerTranscript(
    workflowId: string,
    reviewerId: string,
    options: { knownSourceToken?: string } = {},
  ): Promise<MultiReviewReviewerTranscript> {
    return domain().get_multi_review_reviewer_transcript({
      workflowId,
      reviewerId,
      ...(options.knownSourceToken ? { knownSourceToken: options.knownSourceToken } : {}),
    });
  }

  /**
   * Reads a bounded tail of a preparation, consolidation or Fix session, with
   * the reviewer transcript's conditional `knownSourceToken` contract.
   */
  async function getMultiReviewStepTranscript(
    workflowId: string,
    step: MultiReviewStepKind,
    options: { knownSourceToken?: string } = {},
  ): Promise<MultiReviewStepTranscript> {
    return domain().get_multi_review_step_transcript({
      workflowId,
      step,
      ...(options.knownSourceToken ? { knownSourceToken: options.knownSourceToken } : {}),
    });
  }

  /** The body behind a step row, resolved against its authoritative owned session. */
  async function getMultiReviewStepToolDetails(
    workflowId: string,
    step: MultiReviewStepKind,
    detailRef: string,
  ): Promise<NativeAgentToolDetails> {
    return asWebModel<NativeAgentToolDetails>(
      domain().get_multi_review_step_tool_details({ workflowId, step, detailRef }),
    );
  }

  /** The body behind a reviewer row's deferred `detailRef`, read on expansion. */
  async function getMultiReviewReviewerToolDetails(
    workflowId: string,
    reviewerId: string,
    detailRef: string,
  ): Promise<NativeAgentToolDetails> {
    return asWebModel<NativeAgentToolDetails>(
      domain().get_multi_review_reviewer_tool_details({ workflowId, reviewerId, detailRef }),
    );
  }

  /**
   * Reviewer history before `before` (a transcript `historyCursor` or a page's
   * `nextCursor`). An answer outside the protocol's bounds is refused rather
   * than rendered.
   */
  async function getMultiReviewReviewerHistoryPage(
    workflowId: string,
    reviewerId: string,
    options: { before: string; limit?: number; targetBytes?: number },
  ): Promise<MultiReviewReviewerHistoryPage> {
    const page: unknown = await domain().get_multi_review_reviewer_history_page({
      workflowId,
      reviewerId,
      before: options.before,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.targetBytes === undefined ? {} : { targetBytes: options.targetBytes }),
    });
    if (!isMultiReviewReviewerHistoryPage(page)) {
      throw new Error("The reviewer history page was malformed");
    }
    return page;
  }

  async function deleteMultiReviewWorkflow(workflowId: string): Promise<void> {
    return domain().delete_multi_review_workflow({ workflowId });
  }

  /**
   * Resolve one Multi Review reviewer's provider session through the native
   * projection, as `getBuildPipelineSessionProjection` does for a stage.
   * The backend finds the session from the persisted workflow.
   */
  async function getMultiReviewReviewerProjection<TMessage = unknown>(input: {
    workflowId: string;
    reviewerId: string;
    refreshUsage?: boolean;
  }): Promise<NativeAgentSessionProjection<TMessage> | null> {
    return asWebModel<NativeAgentSessionProjection<TMessage> | null>(
      domain().get_multi_review_reviewer_projection(input),
    );
  }

  return {
    getReviewValidationOutput,
    stopReviewValidationCommand,
    startMultiReview,
    addressMultiReviewFindings,
    startMultiReviewCustomAddressFindings,
    retryMultiReview,
    recoverMultiReviewAddressFindingsSession,
    cancelMultiReview,
    stopMultiReviewReviewer,
    stopMultiReviewValidation,
    restartMultiReviewReviewer,
    skipMultiReviewStep,
    previewMultiReviewCodeRewind,
    rewindMultiReviewCode,
    restartMultiReviewStep,
    pauseMultiReviewStep,
    resumeMultiReviewStep,
    unstickMultiReviewReviewer,
    getMultiReviewWorkflow,
    getMultiReviewWorkflowConditional,
    listMultiReviewWorkflows,
    getMultiReviewReviewerTranscript,
    getMultiReviewStepTranscript,
    getMultiReviewStepToolDetails,
    getMultiReviewReviewerToolDetails,
    getMultiReviewReviewerHistoryPage,
    deleteMultiReviewWorkflow,
    getMultiReviewReviewerProjection,
  };
}

export type MultiReviewsApi = ReturnType<typeof createMultiReviewsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getReviewValidationOutput,
  stopReviewValidationCommand,
  startMultiReview,
  addressMultiReviewFindings,
  startMultiReviewCustomAddressFindings,
  retryMultiReview,
  recoverMultiReviewAddressFindingsSession,
  cancelMultiReview,
  stopMultiReviewReviewer,
  stopMultiReviewValidation,
  restartMultiReviewReviewer,
  skipMultiReviewStep,
  previewMultiReviewCodeRewind,
  rewindMultiReviewCode,
  restartMultiReviewStep,
  pauseMultiReviewStep,
  resumeMultiReviewStep,
  unstickMultiReviewReviewer,
  getMultiReviewWorkflow,
  getMultiReviewWorkflowConditional,
  listMultiReviewWorkflows,
  getMultiReviewReviewerTranscript,
  getMultiReviewStepTranscript,
  getMultiReviewStepToolDetails,
  getMultiReviewReviewerToolDetails,
  getMultiReviewReviewerHistoryPage,
  deleteMultiReviewWorkflow,
  getMultiReviewReviewerProjection,
} = createMultiReviewsApi(commandBackendClient);
