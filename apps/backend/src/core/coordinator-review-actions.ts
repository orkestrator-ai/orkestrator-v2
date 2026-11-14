import {
  addressCoordinatorMultiReviewActionCommand,
  customFixCoordinatorMultiReviewActionCommand,
  openCoordinatorMultiReviewCommand,
  openCoordinatorMultiReviewFixCommand,
  launchCoordinatorMultiReviewActionCommand,
} from "@orkestrator/protocol/contract/domains/coordinator";
import { COORDINATOR_REQUEST_ID_REUSED_ERROR } from "@orkestrator/protocol/coordinator";
import { createHash, randomUUID } from "node:crypto";
import {
  isLaunchMultiReviewActionInput,
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  type LaunchMultiReviewActionInput,
  type MultiReviewWorkflow,
  type MultiReviewActionResult,
  isMultiReviewModelSelection,
  MULTI_REVIEW_CUSTOM_ADDRESS_FINDINGS_INSTRUCTION_MAX_LENGTH,
  type MultiReviewModelSelection,
  type StartMultiReviewCustomAddressFindingsInput,
  type StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import type { Environment, PersistedMultiReviewWorkflow } from "./models.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import type { CommandContext } from "./commands-context.js";
import { conciseError } from "./commands-error-text.js";
import { asNonBlankString, stripWorkflowSnapshotSecrets } from "./commands-helpers.js";
import {
  actionHash,
  requireCoordinatorConversation,
  withCoordinatorReceipt,
} from "./coordinator-action-scope.js";
import { openMultiReviewTab } from "./workflow-tab-actions.js";
import {
  multiReviewAutomation,
  multiReviewDefaultRows,
  readLaunchModelCatalog,
  savedLaunchSettings,
} from "./coordinator-launch-defaults.js";
import { assertCoordinatorMayActOnEnvironment } from "./coordinator-environment-scope.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import { coordinatorRequestMatch } from "./coordinator-workflow-retention.js";

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
    workflow: stripWorkflowSnapshotSecrets(workflow),
    reused,
    outcome: ui.status === "opened" ? "opened" : "partial",
    ui,
    ...(recovery ? { recovery } : {}),
  };
}

/**
 * The start request the Multi Review button would send for this environment:
 * the caller's rows and auto-actions, and saved defaults for what it left out.
 */
export async function multiReviewButtonStart(
  context: CommandContext,
  dependencies: Pick<RegistryDependencies, "commands"> | undefined,
  projectId: string,
  environment: Environment,
  input: Omit<LaunchMultiReviewActionInput, "requestId">,
): Promise<StartMultiReviewInput> {
  const config = await context.storage.loadConfig();
  // Omitted model rows take the saved defaults the Multi Review button uses.
  const defaults =
    input.reviewers && input.reviewModel && input.fixModel
      ? undefined
      : multiReviewDefaultRows(
          savedLaunchSettings(config, projectId, environment),
          await readLaunchModelCatalog(
            dependencies?.commands.get("get_native_agent_model_catalog"),
            environment.id,
            context,
          ),
        );
  const instructionWasProvided = Object.hasOwn(input, "reviewInstruction");
  return {
    environmentId: input.environmentId,
    projectId,
    targetBranch: input.targetBranch ?? (config.repositories[projectId]?.prBaseBranch || "main"),
    reviewInstruction: instructionWasProvided
      ? input.reviewInstruction?.trim()
        ? input.reviewInstruction
        : undefined
      : config.global.reviewInstruction,
    reviewers: input.reviewers ?? defaults!.reviewers,
    reviewModel: input.reviewModel ?? defaults!.reviewModel,
    fixModel: input.fixModel ?? defaults!.fixModel,
    ...multiReviewAutomation(input, config.global.agentSettings?.multiReview),
  };
}

/**
 * Start a review under a reserved ID, or recover the one a failed start saved,
 * or reattach to the active review another caller started meanwhile. Never
 * starts a second review for one reservation.
 */
