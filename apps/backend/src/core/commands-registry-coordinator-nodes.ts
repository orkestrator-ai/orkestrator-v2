import { createHash, randomUUID } from "node:crypto";

import {
  COORDINATOR_MAIL_ADDRESS,
  coordinatorRuntimeId,
  type CoordinatorWorkflowAssociation,
} from "@orkestrator/protocol/coordinator";
import {
  isLaunchMultiReviewActionInput,
  isMultiReviewModelSelection,
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  MULTI_REVIEW_CUSTOM_FIX_INSTRUCTION_MAX_LENGTH,
  type MultiReviewActionResult,
} from "@orkestrator/protocol/multi-review";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";
import {
  COORDINATOR_DELEGATION_PRESENTATION,
  COORDINATOR_ENVIRONMENT_DELEGATION_INSTRUCTION,
  createCoordinatorDelegatedPrompt,
} from "@orkestrator/protocol/review-evidence-frames";

import { beginWorkerTabDelegation } from "./worker-tab-close-admission.js";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  actionHash,
  requireCoordinatorConversation,
  withCoordinatorReceipt,
} from "./coordinator-action-scope.js";

/**
 * A command node's coordinator acting on a node it controls, with the same
 * contract as on its own node (docs/architecture/command-nodes.md, "One tool family,
 * every node").
 *
 * The coordinator's idempotency receipts, workflow associations and
 * delegations stay here, each with the resource's `nodeId`; the work itself
 * runs on that node through its ordinary commands and the controller-facing
 * ones in `commands-registry-controller-workflows.ts`. A reservation is
 * written before any routed side effect and completed after it, so a retried
 * request finds the first one instead of starting a second; a lost answer is
 * an outcome-unknown error the coordinator must resolve by reading state.
 */

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type Caller = { projectId: string; coordinatorId: string; conversationId: string };

async function identity(scope: unknown, context: CommandContext): Promise<Caller> {
  if (!record(scope)) throw new Error("Coordinator scope is required");
  const projectId = asNonBlankString(scope.projectId, "projectId");
  const coordinatorId = asNonBlankString(scope.coordinatorId, "coordinatorId");
  const conversationId = asNonBlankString(scope.conversationId, "conversationId");
  await requireCoordinatorConversation(context, projectId, coordinatorId, conversationId);
  return { projectId, coordinatorId, conversationId };
}

/** One node this coordinator acts on: its copy of the project and a routed invoker. */
export interface CoordinatorNodeTarget {
  selfId: string;
  nodeId: string;
  nodeName: string;
  /** This project's copy on that node, matched by repository identity. */
  projectId: string;
  call<T>(command: string, args?: JsonRecord, requestKey?: string): Promise<T>;
  /** One of this project's worker environments there, or an error naming why not. */
  environment(environmentId: string): Promise<JsonRecord>;
}

export async function coordinatorNodeTarget(
  context: CommandContext,
  projectId: string,
  nodeId: string,
): Promise<CoordinatorNodeTarget> {
  if (!context.nodePortal || !context.nodes) {
    throw new Error("Cross-node coordination is not available in this backend.");
  }
  const portal = context.nodePortal;
  const status = await context.nodes.status();
  if (status.mode === "leaf") {
    throw new Error(
      "This node is in leaf mode: coordination happens on the command node that controls it.",
    );
  }
  if (nodeId === status.nodeId) {
    throw new Error("That is this node; omit nodeId for this node's own environments.");
  }
  const summaries = await portal.summaries([nodeId]);
  const node = summaries.nodes[0];
  if (!node) throw new Error(`No connected node has ID ${nodeId}. Call list_nodes.`);
  if (!node.available) {
    throw new Error(`${node.view.displayName} is not connected; changes to it are disabled.`);
  }
  const hint = repositoryHint((await context.storage.getProject(projectId))?.gitUrl);
  const project = hint ? node.projects.find((entry) => entry.repositoryHint === hint) : undefined;
  if (!project) {
    throw new Error(
      `${node.view.displayName} has no copy of this project. Ask the user to copy it there first (request_project_on_node).`,
    );
  }
  const call = async <T>(command: string, args: JsonRecord = {}, requestKey?: string) => {
    const routed = await portal
      .invokeOnNode({
        nodeId,
        command,
        args,
        ...(requestKey ? { requestKey } : {}),
      })
      .catch((error: unknown) => {
        // An older node does not know the controller commands yet.
        if (error instanceof Error && error.message.includes(`Unknown command: ${command}`)) {
          throw new Error(
            `${node.view.displayName} runs an older Orkestrator that cannot do this yet; update it, then retry.`,
          );
        }
        throw error;
      });
    if (routed.outcome !== "ok") {
      throw Object.assign(
        new Error(
          `The connection to ${node.view.displayName} was lost before it answered ${command}. Its outcome is unknown and it was not resent; check the resource before trying again.`,
        ),
        { code: "outcome-unknown" },
      );
    }
    return routed.result as T;
  };
  return {
    selfId: status.nodeId,
    nodeId,
    nodeName: node.view.displayName,
    projectId: project.ref.projectId,
    call,
    environment: async (environmentId: string) => {
      const value = await call<unknown>("get_environment", { environmentId });
      if (!record(value) || value.projectId !== project.ref.projectId) {
        throw new Error("That environment does not belong to this project on that node.");
      }
      if (value.projectHome === true) {
        throw new Error("The node's project checkout is not a worker environment.");
      }
      return value;
    },
  };
}

