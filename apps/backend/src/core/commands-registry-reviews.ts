import {
  controlReviewValidation,
  readReviewValidationOutput,
} from "./review-validation-service.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import type { RendererWorkflowRecord } from "./commands-terminal.js";
import {
  addressMultiReviewCommand,
  cancelMultiReviewCommand,
  cancelReviewValidationCommand,
  deleteMultiReviewWorkflowCommand,
  getMultiReviewReviewerHistoryPageCommand,
  getMultiReviewReviewerProjectionCommand,
  getMultiReviewReviewerToolDetailsCommand,
  getMultiReviewReviewerTranscriptCommand,
  getMultiReviewStepToolDetailsCommand,
  getMultiReviewStepTranscriptCommand,
  getMultiReviewWorkflowCommand,
  getReviewValidationOutputCommand,
  listMultiReviewWorkflowsCommand,
  pauseMultiReviewStepCommand,
  previewMultiReviewCodeRewindCommand,
  recoverMultiReviewFixSessionCommand,
  restartMultiReviewReviewerCommand,
  restartMultiReviewStepCommand,
  resumeMultiReviewStepCommand,
  retryMultiReviewCommand,
  rewindMultiReviewCodeCommand,
  skipMultiReviewStepCommand,
  startMultiReviewCommand,
  startMultiReviewCustomFixCommand,
  startReviewValidationCommand,
  statusReviewValidationCommand,
  stopMultiReviewReviewerCommand,
  stopMultiReviewValidationCommand,
  stopReviewValidationCommandCommand,
  unstickMultiReviewReviewerCommand,
} from "@orkestrator/protocol/contract/domains/multi-review";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { canonicalMultiReview } from "@orkestrator/protocol/workflow-vocabulary";
import {
  isMultiReviewReviewerHistoryPageRequest,
  isMultiReviewWorkflow,
  isMultiReviewStepControlInput,
  isMultiReviewReviewerTranscriptRequest,
  isMultiReviewStepTranscriptRequest,
  isMultiReviewModelSelection,
  isMultiReviewRewindStep,
  isMultiReviewSkippableStep,
  isRestartMultiReviewStepInput,
  isStartMultiReviewCustomAddressFindingsInput,
  isStartMultiReviewInput,
  type StartMultiReviewCustomAddressFindingsInput,
  type StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import {
  asNonBlankString,
  asRequiredBoolean,
  stripWorkflowRendererSecrets,
  stripWorkflowSnapshotSecrets,
} from "./commands-helpers.js";

export function registerReviewWorkflowCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { conditionalManifestSnapshot } = dependencies;
  for (const [def, action] of [
    [startReviewValidationCommand, "start"],
    [statusReviewValidationCommand, "status"],
    [cancelReviewValidationCommand, "cancel"],
  ] as const) {
    register(def, ({ environmentId, run }, context) =>
      controlReviewValidation(
        asNonBlankString(environmentId, "environmentId"),
        run,
        action,
        context,
      ),
    );
  }
  register(stopReviewValidationCommandCommand, ({ environmentId, run, resultId }, context) =>
    controlReviewValidation(
      asNonBlankString(environmentId, "environmentId"),
      run,
      "stop-command",
      context,
      asNonBlankString(resultId, "resultId"),
    ),
  );
  register(getReviewValidationOutputCommand, ({ environmentId, runId, resultId, known }, context) =>
    readReviewValidationOutput(
      asNonBlankString(environmentId, "environmentId"),
      asNonBlankString(runId, "runId"),
      asNonBlankString(resultId, "resultId"),
      context,
      known,
    ),
  );

  /*
   * `knownRevision` makes the read conditional, as `get_build_pipeline` is: a
   * client already holding the record at that revision gets `unchanged`
   * instead of the whole record again. Every open window re-reads on each
   * change event, so the full answer would otherwise go out once per window.
   */
  register(getMultiReviewWorkflowCommand, ({ workflowId, knownRevision }, { storage }) =>
    storage.getMultiReviewWorkflow(asNonBlankString(workflowId, "workflowId")).then((record) => {
      if (!record) return null;
      if (Number.isSafeInteger(knownRevision) && knownRevision === record.revision) {
        return { unchanged: true, revision: record.revision };
      }
      return stripWorkflowRendererSecrets(record);
    }),
  );
  register(listMultiReviewWorkflowsCommand, (args, { storage }) =>
    conditionalManifestSnapshot<RendererWorkflowRecord[]>(args, storage, "multi-review", () =>
      storage
        .listMultiReviewWorkflows(asNonBlankString(args.environmentId, "environmentId"))
        .then((records) => records.map(stripWorkflowRendererSecrets)),
    ),
  );
  register(
    getMultiReviewReviewerTranscriptCommand,
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
  /*
   * The agent-information panel for a reviewer tab. Like a build stage, the
   * workflow owns the session's identity and lifecycle, so it is inspected
   * transiently rather than adopted as a native-agent session.
   */
  register(
    getMultiReviewReviewerProjectionCommand,
    async ({ workflowId, reviewerId, refreshUsage }, context) => {
      if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
      const id = asNonBlankString(workflowId, "workflowId");
      const reviewerKey = asNonBlankString(reviewerId, "reviewerId");
      const shouldRefreshUsage =
        refreshUsage === undefined ? undefined : asRequiredBoolean(refreshUsage, "refreshUsage");
      const record = await context.storage.getMultiReviewWorkflow(id);
      if (!record || !isMultiReviewWorkflow(record.snapshot)) {
        throw new Error("Multi review workflow is unavailable");
      }
      const workflow = record.snapshot;
      const reviewer = workflow.reviewers.find((entry) => entry.id === reviewerKey);
      if (!reviewer?.providerSessionId) throw new Error("Multi review reviewer is unavailable");
      return context.nativeAgents.inspectSession({
        environmentId: workflow.environmentId,
        agent: reviewer.agent,
        // The key the supervisor dispatches a reviewer under when it has not rotated one.
        logicalSessionKey:
          reviewer.sessionKey ?? `multi-review:${workflow.id}:reviewer:${reviewer.id}`,
        providerSessionId: reviewer.providerSessionId,
        origin: "automated-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        phase: "review",
        refreshUsage: shouldRefreshUsage,
      });
    },
  );
  register(
    getMultiReviewStepTranscriptCommand,
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
  register(getMultiReviewStepToolDetailsCommand, ({ workflowId, step, detailRef }, context) => {
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
    getMultiReviewReviewerToolDetailsCommand,
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
    getMultiReviewReviewerHistoryPageCommand,
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
  register(startMultiReviewCommand, (rawArgs, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    const args = canonicalMultiReview(rawArgs);
    if (!isStartMultiReviewInput(args)) throw new Error("Invalid multi review start request");
    return context.multiReviews
      .start(args as unknown as StartMultiReviewInput)
      .then(stripWorkflowSnapshotSecrets);
  });
  register(addressMultiReviewCommand, async ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    const id = asNonBlankString(workflowId, "workflowId");
    return context.multiReviews.address(id).then(stripWorkflowSnapshotSecrets);
  });
  register(startMultiReviewCustomFixCommand, (rawArgs, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    const args = canonicalMultiReview(rawArgs);
    if (!isStartMultiReviewCustomAddressFindingsInput(args)) {
      throw new Error("Invalid Multi Review custom fix request");
    }
    return context.multiReviews
      .customAddressFindings(args as unknown as StartMultiReviewCustomAddressFindingsInput)
      .then(stripWorkflowSnapshotSecrets);
  });
  register(retryMultiReviewCommand, ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews
      .retry(asNonBlankString(workflowId, "workflowId"))
      .then(stripWorkflowSnapshotSecrets);
  });
  register(
    recoverMultiReviewFixSessionCommand,
    (
      { environmentId, tabId, expectedProviderSessionId, replacementProviderSessionId },
      context,
    ) => {
      if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
      return context.multiReviews
        .recoverAddressFindingsSession(asNonBlankString(environmentId, "environmentId"), {
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
  register(stopMultiReviewReviewerCommand, ({ workflowId, reviewerId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews
      .stopReviewer(
        asNonBlankString(workflowId, "workflowId"),
        asNonBlankString(reviewerId, "reviewerId"),
      )
      .then(stripWorkflowSnapshotSecrets);
  });
  register(stopMultiReviewValidationCommand, ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews
      .stopValidation(asNonBlankString(workflowId, "workflowId"))
      .then(stripWorkflowSnapshotSecrets);
  });
  register(restartMultiReviewReviewerCommand, ({ workflowId, reviewerId, model }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (model !== undefined && !isMultiReviewModelSelection(model)) {
      throw new Error("Invalid multi review reviewer model");
    }
    return context.multiReviews
      .restartReviewer(
        asNonBlankString(workflowId, "workflowId"),
        asNonBlankString(reviewerId, "reviewerId"),
        model,
      )
      .then(stripWorkflowSnapshotSecrets);
  });
  register(skipMultiReviewStepCommand, ({ workflowId, step }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isMultiReviewSkippableStep(step)) throw new Error("Invalid multi review step");
    return context.multiReviews
      .skipStep(asNonBlankString(workflowId, "workflowId"), step)
      .then(stripWorkflowSnapshotSecrets);
  });
  register(previewMultiReviewCodeRewindCommand, ({ workflowId, step }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isMultiReviewRewindStep(step)) throw new Error("Invalid multi review step");
    return context.multiReviews.previewCodeRewind(asNonBlankString(workflowId, "workflowId"), step);
  });
  register(rewindMultiReviewCodeCommand, ({ workflowId, step, expectedHead }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isMultiReviewRewindStep(step)) throw new Error("Invalid multi review step");
    return context.multiReviews
      .rewindCode(
        asNonBlankString(workflowId, "workflowId"),
        step,
        asNonBlankString(expectedHead, "expectedHead"),
      )
      .then(stripWorkflowSnapshotSecrets);
  });
  register(restartMultiReviewStepCommand, (args, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isRestartMultiReviewStepInput(args)) {
      throw new Error("Invalid multi review step restart request");
    }
    return context.multiReviews
      .restartStep(args.workflowId, args.kind, args.model)
      .then(stripWorkflowSnapshotSecrets);
  });
  register(pauseMultiReviewStepCommand, (args, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isMultiReviewStepControlInput(args)) {
      throw new Error("Invalid multi review step pause request");
    }
    return context.multiReviews
      .pauseStep(args.workflowId, args.kind)
      .then(stripWorkflowSnapshotSecrets);
  });
  register(resumeMultiReviewStepCommand, (args, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isMultiReviewStepControlInput(args)) {
      throw new Error("Invalid multi review step resume request");
    }
    return context.multiReviews
      .resumeStep(args.workflowId, args.kind)
      .then(stripWorkflowSnapshotSecrets);
  });
  register(unstickMultiReviewReviewerCommand, ({ workflowId, reviewerId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews
      .unstickReviewer(
        asNonBlankString(workflowId, "workflowId"),
        asNonBlankString(reviewerId, "reviewerId"),
      )
      .then(stripWorkflowSnapshotSecrets);
  });
  register(cancelMultiReviewCommand, ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews
      .cancel(asNonBlankString(workflowId, "workflowId"))
      .then(stripWorkflowSnapshotSecrets);
  });
  register(deleteMultiReviewWorkflowCommand, ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews.close(asNonBlankString(workflowId, "workflowId"));
  });
}