export async function startMultiReviewAt(
  context: CommandContext,
  service: NonNullable<CommandContext["multiReviews"]>,
  start: StartMultiReviewInput,
  reservedId: string,
): Promise<{ saved: PersistedMultiReviewWorkflow | null; reused: boolean }> {
  // Preflight before any provider work. The second check at publication
  // catches a tab added, an environment stopped, or a generation changed
  // while review preparation was running.
  await openMultiReviewTab(context.storage, { ...start, id: reservedId }, "root", true);
  let saved: PersistedMultiReviewWorkflow | null = null;
  let reused = false;
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
        (await context.storage.listMultiReviewWorkflows(start.environmentId)).find(
          (entry) =>
            isMultiReviewWorkflow(entry.snapshot) &&
            !isMultiReviewTerminalPhase(entry.snapshot.phase),
        ) ?? null;
      if (!saved) throw error;
      reused = true;
    }
  }
  saved ??= await context.storage.getMultiReviewWorkflow(reservedId);
  return { saved, reused };
}

/**
 * Open a saved review's root or Address Findings tab, or address its findings: the
 * durable UI actions behind `open_multi_review`, `open_multi_review_fix` and
 * `address_multi_review`. `beforeAddressFindings` runs once the root tab is open and
 * before the Address Findings handoff is armed (a coordinator adopts the workflow there).
 */
