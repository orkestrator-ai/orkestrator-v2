import { createHash, randomUUID } from "node:crypto";
import {
  isLaunchMultiReviewActionInput,
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  type MultiReviewWorkflow,
  type MultiReviewActionResult,
  type StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import type { CommandRegistrar } from "./commands-registry-types.js";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString, stripLoopedReviewSnapshotSecrets } from "./commands-helpers.js";
import { actionHash, requireCoordinatorConversation } from "./coordinator-action-scope.js";
import { openMultiReviewTab } from "./workflow-tab-actions.js";

async function identity(scope: unknown, context: CommandContext) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope))
    throw new Error("Coordinator scope is required");
  const value = scope as Record<string, unknown>;
  const projectId = asNonBlankString(value.projectId, "projectId");
  const coordinatorId = asNonBlankString(value.coordinatorId, "coordinatorId");
  const conversationId = asNonBlankString(value.conversationId, "conversationId");
  await requireCoordinatorConversation(context, projectId, coordinatorId, conversationId);
  return { projectId, coordinatorId, conversationId };
}

function result(
  workflow: MultiReviewWorkflow,
  reused: boolean,
  ui: MultiReviewActionResult["ui"],
  recovery?: string,
): MultiReviewActionResult {
  return {
    workflow: stripLoopedReviewSnapshotSecrets(workflow),
    reused,
    outcome: ui.status === "opened" ? "opened" : "partial",
    ui,
    ...(recovery ? { recovery } : {}),
  };
}