export const RETRY_SAME_REQUEST =
  "Retry with the same requestId: the node replays what the first attempt made rather than acting twice.";

/** A lost answer from a node, with what the coordinator should do about it. */
export async function withRetryAdvice<T>(advice: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Error && (error as { code?: unknown }).code === "outcome-unknown")
      throw Object.assign(new Error(`${error.message} ${advice}`), { code: "outcome-unknown" });
    throw error;
  }
}

/** This conversation's mailbox, where a node's reports for it are delivered. */
async function mailbox(context: CommandContext, caller: Caller) {
  const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(
    caller.coordinatorId,
  );
  const conversation = workspace?.conversations.find((item) => item.id === caller.conversationId);
  if (!conversation) throw new Error("This coordinator conversation has no mailbox.");
  return {
    coordinatorEnvironmentId: coordinatorRuntimeId(caller.coordinatorId, caller.conversationId),
    coordinatorTabId: conversation.tabId,
  };
}

/** Reports from that environment come back to this conversation. */
async function recordOrigin(
  context: CommandContext,
  caller: Caller,
  target: CoordinatorNodeTarget,
  environmentId: string,
) {
  await target.call("record_node_environment_origin", {
    environmentId,
    controllerId: target.selfId,
    ...(await mailbox(context, caller)),
  });
}

/** The report contract a worker on another node is given with its delegation. */
function remoteReportInstruction(nodeName: string): string {
  return (
    `${COORDINATOR_ENVIRONMENT_DELEGATION_INSTRUCTION}\n` +
    `The coordinator runs on the command node that controls this machine (${nodeName} is this machine's name there). It is idle while you work and is woken once, when your turn ends. ` +
    `Send exactly one report with send_message to toEnvironmentId "${COORDINATOR_MAIL_ADDRESS}" (no toTabId needed), then end your turn. Do not send progress updates: anything you send before your turn ends is held and delivered with your final report.`
  );
}

async function openNodeDelegation(
  context: CommandContext,
  caller: Caller,
  nodeId: string,
  environmentId: string,
  tabId: string,
  requestId: string,
): Promise<boolean> {
  const association = await context.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: randomUUID(),
    ...caller,
    kind: "environment",
    resourceId: environmentId,
    nodeId,
    requestId: `delegation:${requestId}`,
    createdAt: new Date().toISOString(),
  });
  if (
    association.conversationId !== caller.conversationId ||
    association.resourceId !== environmentId ||
    association.nodeId !== nodeId
  ) {
    throw new Error("Coordinator request id was reused with a different delegation target");
  }
  const opened = await context.storage.coordinators.openCoordinatorDelegation(
    association.id,
    tabId,
  );
  if (!opened) throw new Error("Coordinator delegation association was not found");
  await startRemoteRequest(context, caller, association.id, { nodeId, environmentId, tabId });
  return opened.delegation?.state === "running";
}

/**
 * A new request to a remote worker: the turn that answers it starts after
 * now, and its reports count against a fresh pair budget, as a new local
 * delegation's do.
 */