export async function runMultiReviewSurface(
  context: CommandContext,
  saved: { snapshot: MultiReviewWorkflow; revision: number },
  surface: "root" | "fix" | "address",
  beforeAddressFindings?: () => Promise<void>,
  /** With `root`: open this reviewer's read-only transcript subtab instead. */
  reviewerId?: string,
  /** With `address`: start the dialog's custom Address Findings instead of the default one. */
  customAddressFindings?: Omit<StartMultiReviewCustomAddressFindingsInput, "workflowId">,
): Promise<MultiReviewActionResult> {
  const id = saved.snapshot.id;
  let workflow = { ...saved.snapshot, backendRevision: saved.revision };
  if (surface === "root" && reviewerId) {
    const index = workflow.reviewers.findIndex((reviewer) => reviewer.id === reviewerId);
    if (index === -1) throw new Error(`Reviewer not found in this review: ${reviewerId}`);
    if (!workflow.reviewers[index]!.providerSessionId)
      return result(
        workflow,
        true,
        { status: "unavailable" },
        "That reviewer has not started a session yet, so it has no transcript to open. Retry once get_multi_review shows it running.",
      );
    try {
      return result(
        workflow,
        true,
        await openMultiReviewTab(
          context.storage,
          workflow,
          "reviewer",
          false,
          reviewerId,
          `Reviewer ${index + 1}`,
        ),
      );
    } catch (error) {
      return result(
        workflow,
        true,
        { status: "unavailable" },
        `The reviewer tab could not be opened: ${conciseError(error)} Ensure the environment is ready and has a free tab, then retry open_multi_review with reviewerId. No workflow was started or cancelled.`,
      );
    }
  }
  if (surface === "address") {
    if (!context.multiReviews) throw new Error("Multi Review supervisor is unavailable");
    let rootUi: MultiReviewActionResult["ui"];
    try {
      // Make the supervisor's pending/error state reachable before arming
      // the handoff. The supervisor publishes and selects Address Findings on delivery.
      rootUi = await openMultiReviewTab(context.storage, workflow);
    } catch (error) {
      if (customAddressFindings)
        throw new Error(
          `Custom Address Findings could not open the review tab: ${conciseError(error)} Retry custom_fix_multi_review with the same requestId after resolving the blocker.`,
        );
      return result(
        workflow,
        true,
        { status: "unavailable" },
        `The review tab could not be opened: ${conciseError(error)} Close a tab if needed, ensure the environment is ready, then retry address_multi_review. No Address Findings handoff was queued.`,
      );
    }
    await beforeAddressFindings?.();
    try {
      workflow = customAddressFindings
        ? await context.multiReviews.customAddressFindings({
            workflowId: id,
            ...customAddressFindings,
          })
        : await context.multiReviews.address(id);
    } catch (error) {
      const latest = await context.storage.getMultiReviewWorkflow(id).catch(() => null);
      if (latest && isMultiReviewWorkflow(latest.snapshot))
        workflow = { ...latest.snapshot, backendRevision: latest.revision };
      const handoffArmed =
        workflow.phase === "interactive" &&
        workflow.addressPromptPending === true &&
        (!customAddressFindings ||
          (workflow.customFixInstruction === customAddressFindings.instruction &&
            workflow.customFixModel?.agent === customAddressFindings.fixModel.agent &&
            workflow.customFixModel.model === customAddressFindings.fixModel.model &&
            workflow.customFixModel.reasoningEffort ===
              customAddressFindings.fixModel.reasoningEffort));
      if (customAddressFindings && !handoffArmed)
        throw new Error(
          `Custom Address Findings handoff could not be queued: ${conciseError(error)} Retry custom_fix_multi_review with the same requestId after resolving the blocker.`,
        );
      return {
        ...result(
          workflow,
          true,
          rootUi,
          handoffArmed
            ? `The review tab opened, but the address action reported: ${conciseError(error)} The durable Address Findings handoff remains queued; inspect get_multi_review before retrying.`
            : `The review tab opened, but the Address Findings handoff could not be queued: ${conciseError(error)} Resolve the reported state and retry address_multi_review.`,
        ),
        outcome: "partial",
      };
    }
    if (workflow.addressPromptPending)
      return {
        ...result(workflow, true, rootUi),
        outcome: "pending",
        recovery:
          "The Address Findings handoff is durably queued. Inspect get_multi_review until addressPromptPending clears; presentationError reports any Address Findings tab failure. Do not send a separate fix prompt.",
      } satisfies MultiReviewActionResult;
    try {
      return result(workflow, true, await openMultiReviewTab(context.storage, workflow, "fix"));
    } catch (error) {
      const latest = await context.storage.getMultiReviewWorkflow(id).catch(() => null);
      if (latest && isMultiReviewWorkflow(latest.snapshot))
        workflow = { ...latest.snapshot, backendRevision: latest.revision };
      return {
        ...result(
          workflow,
          true,
          rootUi,
          `The Address Findings handoff completed, but its tab could not be opened: ${conciseError(error)} Use open_multi_review_fix after ensuring the environment is ready and has a free tab.`,
        ),
        outcome: "partial",
      };
    }
  }
  try {
    return result(workflow, true, await openMultiReviewTab(context.storage, workflow, surface));
  } catch (error) {
    const latest = await context.storage.getMultiReviewWorkflow(id).catch(() => null);
    if (latest && isMultiReviewWorkflow(latest.snapshot))
      workflow = { ...latest.snapshot, backendRevision: latest.revision };
    return result(
      workflow,
      true,
      { status: "unavailable" },
      surface === "fix"
        ? `The Address Findings session tab could not be opened: ${conciseError(error)} Wait for any pending handoff, ensure the environment is ready and has a free tab, then retry open_multi_review_fix. No turn was dispatched.`
        : `The review tab could not be opened: ${conciseError(error)} Ensure the environment is ready and has a free tab, then retry open_multi_review. No workflow was started or cancelled.`,
    );
  }
}

