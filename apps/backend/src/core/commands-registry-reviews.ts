import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import { INTERACTIVE_AGENT_INTERACTION_POLICY, LOOPED_REVIEW_WORKFLOW_VERSION, isLoopedReviewTerminalPhase, isLoopedReviewWorkflow, isStartLoopedReviewInput, MULTI_REVIEW_ADDRESS_PROMPT, isMultiReviewTerminalPhase, isMultiReviewWorkflow, isStartMultiReviewInput } from "./commands-dependencies.js";
import type { StartLoopedReviewInput, StartMultiReviewInput } from "./commands-dependencies.js";
import { asString, asNumber, asNonBlankString, stripLoopedReviewRendererSecrets, stripLoopedReviewSnapshotSecrets } from "./commands-helpers.js";

export function registerReviewWorkflowCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  const { conditionalManifestSnapshot } = dependencies;
  register("get_looped_review_workflow", ({ workflowId }, { storage }) =>
    storage.getLoopedReviewWorkflow(asString(workflowId, "workflowId"))
      .then((workflow) => workflow ? stripLoopedReviewRendererSecrets(workflow) : null),
  );
  register("list_looped_review_workflows", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "looped-review", () =>
      storage.listLoopedReviewWorkflows(asString(args.environmentId, "environmentId"))
        .then((workflows) => workflows.map(stripLoopedReviewRendererSecrets))
    ),
  );
  register(
    "save_looped_review_workflow",
    async ({
      workflowId,
      environmentId,
      version,
      snapshot,
      expectedRevision,
      controllerOwnerId,
      controllerToken,
    }, { storage }) => {
      const parsedWorkflowId = asString(workflowId, "workflowId");
      const parsedVersion = asNumber(version, "version");
      // A renderer may never write a v2 record, and the stored-version half of
      // the guard runs inside the storage mutation queue: checking it here would
      // be a read-then-act that a concurrent backend adoption can overtake,
      // letting a legacy write land on an adopted backend-owned snapshot.
      if (parsedVersion >= LOOPED_REVIEW_WORKFLOW_VERSION) {
        throw new Error("Backend-owned looped reviews can only be changed through workflow commands");
      }
      return storage.saveLoopedReviewWorkflow(
        parsedWorkflowId,
        asString(environmentId, "environmentId"),
        parsedVersion,
        snapshot,
        expectedRevision === undefined
          ? undefined
          : asNumber(expectedRevision, "expectedRevision"),
        controllerOwnerId === undefined && controllerToken === undefined
          ? undefined
          : {
              ownerId: asNonBlankString(controllerOwnerId, "controllerOwnerId"),
              token: asNonBlankString(controllerToken, "controllerToken"),
            },
        { rejectStoredVersionAtLeast: LOOPED_REVIEW_WORKFLOW_VERSION },
      );
    },
  );
  register(
    "claim_looped_review_controller",
    async ({ workflowId, ownerId, leaseMs }, { storage }) => {
      const parsedWorkflowId = asNonBlankString(workflowId, "workflowId");
      const current = await storage.getLoopedReviewWorkflow(parsedWorkflowId);
      if ((current?.version ?? 0) >= LOOPED_REVIEW_WORKFLOW_VERSION) {
        throw new Error("Backend-owned looped-review controller leases are not available to renderers");
      }
      return storage.claimLoopedReviewController(
        parsedWorkflowId,
        asNonBlankString(ownerId, "ownerId"),
        asNumber(leaseMs, "leaseMs"),
      );
    },
  );
  register(
    "validate_looped_review_controller",
    async ({ workflowId, ownerId, token }, { storage }) => {
      const parsedWorkflowId = asNonBlankString(workflowId, "workflowId");
      const current = await storage.getLoopedReviewWorkflow(parsedWorkflowId);
      if ((current?.version ?? 0) >= LOOPED_REVIEW_WORKFLOW_VERSION) {
        throw new Error("Backend-owned looped-review controller leases are not available to renderers");
      }
      return storage.validateLoopedReviewController(
        parsedWorkflowId,
        asNonBlankString(ownerId, "ownerId"),
        asNonBlankString(token, "token"),
      );
    },
  );
  register(
    "release_looped_review_controller",
    async ({ workflowId, ownerId, token }, { storage }) => {
      const parsedWorkflowId = asNonBlankString(workflowId, "workflowId");
      const current = await storage.getLoopedReviewWorkflow(parsedWorkflowId);
      if ((current?.version ?? 0) >= LOOPED_REVIEW_WORKFLOW_VERSION) {
        throw new Error("Backend-owned looped-review controller leases are not available to renderers");
      }
      return storage.releaseLoopedReviewController(
        parsedWorkflowId,
        asNonBlankString(ownerId, "ownerId"),
        asNonBlankString(token, "token"),
      );
    },
  );
  register("delete_looped_review_workflow", async ({ workflowId }, { storage }) => {
    const parsedWorkflowId = asString(workflowId, "workflowId");
    const current = await storage.getLoopedReviewWorkflow(parsedWorkflowId);
    // Gated on the stored *version*, like the three controller commands. Gating
    // on whether the snapshot parses would fail open for a backend-owned record
    // whose snapshot is unreadable — exactly the record most likely to have a
    // live supervisor still driving it.
    if (current && (current.version ?? 0) >= LOOPED_REVIEW_WORKFLOW_VERSION
      && !(isLoopedReviewWorkflow(current.snapshot)
        && isLoopedReviewTerminalPhase(current.snapshot.phase))) {
      throw new Error("An active backend-owned looped review must be cancelled before deletion");
    }
    return storage.deleteLoopedReviewWorkflow(parsedWorkflowId);
  });
  register("start_looped_review", (args, context) => {
    if (!context.loopedReviews) throw new Error("Looped review supervisor is unavailable");
    if (!isStartLoopedReviewInput(args)) throw new Error("Invalid looped review start request");
    return context.loopedReviews.start(args as StartLoopedReviewInput)
      .then(stripLoopedReviewSnapshotSecrets);
  });
  register("pause_looped_review", ({ workflowId }, context) => {
    if (!context.loopedReviews) throw new Error("Looped review supervisor is unavailable");
    return context.loopedReviews.pause(asNonBlankString(workflowId, "workflowId"))
      .then(stripLoopedReviewSnapshotSecrets);
  });
  register("resume_looped_review", ({ workflowId }, context) => {
    if (!context.loopedReviews) throw new Error("Looped review supervisor is unavailable");
    return context.loopedReviews.resume(asNonBlankString(workflowId, "workflowId"))
      .then(stripLoopedReviewSnapshotSecrets);
  });
  register("retry_looped_review", ({ workflowId }, context) => {
    if (!context.loopedReviews) throw new Error("Looped review supervisor is unavailable");
    return context.loopedReviews.retry(asNonBlankString(workflowId, "workflowId"))
      .then(stripLoopedReviewSnapshotSecrets);
  });
  register("cancel_looped_review", ({ workflowId }, context) => {
    if (!context.loopedReviews) throw new Error("Looped review supervisor is unavailable");
    return context.loopedReviews.cancel(asNonBlankString(workflowId, "workflowId"))
      .then(stripLoopedReviewSnapshotSecrets);
  });
  register("get_looped_review_provider_session", ({ workflowId, sessionId }, context) => {
    if (!context.loopedReviews) throw new Error("Looped review supervisor is unavailable");
    return context.loopedReviews.providerSession(
      asNonBlankString(workflowId, "workflowId"),
      sessionId === undefined ? undefined : asNonBlankString(sessionId, "sessionId"),
    );
  });

  register("get_multi_review_workflow", ({ workflowId }, { storage }) =>
    storage.getMultiReviewWorkflow(asNonBlankString(workflowId, "workflowId"))
      .then((record) => record ? stripLoopedReviewRendererSecrets(record) : null),
  );
  register("list_multi_review_workflows", (args, { storage }) =>
    conditionalManifestSnapshot(args, storage, "multi-review", () =>
      storage.listMultiReviewWorkflows(asNonBlankString(args.environmentId, "environmentId"))
        .then((records) => records.map(stripLoopedReviewRendererSecrets))),
  );
  register("get_multi_review_reviewer_transcript", ({ workflowId, reviewerId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews.reviewerTranscript(
      asNonBlankString(workflowId, "workflowId"),
      asNonBlankString(reviewerId, "reviewerId"),
    );
  });
  register("start_multi_review", (args, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    if (!isStartMultiReviewInput(args)) throw new Error("Invalid multi review start request");
    return context.multiReviews.start(args as unknown as StartMultiReviewInput)
      .then(stripLoopedReviewSnapshotSecrets);
  });
  register("address_multi_review", async ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    const id = asNonBlankString(workflowId, "workflowId");
    let workflow = await context.multiReviews.address(id);
    if (workflow.addressPromptPending !== true) {
      return stripLoopedReviewSnapshotSecrets(workflow);
    }
    if (!context.nativeAgents) throw new Error("Native agent service is unavailable");
    const session = workflow.fixSession;
    if (!session) throw new Error("The consolidation session is no longer available");
    const logicalSessionKey = `multi-review:${workflow.id}:interactive`;
    const model = workflow.fixModel.model === "default"
      ? undefined
      : workflow.fixModel.model;
    await context.nativeAgents.adoptSession({
      environmentId: workflow.environmentId,
      agent: workflow.fixModel.agent,
      logicalSessionKey,
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      providerSessionId: session.providerSessionId,
      title: "Multi Review · Fix",
      model,
      reasoningEffort: workflow.fixModel.reasoningEffort,
      phase: "fix",
      sessionMode: "build",
    });
    const outcome = await context.nativeAgents.dispatchIntent({
      environmentId: workflow.environmentId,
      agent: workflow.fixModel.agent,
      logicalSessionKey,
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      title: "Multi Review · Fix",
      model,
      reasoningEffort: workflow.fixModel.reasoningEffort,
      phase: "fix",
      prompt: MULTI_REVIEW_ADDRESS_PROMPT,
      requestId: `multi-review-address:${workflow.id}`,
      mode: "build",
    });
    if (outcome.outcome !== "accepted") {
      throw new Error(outcome.error ?? "The address prompt dispatch was not confirmed");
    }
    workflow = await context.multiReviews.acknowledgeAddressPrompt(id);
    return stripLoopedReviewSnapshotSecrets(workflow);
  });
  register("retry_multi_review", ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews.retry(asNonBlankString(workflowId, "workflowId"))
      .then(stripLoopedReviewSnapshotSecrets);
  });
  register("stop_multi_review_reviewer", ({ workflowId, reviewerId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews.stopReviewer(
      asNonBlankString(workflowId, "workflowId"),
      asNonBlankString(reviewerId, "reviewerId"),
    ).then(stripLoopedReviewSnapshotSecrets);
  });
  register("cancel_multi_review", ({ workflowId }, context) => {
    if (!context.multiReviews) throw new Error("Multi review supervisor is unavailable");
    return context.multiReviews.cancel(asNonBlankString(workflowId, "workflowId"))
      .then(stripLoopedReviewSnapshotSecrets);
  });
  register("delete_multi_review_workflow", async ({ workflowId }, { storage }) => {
    const id = asNonBlankString(workflowId, "workflowId");
    const current = await storage.getMultiReviewWorkflow(id);
    if (current && !(isMultiReviewWorkflow(current.snapshot)
      && isMultiReviewTerminalPhase(current.snapshot.phase))) {
      throw new Error("An active multi review must be cancelled before deletion");
    }
    return storage.deleteMultiReviewWorkflow(id);
  });


}