async function startRemoteRequest(
  context: CommandContext,
  caller: Caller,
  associationId: string,
  worker: { nodeId: string; environmentId: string; tabId: string },
) {
  context.coordinators?.noteRemoteRequest(associationId);
  const own = await mailbox(context, caller);
  await context.storage.startRemoteWorkerBudget(
    { environmentId: own.coordinatorEnvironmentId, tabId: own.coordinatorTabId },
    worker,
  );
}

async function assertNodeDelegationAvailable(
  context: CommandContext,
  caller: Caller,
  nodeId: string,
  environmentId: string,
  tabId: string,
  requestId: string,
) {
  const overlapping = (await context.storage.coordinators.listOpenCoordinatorDelegations()).find(
    (association) =>
      association.coordinatorId === caller.coordinatorId &&
      association.conversationId === caller.conversationId &&
      association.kind === "environment" &&
      association.nodeId === nodeId &&
      association.resourceId === environmentId &&
      association.delegation?.workerTabId === tabId &&
      association.requestId !== `delegation:${requestId}`,
  );
  if (overlapping) {
    throw new Error("That worker tab already has an outstanding coordinator delegation");
  }
}

function requestAlias(association: CoordinatorWorkflowAssociation, requestId: string) {
  return association.requestAliases?.find((alias) => alias.requestId === requestId);
}