export function registerCoordinatorReviewActions(
  register: CommandRegistrar,
  dependencies?: Pick<RegistryDependencies, "commands">,
): void {
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

  register(launchCoordinatorMultiReviewActionCommand, async ({ scope, input }, context) => {
    const caller = await identity(scope, context);
    if (!isLaunchMultiReviewActionInput(input))
      throw new Error("Invalid Multi Review button action");
    if (!context.multiReviews) throw new Error("Multi Review supervisor is unavailable");
    const service = context.multiReviews;
    return serialize(input.environmentId, async () => {
      const environment = await context.storage.getEnvironment(input.environmentId);
      if (!environment || environment.projectId !== caller.projectId)
        throw new Error("Environment not found in this project");
      if (isProjectHomeEnvironment(environment))
        throw new Error("Coordinator credential cannot act on the project checkout");
      // The request hash below covers the caller's payload, not the default
      // rows, so a retry still replays after the user edits their defaults.
      const start = await multiReviewButtonStart(
        context,
        dependencies,
        caller.projectId,
        environment,
        input,
      );
      const reservedId = `action-${createHash("sha256").update(`${caller.coordinatorId}\0${input.requestId}`).digest("hex").slice(0, 32)}`;
      const payloadHash = actionHash({ action: "launch-multi-review", input });
      const associations = await context.storage.coordinators.listCoordinatorWorkflowAssociations(
        caller.projectId,
      );
      const requestAssociation = associations.find(
        (item) =>
          item.coordinatorId === caller.coordinatorId &&
          coordinatorRequestMatch(item, input.requestId) !== undefined,
      );
      const requestPayloadHash = requestAssociation
        ? coordinatorRequestMatch(requestAssociation, input.requestId)?.payloadHash
        : undefined;
      if (
        requestAssociation &&
        (requestAssociation.kind !== "multi-review" ||
          requestAssociation.projectId !== caller.projectId ||
          requestPayloadHash !== payloadHash)
      )
        throw new Error(COORDINATOR_REQUEST_ID_REUSED_ERROR);
      const active = (await context.storage.listMultiReviewWorkflows(environment.id)).find(
        (entry) =>
          isMultiReviewWorkflow(entry.snapshot) &&
          !isMultiReviewTerminalPhase(entry.snapshot.phase),
      );
      const activeAssociations = active
        ? associations.filter(
            (item) =>
              item.kind === "multi-review" &&
              item.nodeId === undefined &&
              item.resourceId === active.id,
          )
        : [];
      const reusableAssociation = activeAssociations.find(
        (item) =>
          !item.pending &&
          item.coordinatorId === caller.coordinatorId &&
          item.conversationId === caller.conversationId,
      );
      const conflictingAssociation = activeAssociations.find(
        (item) =>
          !item.pending &&
          (item.coordinatorId !== caller.coordinatorId ||
            item.conversationId !== caller.conversationId),
      );
      if (!requestAssociation && !reusableAssociation && conflictingAssociation)
        throw new Error(
          "This active review belongs to another conversation; adopt its workflow before opening it",
        );
      const conflictingPendingAssociation = activeAssociations.find(
        (item) =>
          item.pending &&
          (item.coordinatorId !== caller.coordinatorId ||
            item.conversationId !== caller.conversationId ||
            item.requestId !== input.requestId),
      );
      if (!requestAssociation && !reusableAssociation && conflictingPendingAssociation)
        throw new Error(
          "This active review has a pending launch receipt; retry its original requestId before adopting it",
        );
      const receipt = requestAssociation
        ? requestAssociation.pending
          ? await context.storage.coordinators.reserveCoordinatorWorkflowAssociation({
              id: randomUUID(),
              ...caller,
              kind: "multi-review",
              resourceId: active?.id ?? reservedId,
              requestId: input.requestId,
              payloadHash,
              createdAt: new Date().toISOString(),
            })
          : { association: requestAssociation, claimed: false }
        : reusableAssociation
          ? {
              association: await context.storage.coordinators.addCoordinatorWorkflowRequestAlias(
                reusableAssociation.id,
                caller.coordinatorId,
                caller.conversationId,
                input.requestId,
                payloadHash,
              ),
              claimed: false,
            }
          : await context.storage.coordinators.reserveCoordinatorWorkflowAssociation({
              id: randomUUID(),
              ...caller,
              kind: "multi-review",
              resourceId: active?.id ?? reservedId,
              requestId: input.requestId,
              payloadHash,
              createdAt: new Date().toISOString(),
            });
      if (receipt.association.conversationId !== caller.conversationId)
        throw new Error(
          "This requestId belongs to another conversation; adopt its workflow to open it, or use a new unique requestId for a new review",
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
      // The same request id again: this is that request's review, not a new one.
      const replayed = Boolean(requestAssociation && !requestAssociation.pending);
      const answer = (value: MultiReviewActionResult): MultiReviewActionResult =>
        replayed ? { ...value, replayed: true } : value;
      if (!saved) {
        const started = await startMultiReviewAt(context, service, start, reservedId);
        saved = started.saved;
        reused = started.reused;
      }
      if (!saved || !isMultiReviewWorkflow(saved.snapshot))
        throw new Error(
          "Multi Review did not produce a valid durable snapshot; retry the same requestId",
        );
      let workflow = { ...saved.snapshot, backendRevision: saved.revision };
      try {
        if (receipt.association.pending)
          await context.storage.coordinators.completeCoordinatorWorkflowAssociation(
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
        return answer(
          result(
            workflow,
            reused,
            { status: "unavailable" },
            "The review was saved, but its coordinator receipt could not be completed. Retry launch_multi_review with the same requestId; do not start a new review. Inspect/cancel this workflow ID if recovery remains unavailable." +
              cancellation,
          ),
        );
      }
      try {
        return answer(
          result(workflow, reused, await openMultiReviewTab(context.storage, workflow)),
        );
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
        return answer(result(workflow, reused, { status: "unavailable" }, recovery));
      }
    });
  });

  const surfaceCommand = async (
    surface: "root" | "fix" | "address",
    args: Record<string, unknown>,
    context: CommandContext,
    customAddressFindings?: { instruction: string; fixModel?: MultiReviewModelSelection },
  ): Promise<MultiReviewActionResult> => {
    const caller = await identity(args.scope, context);
    const id = asNonBlankString(args.workflowId, "workflowId");
    const reviewer =
      surface === "root" && args.reviewerId !== undefined
        ? asNonBlankString(args.reviewerId, "reviewerId")
        : undefined;
    const saved = await context.storage.getMultiReviewWorkflow(id);
    if (
      !saved ||
      !isMultiReviewWorkflow(saved.snapshot) ||
      saved.snapshot.projectId !== caller.projectId
    )
      throw new Error("Multi Review not found in this project");
    if (surface === "address") {
      // Addressing starts a writable Address Findings session in the workflow's
      // environment; on the project home that is the read-only checkout.
      const environment = await context.storage.getEnvironment(saved.snapshot.environmentId);
      if (isProjectHomeEnvironment(environment))
        throw new Error("Coordinator credential cannot act on the project checkout");
    }
    const associations = await context.storage.coordinators.listCoordinatorWorkflowAssociations(
      caller.projectId,
    );
    const workflowAssociations = associations.filter(
      (item) => item.kind === "multi-review" && item.nodeId === undefined && item.resourceId === id,
    );
    const ownedAssociation = workflowAssociations.some(
      (item) =>
        item.coordinatorId === caller.coordinatorId &&
        item.conversationId === caller.conversationId &&
        !item.pending,
    );
    const ownedPendingAssociation = workflowAssociations.some(
      (item) =>
        item.coordinatorId === caller.coordinatorId &&
        item.conversationId === caller.conversationId &&
        item.pending,
    );
    if (!ownedAssociation && ownedPendingAssociation)
      throw new Error(
        "This workflow launch is still pending; retry launch_multi_review with its original requestId",
      );
    if (!ownedAssociation && workflowAssociations.length > 0)
      throw new Error(
        "Adopt this workflow into the current coordinator conversation before opening it",
      );
    // Addressing starts an agent even when we already follow this workflow.
    // Workflow membership must not keep opt-in authority after revocation.
    if (surface === "address" && saved.snapshot.environmentId) {
      await assertCoordinatorMayActOnEnvironment(
        context,
        caller,
        saved.snapshot.environmentId,
        undefined,
        "review-address",
      );
    }
    const review = { snapshot: saved.snapshot, revision: saved.revision };
    if (reviewer) return runMultiReviewSurface(context, review, surface, undefined, reviewer);
    return runMultiReviewSurface(
      context,
      review,
      surface,
      async () => {
        // Address adopts renderer-started work before dispatch so the observer
        // can deliver the fix outcome even while this conversation is inactive.
        if (ownedAssociation) return;
        const association = await context.storage.coordinators.saveCoordinatorWorkflowAssociation({
          id: randomUUID(),
          ...caller,
          kind: "multi-review",
          resourceId: id,
          requestId: `address:${id}`,
          createdAt: new Date().toISOString(),
        });
        if (association.conversationId !== caller.conversationId) {
          throw new Error(
            "Adopt this workflow into the current coordinator conversation before addressing it",
          );
        }
      },
      undefined,
      customAddressFindings
        ? {
            instruction: customAddressFindings.instruction,
            // Omitted, the custom Address Findings runs the review's own Address Findings model, as the
            // dialog's model picker starts on it.
            fixModel: customAddressFindings.fixModel ?? saved.snapshot.fixModel,
          }
        : undefined,
    );
  };

  register(openCoordinatorMultiReviewCommand, (args, context) =>
    surfaceCommand("root", args, context),
  );
  register(openCoordinatorMultiReviewFixCommand, (args, context) =>
    surfaceCommand("fix", args, context),
  );
  register(addressCoordinatorMultiReviewActionCommand, (args, context) =>
    surfaceCommand("address", args, context),
  );

  /**
   * The review tab's custom Address Findings ("…" beside Address Findings): a fix with the caller's
   * instruction and, optionally, another model. One run per `requestId`.
   */
  register(customFixCoordinatorMultiReviewActionCommand, async (args, context) => {
    const caller = await identity(args.scope, context);
    const input = args.input;
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Expected the custom Address Findings input");
    const { requestId, workflowId, instruction, fixModel } = input as Record<string, unknown>;
    const text = asNonBlankString(instruction, "instruction").trim();
    if (text.length > MULTI_REVIEW_CUSTOM_ADDRESS_FINDINGS_INSTRUCTION_MAX_LENGTH)
      throw new Error("The custom Address Findings instruction is too long");
    if (fixModel !== undefined && !isMultiReviewModelSelection(fixModel))
      throw new Error("Expected fixModel to be { agent, model, reasoningEffort? }");
    const workflow = asNonBlankString(workflowId, "workflowId");
    // The receipt keeps only the outcome; the workflow is read fresh, so a
    // replay reports where the fix is now rather than where it was.
    const outcome = await withCoordinatorReceipt(
      context,
      caller,
      {
        requestId: asNonBlankString(requestId, "requestId"),
        action: "custom-fix",
        payload: { workflowId: workflow, instruction: text, fixModel },
      },
      async () => {
        const { workflow: _workflow, ...rest } = await surfaceCommand(
          "address",
          { scope: args.scope, workflowId: workflow },
          context,
          {
            instruction: text,
            ...(fixModel ? { fixModel: fixModel as MultiReviewModelSelection } : {}),
          },
        );
        return rest as unknown as Record<string, unknown>;
      },
    );
    const saved = await context.storage.getMultiReviewWorkflow(workflow);
    if (!saved || !isMultiReviewWorkflow(saved.snapshot))
      throw new Error("Multi Review not found in this project");
    return {
      ...(outcome as unknown as Omit<MultiReviewActionResult, "workflow">),
      workflow: stripWorkflowSnapshotSecrets({
        ...saved.snapshot,
        backendRevision: saved.revision,
      }),
    } satisfies MultiReviewActionResult;
  });
}