export function registerCoordinatorReviewActions(register: CommandRegistrar): void {
  const running = new Map<string, Promise<unknown>>();
  let pendingCount = 0;
  // Serialize, rather than coalesce, so every retry still validates its payload.
  const serialize = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    if (pendingCount >= 256) throw new Error("Too many review actions; retry later");
    pendingCount += 1;
    const prior = running.get(key);
    const next = (prior ?? Promise.resolve()).catch(() => undefined).then(action);
    running.set(key, next);
    try {
      return await next;
    } finally {
      pendingCount -= 1;
      if (running.get(key) === next) running.delete(key);
    }
  };

  register("launch_coordinator_multi_review_action", async ({ scope, input }, context) => {
    const caller = await identity(scope, context);
    if (!isLaunchMultiReviewActionInput(input))
      throw new Error("Invalid Multi Review button action");
    if (!context.multiReviews) throw new Error("Multi Review supervisor is unavailable");
    const service = context.multiReviews;
    return serialize(input.environmentId, async () => {
      const environment = await context.storage.getEnvironment(input.environmentId);
      if (!environment || environment.projectId !== caller.projectId)
        throw new Error("Environment not found in this project");
      const config = await context.storage.loadConfig();
      const start: StartMultiReviewInput = {
        environmentId: input.environmentId,
        projectId: caller.projectId,
        targetBranch:
          input.targetBranch ?? (config.repositories[caller.projectId]?.prBaseBranch || "main"),
        reviewInstruction: input.reviewInstruction ?? config.global.reviewInstruction,
        reviewers: input.reviewers,
        fixModel: input.fixModel,
      };
      const reservedId = `action-${createHash("sha256").update(`${caller.coordinatorId}\0${input.requestId}`).digest("hex").slice(0, 32)}`;
      const active = (await context.storage.listMultiReviewWorkflows(environment.id)).find(
        (entry) =>
          isMultiReviewWorkflow(entry.snapshot) &&
          !isMultiReviewTerminalPhase(entry.snapshot.phase),
      );
      const receipt = await context.storage.reserveCoordinatorWorkflowAssociation({
        id: randomUUID(),
        ...caller,
        kind: "multi-review",
        resourceId: active?.id ?? reservedId,
        requestId: input.requestId,
        payloadHash: actionHash({ action: "launch-multi-review", input }),
        createdAt: new Date().toISOString(),
      });
      if (receipt.association.conversationId !== caller.conversationId)
        throw new Error(
          "This request belongs to another conversation; adopt its workflow before opening it",
        );
      if (!receipt.claimed && receipt.association.pending)
        throw new Error(
          "Multi Review launch is owned by another backend; retry the same requestId",
        );
      let saved = await context.storage.getMultiReviewWorkflow(receipt.association.resourceId);
      if (!saved && (!receipt.association.pending || receipt.association.resourceId !== reservedId))
        throw new Error(
          "The associated review was removed; use a new requestId only to intentionally start another review",
        );
      let reused = Boolean(saved);
      if (!saved) {
        // Preflight before any provider work. The second check at publication
        // catches a tab added, an environment stopped, or a generation changed
        // while review preparation was running.
        await openMultiReviewTab(context.storage, { ...start, id: reservedId }, "root", true);
        try {
          await service.start(start, reservedId);
        } catch (error) {
          // A save may have succeeded before a later launch stage failed. Only
          // positive durable evidence permits recovery; never start another ID.
          saved = await context.storage.getMultiReviewWorkflow(reservedId);
          if (!saved) {
            // The renderer or another coordinator may have won admission while
            // preparation awaited Git. Reattach to that winner, never restart.
            saved =
              (await context.storage.listMultiReviewWorkflows(environment.id)).find(
                (entry) =>
                  isMultiReviewWorkflow(entry.snapshot) &&
                  !isMultiReviewTerminalPhase(entry.snapshot.phase),
              ) ?? null;
            if (!saved) throw error;
            reused = true;
          }
        }
        saved ??= await context.storage.getMultiReviewWorkflow(reservedId);
      }
      if (!saved || !isMultiReviewWorkflow(saved.snapshot))
        throw new Error(
          "Multi Review did not produce a valid durable snapshot; retry the same requestId",
        );
      let workflow = { ...saved.snapshot, backendRevision: saved.revision };
      try {
        await context.storage.completeCoordinatorWorkflowAssociation(
          receipt.association.id,
          workflow.id,
        );
      } catch {
        let cancellation = "";
        if (!reused && !isMultiReviewTerminalPhase(workflow.phase)) {
          try {
            workflow = await service.cancel(workflow.id);
            cancellation =
              workflow.phase === "cancelled"
                ? " The new review was cancelled; its record is retained."
                : " Cancellation is still in progress; its record is retained.";
          } catch {
            cancellation = " Cancellation could not be confirmed; the review may still be running.";
          }
        }
        return result(
          workflow,
          reused,
          { status: "unavailable" },
          "The review was saved, but its coordinator receipt could not be completed. Retry launch_multi_review with the same requestId; do not start a new review. Inspect/cancel this workflow ID if recovery remains unavailable." +
            cancellation,
        );
      }
      try {
        return result(workflow, reused, await openMultiReviewTab(context.storage, workflow));
      } catch {
        let recovery =
          "The review is saved but its tab could not be opened. Start the environment, close a tab if needed, then use open_multi_review with this workflow ID.";
        if (!reused && !isMultiReviewTerminalPhase(workflow.phase)) {
          try {
            workflow = await service.cancel(workflow.id);
            recovery +=
              workflow.phase === "cancelled"
                ? " The new review was cancelled; its record is retained for recovery."
                : " Cancellation is still in progress; the saved review is retained for recovery.";
          } catch {
            recovery +=
              " Cancellation could not be confirmed. The review may still be running; inspect it and use cancel_multi_review before launching another.";
          }
        }
        return result(workflow, reused, { status: "unavailable" }, recovery);
      }
    });
  });

  for (const surface of ["root", "fix", "address"] as const) {
    register(
      surface === "root"
        ? "open_coordinator_multi_review"
        : surface === "fix"
          ? "open_coordinator_multi_review_fix"
          : "address_coordinator_multi_review_action",
      async ({ scope, workflowId }, context) => {
        const caller = await identity(scope, context);
        const id = asNonBlankString(workflowId, "workflowId");
        const associations = await context.storage.listCoordinatorWorkflowAssociations(
          caller.projectId,
        );
        if (
          !associations.some(
            (item) =>
              item.kind === "multi-review" &&
              item.resourceId === id &&
              item.coordinatorId === caller.coordinatorId &&
              item.conversationId === caller.conversationId &&
              !item.pending,
          )
        )
          throw new Error(
            "Adopt this workflow into the current coordinator conversation before opening it",
          );
        const saved = await context.storage.getMultiReviewWorkflow(id);
        if (
          !saved ||
          !isMultiReviewWorkflow(saved.snapshot) ||
          saved.snapshot.projectId !== caller.projectId
        )
          throw new Error("Multi Review not found in this project");
        let workflow = { ...saved.snapshot, backendRevision: saved.revision };
        try {
          if (surface === "address") {
            if (!context.multiReviews) throw new Error("Multi Review supervisor is unavailable");
            // Make the supervisor's pending/error state reachable before arming
            // the handoff. The supervisor publishes and selects Fix on delivery.
            const ui = await openMultiReviewTab(context.storage, workflow);
            workflow = await context.multiReviews.address(id);
            if (workflow.addressPromptPending)
              return {
                ...result(workflow, true, ui),
                outcome: "pending",
                recovery:
                  "The fix handoff is durably queued. Inspect get_multi_review until addressPromptPending clears; presentationError reports any Fix tab failure. Do not send a separate fix prompt.",
              } satisfies MultiReviewActionResult;
            return result(
              workflow,
              true,
              await openMultiReviewTab(context.storage, workflow, "fix"),
            );
          }
          return result(
            workflow,
            true,
            await openMultiReviewTab(context.storage, workflow, surface),
          );
        } catch {
          const latest = await context.storage.getMultiReviewWorkflow(id).catch(() => null);
          if (latest && isMultiReviewWorkflow(latest.snapshot))
            workflow = { ...latest.snapshot, backendRevision: latest.revision };
          return result(
            workflow,
            true,
            { status: "unavailable" },
            surface === "address"
              ? "The address action could not complete. Inspect the saved workflow before retrying address_multi_review; its durable handoff key prevents a second fix turn. If presentationError is set, use open_multi_review_fix."
              : surface === "fix"
                ? "The fix session tab could not be opened. Wait for any pending handoff, ensure the environment is ready and has a free tab, then retry open_multi_review_fix. No turn was dispatched."
                : "The review tab could not be opened. Ensure the environment is ready and has a free tab, then retry open_multi_review. No workflow was started or cancelled.",
          );
        }
      },
    );
  }
}
