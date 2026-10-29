import {
  controlReviewValidation,
  readReviewValidationOutput,
} from "./review-validation-service.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  isMultiReviewReviewerHistoryPageRequest,
  isMultiReviewStepControlInput,
  isMultiReviewReviewerTranscriptRequest,
  isMultiReviewStepTranscriptRequest,
  isRestartMultiReviewStepInput,
  isStartMultiReviewCustomFixInput,
  isStartMultiReviewInput,
  type StartMultiReviewCustomFixInput,
  type StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import {
  asNonBlankString,
  stripWorkflowRendererSecrets,
  stripWorkflowSnapshotSecrets,
} from "./commands-helpers.js";

export function registerReviewWorkflowCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { conditionalManifestSnapshot } = dependencies;
  for (const action of ["start", "status", "cancel"] as const) {
    register(`${action}_review_validation`, ({ environmentId, run }, context) =>
      controlReviewValidation(
        asNonBlankString(environmentId, "environmentId"),
        run,
        action,
        context,
      ),
    );
  }
  register("stop_review_validation_command", ({ environmentId, run, resultId }, context) =>
    controlReviewValidation(
      asNonBlankString(environmentId, "environmentId"),
      run,
      "stop-command",
      context,
      asNonBlankString(resultId, "resultId"),
    ),
  );
  register("get_review_validation_output", ({ environmentId, runId, resultId, known }, context) =>
    readReviewValidationOutput(
      asNonBlankString(environmentId, "environmentId"),
      asNonBlankString(runId, "runId"),
      asNonBlankString(resultId, "resultId"),
      context,
      known,
    ),
  );

  register("get_multi_review_workflow", ({ workflowId }, { storage }) =>
    storage
      .getMultiReviewWorkflow(asNonBlankString(workflowId, "workflowId"))
      .then((record) => (record ? stripWorkflowRendererSecrets(record) : null)),
  );
  register("list_multi_review_workflows", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "multi-review", () =>
      storage
        .listMultiReviewWorkflows(asNonBlankString(args.environmentId, "environmentId"))
        .then((records) => records.map(stripWorkflowRendererSecrets)),
    ),
  );
  register(
    "get_multi_review_reviewer_transcript",
    ({ workflowId, reviewerId, knownSourceToken }, context) => {
      if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
      const request = {
        workflowId: asNonBlankString(workflowId, "workflowId"),
        reviewerId: asNonBlankString(reviewerId, "reviewerId"),
        ...(knownSourceToken === undefined ? {} : { knownSourceToken }),
      };
      // The token is renderer-supplied and forwarded toward a provider, so it
      // is bounded here; the backend still ignores one that is stale or foreign.
      if (!isMultiReviewReviewerTranscriptRequest(request)) {
        throw new Error("Invalid multi review reviewer transcript source token");
      }
      return context.multiReviews.reviewerTranscript(
        request.workflowId,
        request.reviewerId,
        request.knownSourceToken,
      );
    },
  );
  register(
    "get_multi_review_step_transcript",
    ({ workflowId, step, knownSourceToken }, context) => {
      if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
      const request = {
        workflowId: asNonBlankString(workflowId, "workflowId"),
        step,
        ...(knownSourceToken === undefined ? {} : { knownSourceToken }),
      };
      // The step and token are renderer-supplied, and the token is forwarded
      // toward a provider, so both are checked here.
      if (!isMultiReviewStepTranscriptRequest(request)) {
        throw new Error("Invalid multi review step transcript request");
      }
      return context.multiReviews.stepTranscript(
        request.workflowId,
        request.step,
        request.knownSourceToken,
      );
    },
  );
  register("get_multi_review_step_tool_details", ({ workflowId, step, detailRef }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    const request = { workflowId, step };
    if (
      !isMultiReviewStepTranscriptRequest(request) ||
      typeof detailRef !== "string" ||
      detailRef.length === 0 ||
      detailRef.length > 2048
    ) {
      throw new Error("Invalid multi review step tool detail request");
    }
    return context.multiReviews.stepToolDetails(request.workflowId, request.step, detailRef);
  });
  register(
    "get_multi_review_reviewer_tool_details",
    ({ workflowId, reviewerId, detailRef }, context) => {
      if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
      // The reference is renderer-supplied; the service validates its shape
      // and resolves it only against this reviewer's own provider session.
      if (typeof detailRef !== "string" || detailRef.length === 0 || detailRef.length > 2048) {
        throw new Error("Invalid multi review reviewer tool detail reference");
      }
      return context.multiReviews.reviewerToolDetails(
        asNonBlankString(workflowId, "workflowId"),
        asNonBlankString(reviewerId, "reviewerId"),
        detailRef,
      );
    },
  );
  register(
    "get_multi_review_reviewer_history_page",
    ({ workflowId, reviewerId, before, limit, targetBytes }, context) => {
      if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
      // The cursor and bounds are renderer-supplied: the cursor is length-
      // bounded here and resolved only against this reviewer's own session.
      const request = {
        workflowId,
        reviewerId,
        before,
        ...(limit === undefined ? {} : { limit }),
        ...(targetBytes === undefined ? {} : { targetBytes }),
      };
      if (!isMultiReviewReviewerHistoryPageRequest(request)) {
        throw new Error("Invalid multi review reviewer history page request");
      }
      return context.multiReviews.reviewerHistoryPage(
        request.workflowId,
        request.reviewerId,
        request.before,
        {
          ...(request.limit === undefined ? {} : { limit: request.limit }),
          ...(request.targetBytes === undefined ? {} : { targetBytes: request.targetBytes }),
        },
      );
    },
  );
  register("start_multi_review", (args, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isStartMultiReviewInput(args)) throw new Error("Invalid multi review start request");
    return context.multiReviews
      .start(args as unknown as StartMultiReviewInput)
      .then(stripWorkflowSnapshotSecrets);
  });
  register("address_multi_review", async ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    const id = asNonBlankString(workflowId, "workflowId");
    return context.multiReviews.address(id).then(stripWorkflowSnapshotSecrets);
  });
  register("start_multi_review_custom_fix", (args, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isStartMultiReviewCustomFixInput(args)) {
      throw new Error("Invalid Multi Review custom fix request");
    }
    return context.multiReviews
      .customFix(args as unknown as StartMultiReviewCustomFixInput)
      .then(stripWorkflowSnapshotSecrets);
  });
  register("retry_multi_review", ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews
      .retry(asNonBlankString(workflowId, "workflowId"))
      .then(stripWorkflowSnapshotSecrets);
  });
  register(
    "recover_multi_review_fix_session",
    (
      { environmentId, tabId, expectedProviderSessionId, replacementProviderSessionId },
      context,
    ) => {
      if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
      return context.multiReviews
        .recoverFixSession(asNonBlankString(environmentId, "environmentId"), {
          tabId: asNonBlankString(tabId, "tabId"),
          expectedProviderSessionId: asNonBlankString(
            expectedProviderSessionId,
            "expectedProviderSessionId",
          ),
          replacementProviderSessionId: asNonBlankString(
            replacementProviderSessionId,
            "replacementProviderSessionId",
          ),
        })
        .then(stripWorkflowSnapshotSecrets);
    },
  );
  register("stop_multi_review_reviewer", ({ workflowId, reviewerId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews
      .stopReviewer(
        asNonBlankString(workflowId, "workflowId"),
        asNonBlankString(reviewerId, "reviewerId"),
      )
      .then(stripWorkflowSnapshotSecrets);
  });
  register("stop_multi_review_validation", ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews
      .stopValidation(asNonBlankString(workflowId, "workflowId"))
      .then(stripWorkflowSnapshotSecrets);
  });
  register("restart_multi_review_reviewer", ({ workflowId, reviewerId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews
      .restartReviewer(
        asNonBlankString(workflowId, "workflowId"),
        asNonBlankString(reviewerId, "reviewerId"),
      )
      .then(stripWorkflowSnapshotSecrets);
  });
  register("restart_multi_review_step", (args, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isRestartMultiReviewStepInput(args)) {
      throw new Error("Invalid multi review step restart request");
    }
    return context.multiReviews
      .restartStep(args.workflowId, args.kind, args.model)
      .then(stripWorkflowSnapshotSecrets);
  });
  register("pause_multi_review_step", (args, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isMultiReviewStepControlInput(args)) {
      throw new Error("Invalid multi review step pause request");
    }
    return context.multiReviews
      .pauseStep(args.workflowId, args.kind)
      .then(stripWorkflowSnapshotSecrets);
  });
  register("resume_multi_review_step", (args, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isMultiReviewStepControlInput(args)) {
      throw new Error("Invalid multi review step resume request");
    }
    return context.multiReviews
      .resumeStep(args.workflowId, args.kind)
      .then(stripWorkflowSnapshotSecrets);
  });
  register("unstick_multi_review_reviewer", ({ workflowId, reviewerId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews
      .unstickReviewer(
        asNonBlankString(workflowId, "workflowId"),
        asNonBlankString(reviewerId, "reviewerId"),
      )
      .then(stripWorkflowSnapshotSecrets);
  });
  register("cancel_multi_review", ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews
      .cancel(asNonBlankString(workflowId, "workflowId"))
      .then(stripWorkflowSnapshotSecrets);
  });
  register("delete_multi_review_workflow", ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews.close(asNonBlankString(workflowId, "workflowId"));
  });
}