export function registerCoordinatorNodeCommands(register: CommandRegistrar): void {
  const starts = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const existing = starts.get(key);
    if (existing) return existing as Promise<T>;
    const started = operation().finally(() => {
      if (starts.get(key) === started) starts.delete(key);
    });
    starts.set(key, started);
    return started;
  };

  register(
    "launch_coordinator_node_environment",
    async ({ scope, requestId, nodeId, input }, context) => {
      const caller = await identity(scope, context);
      const stableRequestId = asNonBlankString(requestId, "requestId");
      const target = await coordinatorNodeTarget(
        context,
        caller.projectId,
        asNonBlankString(nodeId, "nodeId"),
      );
      if (
        !record(input) ||
        input.projectId !== caller.projectId ||
        typeof input.delegationBaseBranch !== "string" ||
        typeof input.delegationBaseCommit !== "string" ||
        !/^[0-9a-f]{40}$/i.test(input.delegationBaseCommit)
      ) {
        throw new Error("Coordinator launches require a scoped base branch and commit");
      }
      const baseBranch = input.delegationBaseBranch;
      const baseCommit = input.delegationBaseCommit;
      const payloadHash = actionHash({ nodeId: target.nodeId, input });
      return once(`${caller.coordinatorId}\0${stableRequestId}`, async () => {
        const receipt = await context.storage.coordinators.reserveCoordinatorWorkflowAssociation({
          id: randomUUID(),
          ...caller,
          kind: "environment",
          resourceId: `pending:${stableRequestId}`,
          nodeId: target.nodeId,
          requestId: stableRequestId,
          payloadHash,
          baseBranch,
          baseCommit,
          createdAt: new Date().toISOString(),
        });
        if (!receipt.claimed && !receipt.association.pending) {
          return {
            environment: await target.call("get_environment", {
              environmentId: receipt.association.resourceId,
            }),
            coordinatorDelegationOpened: receipt.association.delegation?.state === "running",
          };
        }
        if (!receipt.claimed) {
          throw new Error("Environment creation is already in progress; retry this requestId");
        }
        const delegation =
          typeof input.initialPrompt === "string"
            ? createCoordinatorDelegatedPrompt(
                {
                  ...caller,
                  baseBranch,
                  baseCommit,
                  instruction: remoteReportInstruction(target.nodeName),
                },
                input.initialPrompt,
              )
            : null;
        const environment = await target.call<JsonRecord>(
          "create_controller_environment",
          {
            input: {
              ...input,
              projectId: target.projectId,
              initialPrompt: delegation?.source ?? input.initialPrompt,
            },
            controlRequestId: `node:${caller.coordinatorId}:${stableRequestId}`,
            ...(delegation
              ? {
                  presentation: {
                    kind: COORDINATOR_DELEGATION_PRESENTATION,
                    frame: delegation.frame,
                  },
                }
              : {}),
          },
          `launch:${caller.coordinatorId}:${stableRequestId}`,
        );
        if (!record(environment) || typeof environment.id !== "string") {
          throw new Error("Environment creation on that node returned no environment.");
        }
        const environmentId = environment.id;
        await recordOrigin(context, caller, target, environmentId);
        await context.storage.coordinators.completeCoordinatorWorkflowAssociation(
          receipt.association.id,
          environmentId,
        );
        let startError: string | undefined;
        if (environment.status !== "running" && environment.status !== "creating") {
          try {
            await target.call("start_environment_background", { environmentId });
          } catch (error) {
            startError = error instanceof Error ? error.message : "Environment start failed";
            // A lost answer is not a failed start: the node usually started it.
            // Ask what it is now rather than report a failure and never open
            // the delegation, which would leave the worker's report unheld.
            if ((error as { code?: unknown }).code === "outcome-unknown") {
              const current = await target.environment(environmentId).catch(() => null);
              if (current?.status === "running" || current?.status === "creating") {
                startError = undefined;
              }
            }
          }
        }
        let coordinatorDelegationOpened = false;
        if (!startError) {
          coordinatorDelegationOpened = Boolean(
            await context.storage.coordinators.openCoordinatorDelegation(
              receipt.association.id,
              "startup-agent",
            ),
          );
          await startRemoteRequest(context, caller, receipt.association.id, {
            nodeId: target.nodeId,
            environmentId,
            tabId: "startup-agent",
          });
        }
        return {
          environment,
          coordinatorDelegationOpened,
          ...(startError ? { startError } : {}),
        };
      });
    },
  );

  register(
    "assert_coordinator_node_delegation_available",
    async ({ scope, nodeId, environmentId, tabId, requestId }, context) => {
      const caller = await identity(scope, context);
      const target = await coordinatorNodeTarget(
        context,
        caller.projectId,
        asNonBlankString(nodeId, "nodeId"),
      );
      await target.environment(asNonBlankString(environmentId, "environmentId"));
      await assertNodeDelegationAvailable(
        context,
        caller,
        target.nodeId,
        String(environmentId),
        asNonBlankString(tabId, "tabId"),
        asNonBlankString(requestId, "requestId"),
      );
      return { available: true };
    },
  );

  register(
    "open_coordinator_node_delegation",
    async ({ scope, nodeId, environmentId, tabId, requestId }, context) => {
      const caller = await identity(scope, context);
      const target = await coordinatorNodeTarget(
        context,
        caller.projectId,
        asNonBlankString(nodeId, "nodeId"),
      );
      const worker = asNonBlankString(environmentId, "environmentId");
      const workerTab = asNonBlankString(tabId, "tabId");
      const release = beginWorkerTabDelegation(worker, workerTab, target.nodeId);
      try {
        await target.environment(worker);
        await recordOrigin(context, caller, target, worker);
        return {
          opened: await openNodeDelegation(
            context,
            caller,
            target.nodeId,
            worker,
            workerTab,
            asNonBlankString(requestId, "requestId"),
          ),
        };
      } finally {
        release();
      }
    },
  );

  /**
   * Mail to an agent on that node. Asking a worker something is a delegation,
   * as it is here: the coordinator is woken once, when that worker's turn
   * ends, and its report is held until then.
   */
  register("send_coordinator_node_mail", async (args, context) => {
    const caller = await identity(args.scope, context);
    const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(
      caller.coordinatorId,
    );
    if (
      workspace?.conversations.find((item) => item.id === caller.conversationId)?.role === "side"
    ) {
      throw new Error('A side agent can only message the main coordinator. Send to "coordinator".');
    }
    const toEnvironmentId = asNonBlankString(args.toEnvironmentId, "toEnvironmentId");
    return context.storage.withAgentMailWorkerAdmission(
      `node:${args.nodeId}:${toEnvironmentId}`,
      async () => {
        const target = await coordinatorNodeTarget(
          context,
          caller.projectId,
          asNonBlankString(args.nodeId, "nodeId"),
        );
        const requestId = asNonBlankString(args.requestId, "requestId");
        const recipient = await target.environment(toEnvironmentId);
        const requestedTab = typeof args.toTabId === "string" ? args.toTabId.trim() : "";
        const release = beginWorkerTabDelegation(
          toEnvironmentId,
          requestedTab || undefined,
          target.nodeId,
        );
        try {
          const joining = (
            await context.storage.coordinators.listOpenCoordinatorDelegations()
          ).find(
            (association) =>
              association.coordinatorId === caller.coordinatorId &&
              association.kind === "environment" &&
              association.nodeId === target.nodeId &&
              association.resourceId === toEnvironmentId &&
              (!requestedTab || association.delegation?.workerTabId === requestedTab) &&
              association.requestId !== `delegation:${requestId}`,
          );
          if (joining) context.coordinators?.noteRemoteRequest(joining.id);
          const delivered = await target.call<{
            messageId?: string;
            toTabId?: string;
            toEnvironmentName?: string;
            toTabName?: string;
            placement?: string;
            placementReason?: string;
          }>(
            "deliver_node_mail",
            {
              controllerId: target.selfId,
              ...(await mailbox(context, caller)),
              requestId,
              toEnvironmentId,
              ...(requestedTab ? { toTabId: requestedTab } : {}),
              ...(typeof args.subject === "string" ? { subject: args.subject } : {}),
              body: asNonBlankString(args.body, "body"),
            },
            `mail:${caller.coordinatorId}:${requestId}`,
          );
          const workerTab = requestedTab || delivered?.toTabId || joining?.delegation?.workerTabId;
          const toEnvironmentName =
            delivered?.toEnvironmentName ??
            (typeof recipient.name === "string" ? recipient.name : undefined);
          // As here, only mail scheduled to reach the worker asks it anything: a
          // message the node stored or bounced opens no delegation. (Older nodes do
          // not report the placement.)
          const scheduled = !delivered?.placement || delivered.placement === "pending-inject";
          let coordinatorDelegationOpened = false;
          if (joining && scheduled) {
            context.coordinators?.noteRemoteRequest(joining.id);
            coordinatorDelegationOpened = true;
          } else if (workerTab && scheduled) {
            coordinatorDelegationOpened = await openNodeDelegation(
              context,
              caller,
              target.nodeId,
              toEnvironmentId,
              workerTab,
              requestId,
            );
          }
          return {
            nodeId: target.nodeId,
            node: target.nodeName,
            ...(delivered?.messageId ? { messageId: delivered.messageId } : {}),
            toEnvironmentId,
            ...(workerTab ? { toTabId: workerTab } : {}),
            // Names the recipient in the coordinator's transcript; older nodes
            // report no tab name.
            ...(toEnvironmentName ? { toEnvironmentName } : {}),
            ...(delivered?.toTabName && delivered.toTabId === workerTab
              ? { toTabName: delivered.toTabName }
              : {}),
            ...(delivered?.placement ? { placement: delivered.placement } : {}),
            ...(delivered?.placementReason ? { placementReason: delivered.placementReason } : {}),
            coordinatorDelegationOpened,
            // Said plainly, as for a worker here: "pending" alone reads as delivered.
            ...(recipient.status === "stopped"
              ? {
                  deliveryNote: `The recipient environment on ${target.nodeName} is stopped. Call start_environment with nodeId "${target.nodeId}" to deliver this message, or ask the user.`,
                }
              : {}),
          };
        } finally {
          release();
        }
      },
    );
  });

  register(
    "start_coordinator_node_build_pipeline",
    async ({ scope, requestId, nodeId, input }, context) => {
      const caller = await identity(scope, context);
      const stableRequestId = asNonBlankString(requestId, "requestId");
      const target = await coordinatorNodeTarget(
        context,
        caller.projectId,
        asNonBlankString(nodeId, "nodeId"),
      );
      if (
        !record(input) ||
        input.projectId !== caller.projectId ||
        typeof input.delegationBaseBranch !== "string" ||
        typeof input.delegationBaseCommit !== "string"
      ) {
        throw new Error("Invalid scoped build pipeline request");
      }
      if (typeof input.existingEnvironmentId === "string") {
        await target.environment(input.existingEnvironmentId);
      }
      const payloadHash = actionHash({ nodeId: target.nodeId, input });
      return once(`${caller.coordinatorId}\0${stableRequestId}`, async () => {
        const receipt = await context.storage.coordinators.reserveCoordinatorWorkflowAssociation({
          id: randomUUID(),
          ...caller,
          kind: "build-pipeline",
          resourceId: `pending:${stableRequestId}`,
          nodeId: target.nodeId,
          requestId: stableRequestId,
          payloadHash,
          baseBranch: String(input.delegationBaseBranch),
          baseCommit: String(input.delegationBaseCommit),
          createdAt: new Date().toISOString(),
        });
        if (!receipt.claimed && !receipt.association.pending) {
          const existing = await target.call<unknown>("get_build_pipeline", {
            pipelineId: receipt.association.resourceId,
          });
          if (!record(existing)) throw new Error("Associated build pipeline was not found");
          return existing.snapshot;
        }
        if (!receipt.claimed) {
          throw new Error("Build pipeline creation is already in progress; retry this requestId");
        }
        // The node's admission key makes a resent start return the first pipeline.
        const workflow = await target.call<JsonRecord>(
          "start_controller_build_pipeline",
          { input: { ...input, projectId: target.projectId } },
          `build:${caller.coordinatorId}:${stableRequestId}`,
        );
        if (!record(workflow) || typeof workflow.id !== "string") {
          throw new Error("Build pipeline returned no result");
        }
        await context.storage.coordinators.completeCoordinatorWorkflowAssociation(
          receipt.association.id,
          workflow.id,
        );
        return workflow;
      });
    },
  );

  register("launch_coordinator_node_multi_review", async ({ scope, nodeId, input }, context) => {
    const caller = await identity(scope, context);
    if (!isLaunchMultiReviewActionInput(input)) {
      throw new Error("Invalid Multi Review button action");
    }
    const target = await coordinatorNodeTarget(
      context,
      caller.projectId,
      asNonBlankString(nodeId, "nodeId"),
    );
    await target.environment(input.environmentId);
    const reservedId = `action-${createHash("sha256").update(`${caller.coordinatorId}\0${input.requestId}`).digest("hex").slice(0, 32)}`;
    const payloadHash = actionHash({ action: "launch-multi-review", nodeId: target.nodeId, input });
    return once(`${caller.coordinatorId}\0${input.requestId}`, () =>
      context.storage.withAgentMailWorkerAdmission(
        `review:${target.nodeId}:${input.environmentId}`,
        async () => {
          const associations =
            await context.storage.coordinators.listCoordinatorWorkflowAssociations(
              caller.projectId,
            );
          const existing = associations.find(
            (item) =>
              item.coordinatorId === caller.coordinatorId &&
              (item.requestId === input.requestId || requestAlias(item, input.requestId)),
          );
          if (
            existing &&
            (existing.kind !== "multi-review" ||
              existing.nodeId !== target.nodeId ||
              (existing.requestId === input.requestId
                ? existing.payloadHash
                : requestAlias(existing, input.requestId)?.payloadHash) !== payloadHash)
          ) {
            throw new Error("Coordinator request id was reused with a different payload");
          }
          if (existing && existing.conversationId !== caller.conversationId) {
            throw new Error(
              "This request belongs to another conversation; adopt its workflow before opening it",
            );
          }
          if (existing && !existing.pending) {
            // A completed receipt names its review; a review since removed is not
            // replaced under the same request.
            const saved = await target.call<unknown>("get_multi_review_workflow", {
              workflowId: existing.resourceId,
            });
            if (!record(saved)) {
              throw new Error(
                "The associated review was removed; use a new requestId only to intentionally start another review",
              );
            }
          }
          // The environment's active review, and who here owns it, as for a review here.
          const listed = existing
            ? []
            : await target.call<unknown>("list_multi_review_workflows", {
                environmentId: input.environmentId,
              });
          const active = (Array.isArray(listed) ? listed : []).find(
            (entry): entry is JsonRecord =>
              record(entry) &&
              isMultiReviewWorkflow(entry.snapshot) &&
              !isMultiReviewTerminalPhase(entry.snapshot.phase),
          );
          const activeId =
            active && record(active.snapshot) && typeof active.snapshot.id === "string"
              ? active.snapshot.id
              : undefined;
          const owners = activeId
            ? associations.filter(
                (item) =>
                  item.kind === "multi-review" &&
                  item.nodeId === target.nodeId &&
                  item.resourceId === activeId,
              )
            : [];
          const reusable = owners.find(
            (item) =>
              !item.pending &&
              item.coordinatorId === caller.coordinatorId &&
              item.conversationId === caller.conversationId,
          );
          if (!reusable && owners.some((item) => !item.pending)) {
            throw new Error(
              "This active review belongs to another conversation; adopt its workflow before opening it",
            );
          }
          if (!reusable && owners.some((item) => item.pending)) {
            throw new Error(
              "This active review has a pending launch receipt; retry its original requestId before adopting it",
            );
          }
          const receipt =
            existing && !existing.pending
              ? { association: existing, claimed: false }
              : reusable
                ? {
                    association:
                      await context.storage.coordinators.addCoordinatorWorkflowRequestAlias(
                        reusable.id,
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
                    resourceId: activeId ?? reservedId,
                    nodeId: target.nodeId,
                    requestId: input.requestId,
                    payloadHash,
                    createdAt: new Date().toISOString(),
                  });
          if (!receipt.claimed && receipt.association.pending) {
            throw new Error(
              "Multi Review launch is owned by another backend; retry the same requestId",
            );
          }
          const result = await target.call<MultiReviewActionResult>(
            "launch_controller_multi_review",
            { input, reservedId: receipt.association.resourceId },
            `review:${caller.coordinatorId}:${input.requestId}`,
          );
          if (!record(result) || !isMultiReviewWorkflow(result.workflow)) {
            throw new Error("Multi Review on that node returned no workflow");
          }
          if (receipt.association.pending) {
            await context.storage.coordinators.completeCoordinatorWorkflowAssociation(
              receipt.association.id,
              result.workflow.id,
            );
          }
          return result;
        },
      ),
    );
  });

  register("coordinator_node_multi_review_surface", async (args, context) => {
    const caller = await identity(args.scope, context);
    const surface = args.surface;
    if (
      surface !== "root" &&
      surface !== "fix" &&
      surface !== "address" &&
      surface !== "reviewer" &&
      surface !== "custom-fix"
    ) {
      throw new Error("Expected surface root, fix, address, reviewer or custom-fix.");
    }
    const reviewerId =
      surface === "reviewer" ? asNonBlankString(args.reviewerId, "reviewerId") : undefined;
    let customFix: { requestId: string; instruction: string; fixModel?: unknown } | undefined;
    if (surface === "custom-fix") {
      const instruction = asNonBlankString(args.instruction, "instruction").trim();
      if (instruction.length > MULTI_REVIEW_CUSTOM_FIX_INSTRUCTION_MAX_LENGTH)
        throw new Error("The custom fix instruction is too long");
      if (args.fixModel !== undefined && !isMultiReviewModelSelection(args.fixModel))
        throw new Error("Expected fixModel to be { agent, model, reasoningEffort? }");
      customFix = {
        requestId: asNonBlankString(args.requestId, "requestId"),
        instruction,
        ...(args.fixModel !== undefined ? { fixModel: args.fixModel } : {}),
      };
    }
    const target = await coordinatorNodeTarget(
      context,
      caller.projectId,
      asNonBlankString(args.nodeId, "nodeId"),
    );
    const id = asNonBlankString(args.workflowId, "workflowId");
    const read = () => target.call<unknown>("get_multi_review_workflow", { workflowId: id });
    const saved = await read();
    if (
      !record(saved) ||
      !isMultiReviewWorkflow(saved.snapshot) ||
      saved.snapshot.projectId !== target.projectId
    ) {
      throw new Error("Multi Review not found in this project on that node");
    }
    const associations = (
      await context.storage.coordinators.listCoordinatorWorkflowAssociations(caller.projectId)
    ).filter(
      (item) =>
        item.kind === "multi-review" && item.nodeId === target.nodeId && item.resourceId === id,
    );
    const owned = associations.some(
      (item) =>
        item.coordinatorId === caller.coordinatorId &&
        item.conversationId === caller.conversationId &&
        !item.pending,
    );
    if (!owned && associations.some((item) => item.pending)) {
      throw new Error(
        "This workflow launch is still pending; retry launch_multi_review with its original requestId",
      );
    }
    if (!owned && associations.length > 0) {
      throw new Error(
        "Adopt this workflow into the current coordinator conversation before opening it",
      );
    }
    // Addressing adopts the review so its fix outcome reaches this conversation.
    const adopt = async () => {
      if (owned) return;
      await context.storage.coordinators.saveCoordinatorWorkflowAssociation({
        id: randomUUID(),
        ...caller,
        kind: "multi-review",
        resourceId: id,
        nodeId: target.nodeId,
        requestId: `address:${target.nodeId}:${id}`,
        createdAt: new Date().toISOString(),
      });
    };
    const open = (extra: JsonRecord, requestKey?: string) =>
      target
        .call<MultiReviewActionResult>(
          "controller_multi_review_surface",
          { workflowId: id, surface, ...extra },
          requestKey,
        )
        .catch((error: unknown) => {
          // A node from before the reviewer and custom-fix surfaces.
          if (
            error instanceof Error &&
            error.message.includes("Expected surface root, fix or address")
          )
            throw new Error(
              `${target.nodeName} runs an older Orkestrator that cannot do this yet; update it, then retry.`,
            );
          throw error;
        });
    if (surface === "address") await adopt();
    if (!customFix)
      return open(
        reviewerId ? { reviewerId } : {},
        surface === "address" ? `address:${caller.coordinatorId}:${id}` : undefined,
      );
    const { requestId, ...fix } = customFix;
    // The receipt keeps only the outcome; the workflow is read fresh, so a
    // replay reports where the fix is now rather than where it was.
    const outcome = await withCoordinatorReceipt(
      context,
      caller,
      {
        requestId,
        action: "custom-fix",
        payload: { workflowId: id, ...fix, nodeId: target.nodeId },
      },
      async () => {
        await adopt();
        const { workflow: _workflow, ...rest } = await withRetryAdvice(RETRY_SAME_REQUEST, () =>
          open(fix, `custom-fix:${caller.coordinatorId}:${requestId}`),
        );
        return rest as JsonRecord;
      },
    );
    const latest = await read();
    if (!record(latest) || !isMultiReviewWorkflow(latest.snapshot))
      throw new Error("Multi Review not found in this project on that node");
    return {
      ...(outcome as unknown as Omit<MultiReviewActionResult, "workflow">),
      workflow: {
        ...latest.snapshot,
        ...(typeof latest.revision === "number" ? { backendRevision: latest.revision } : {}),
      },
    } satisfies MultiReviewActionResult;
  });

  register(
    "start_coordinator_node_multi_review",
    async ({ scope, requestId, nodeId, buildPipelineId, input }, context) => {
      const caller = await identity(scope, context);
      const stableRequestId = asNonBlankString(requestId, "requestId");
      const pipelineId = asNonBlankString(buildPipelineId, "buildPipelineId");
      const target = await coordinatorNodeTarget(
        context,
        caller.projectId,
        asNonBlankString(nodeId, "nodeId"),
      );
      if (!record(input) || typeof input.environmentId !== "string") {
        throw new Error("Invalid scoped multi-review request");
      }
      await target.environment(input.environmentId);
      const payloadHash = actionHash({ nodeId: target.nodeId, input, buildPipelineId: pipelineId });
      return once(`${caller.coordinatorId}\0${stableRequestId}`, async () => {
        const receipt = await context.storage.coordinators.reserveCoordinatorWorkflowAssociation({
          id: randomUUID(),
          ...caller,
          kind: "multi-review",
          resourceId: randomUUID(),
          nodeId: target.nodeId,
          requestId: stableRequestId,
          payloadHash,
          dependsOnResourceId: pipelineId,
          createdAt: new Date().toISOString(),
        });
        if (!receipt.claimed && receipt.association.pending) {
          throw new Error("Multi-review creation is already in progress; retry this requestId");
        }
        const workflow = await target.call<JsonRecord>(
          "start_controller_multi_review",
          {
            input: { ...input, projectId: target.projectId },
            reservedId: receipt.association.resourceId,
            buildPipelineId: pipelineId,
          },
          `review:${caller.coordinatorId}:${stableRequestId}`,
        );
        if (!record(workflow) || typeof workflow.id !== "string") {
          throw new Error("Multi-review creation returned an invalid workflow");
        }
        if (receipt.association.pending) {
          await context.storage.coordinators.completeCoordinatorWorkflowAssociation(
            receipt.association.id,
            workflow.id,
          );
        }
        return workflow;
      });
    },
  );
}
