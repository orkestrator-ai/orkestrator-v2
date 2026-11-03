import { createHash, randomUUID } from "node:crypto";
import {
  COORDINATOR_MAIL_ADDRESS,
  COORDINATOR_PROJECT_HOME_MESSAGE_WINDOW_MS,
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import {
  PROJECT_HOME_MESSAGE_LIMITS,
  parseProjectHomeMessage,
  type ProjectHomeMessage,
} from "@orkestrator/protocol/project-home-message";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { CommandContext } from "./commands-context.js";
import { asNonBlankString } from "./commands-helpers.js";
import type { CommandRegistrar, RegistryDependencies } from "./commands-registry-types.js";
import {
  coordinatorDeliverNowResult,
  settleCoordinatorDeliverNow,
} from "./coordinator-deliver-now.js";
import type { Environment } from "./models.js";

/**
 * Coordinator mail to environments on this node (`send_message` without
 * `nodeId`), including the project home rule:
 *
 * The project home is the user's own writable checkout, so a main
 * coordinator's message to it needs a reason, and is held for the user's
 * approval (node action request `message-project-home`, the dialog
 * `request_environment_deletion` and `answer_worker_question` use) unless
 * this coordinator sent that project home a message in the last three hours.
 * Within the window it is sent with a warning. Only sent mail opens the
 * window: the mail store is the record of what was sent, and the user's own
 * prompts in the Home tab are not coordinator mail.
 *
 * A held message is replayed by its requestId: the approval request id is
 * derived from it, and an approval sends the mail under that same requestId,
 * so a retry finds the request (or the sent mail) instead of making another.
 */

const log = createLogger("coordinator");

type JsonRecord = Record<string, unknown>;
type Scope = { projectId: string; coordinatorId: string; conversationId: string };
type CoordinatorSender = Scope & {
  kind: "coordinator";
  environmentId: string;
  tabId: string;
};
interface OutgoingMail {
  requestId: string;
  toTabId: string;
  body: string;
  subject?: string;
  replyToMessageId?: string;
  steer: boolean;
}

export const PROJECT_HOME_REASON_REQUIRED =
  "That environment is the project home: the user's own checkout, where an agent's work conflicts with the user's own. Do the work in an isolated environment instead: start_build_pipeline for fully specified work (create_ticket first), or launch_environment with a prompt for smaller or interactive work. If an environment really will not do, tell the user why, then retry send_message with projectHomeReason saying why; it may need the user's approval.";

export const PROJECT_HOME_WARNING =
  "Sent to the project home, the user's own checkout. This is discouraged: work there conflicts with the user's own. Prefer an isolated environment (start_build_pipeline or launch_environment).";

/** The approval request a project-home message is held under; one per coordinator requestId. */
export function projectHomeApprovalRequestId(coordinatorId: string, requestId: string): string {
  return `project-home-message-${createHash("sha256")
    .update(`${coordinatorId}\0${requestId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/**
 * Open the delegation that makes a coordinator wait for one worker answer.
 *
 * Every way a coordinator can ask a worker for something funnels through here —
 * a launch, a job, a follow-up message — because the wake contract is per
 * request, not per launch: a coordinator that reads a report and replies has
 * asked a new question and earns exactly one more wake for it.
 *
 * Each request owns its own association. Reusing an environment-wide record
 * would overwrite another tab's outstanding wake; reusing the same request id
 * is still idempotent through the storage layer.
 */
export async function openWorkerDelegation(
  context: CommandContext,
  scope: Scope,
  workerEnvironmentId: string,
  workerTabId: string,
  requestId: string,
): Promise<boolean> {
  const association = await context.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: randomUUID(),
    projectId: scope.projectId,
    coordinatorId: scope.coordinatorId,
    conversationId: scope.conversationId,
    kind: "environment",
    resourceId: workerEnvironmentId,
    requestId: `delegation:${requestId}`,
    createdAt: new Date().toISOString(),
  });
  if (
    association.conversationId !== scope.conversationId ||
    association.resourceId !== workerEnvironmentId
  ) {
    throw new Error("Coordinator request id was reused with a different delegation target");
  }
  const opened = await context.storage.coordinators.openCoordinatorDelegation(
    association.id,
    workerTabId,
  );
  if (!opened) throw new Error("Coordinator delegation association was not found");
  return opened.delegation?.state === "running";
}

/** One coordinator message to an environment on this node, as a delegation. */
async function sendCoordinatorWorkerMail(
  context: CommandContext,
  sender: CoordinatorSender,
  destination: Environment,
  mail: OutgoingMail,
): Promise<JsonRecord> {
  const scope = {
    projectId: sender.projectId,
    coordinatorId: sender.coordinatorId,
    conversationId: sender.conversationId,
  };
  const { requestId, toTabId: requestedTabId, steer } = mail;
  const admit = <T>(work: () => Promise<T>) =>
    context.storage.withAgentMailWorkerAdmission(destination.id, work);
  const admitted = await admit(async () => {
    // A follow-up to a worker that is still on an earlier request joins
    // that delegation rather than opening a second one. The open delegation
    // does not close while this message is undelivered, so the worker reads
    // it in its next turn and the coordinator is woken once, after both.
    const joining = (await context.storage.coordinators.listOpenCoordinatorDelegations()).find(
      (association) =>
        association.coordinatorId === scope.coordinatorId &&
        association.kind === "environment" &&
        association.nodeId === undefined &&
        association.resourceId === destination.id &&
        (!requestedTabId || association.delegation?.workerTabId === requestedTabId) &&
        association.requestId !== `delegation:${requestId}`,
    );
    const message = await context.storage.sendAgentMail(
      sender,
      {
        requestId,
        toEnvironmentId: destination.id,
        toTabId: requestedTabId,
        body: mail.body,
        ...(mail.subject !== undefined ? { subject: mail.subject } : {}),
        ...(mail.replyToMessageId !== undefined ? { replyToMessageId: mail.replyToMessageId } : {}),
      },
      { newDelegation: !joining, steer },
    );
    const destinationTabId = message.toTabId;
    // Asking a worker something is a delegation, so the coordinator is woken
    // once when that worker's turn ends rather than on whatever it says
    // along the way. A message the recipient bounced or that was never
    // scheduled for delivery has asked nothing and opens nothing.
    let coordinatorDelegationOpened = false;
    if (message.placement === "pending-inject" && joining) {
      coordinatorDelegationOpened = true;
    } else if (message.placement === "pending-inject") {
      try {
        coordinatorDelegationOpened = await openWorkerDelegation(
          context,
          scope,
          destination.id,
          destinationTabId,
          requestId,
        );
      } catch (error) {
        log.warn("delegation.open-failed", {
          source: "outbound-message",
          error: formatLogError(error),
        });
      }
    }
    // Say plainly when the worker cannot read it yet: "pending" alone reads
    // as delivered to a coordinator deciding whether to wait.
    const recipientMailbox =
      destination.status === "stopped"
        ? await context.storage.getAgentMailMailbox(destination.id, destinationTabId)
        : null;
    const autoStarts =
      destination.environmentType === "local" &&
      recipientMailbox?.descriptor.coordinatorOrigin === sender.environmentId;
    const deliveryNote =
      destination.status !== "stopped"
        ? undefined
        : autoStarts
          ? "The worker's environment is stopped. Orkestrator will attempt to start it once; the message is delivered once it is running."
          : "The recipient environment is stopped and is not started automatically. Call start_environment to deliver this message, or ask the user.";
    return {
      ...message,
      coordinatorDelegationOpened,
      ...(deliveryNote ? { deliveryNote } : {}),
    };
  });
  // Outside the admission lock: the delivery pass may need it.
  if (!steer) return admitted;
  return {
    ...(await settleCoordinatorDeliverNow(context, admitted)),
    coordinatorDelegationOpened: admitted.coordinatorDelegationOpened,
    ...(admitted.deliveryNote ? { deliveryNote: admitted.deliveryNote } : {}),
  };
}

/** Whether this coordinator sent `homeId` mail within the project-home window. */
async function projectHomeWindowOpen(
  context: CommandContext,
  coordinatorId: string,
  homeId: string,
): Promise<boolean> {
  const latest = await context.storage.latestCoordinatorMailTo(homeId, coordinatorId);
  return (
    latest !== null && Date.now() - Date.parse(latest) < COORDINATOR_PROJECT_HOME_MESSAGE_WINDOW_MS
  );
}

/** What a coordinator is told about a held message, by the request's state. */
function heldResult(
  request: { requestId: string; state: string; result?: { message: string } },
  home: Environment,
): JsonRecord {
  const base = {
    projectHome: true,
    toEnvironmentId: home.id,
    toEnvironmentName: home.name,
    approvalRequestId: request.requestId,
    state: request.state,
  };
  if (request.state === "pending")
    return {
      ...base,
      sent: false,
      note: `Not sent yet: you have not messaged the project home “${home.name}” in the last 3 hours, so the user must approve this message first. You will be woken by mail when they approve or decline it.`,
    };
  return {
    ...base,
    sent: false,
    note:
      request.state === "rejected"
        ? "The user declined this message to the project home; it was not sent. Use an isolated environment instead, or ask the user."
        : `This message to the project home was not sent (${request.state}). ${request.result?.message ?? ""}`.trim(),
  };
}

export function registerCoordinatorWorkerMailCommands(
  register: CommandRegistrar,
  dependencies: Pick<RegistryDependencies, "commands">,
): void {
  const run = async <T>(context: CommandContext, command: string, args: JsonRecord): Promise<T> => {
    const handler = dependencies.commands.get(command);
    if (!handler) throw new Error(`Backend command is unavailable: ${command}`);
    return (await handler(args, context)) as T;
  };

  /**
   * Hold a main coordinator's project-home message for the user's approval,
   * or replay the request an earlier attempt with the same requestId made.
   * An executed request means the mail was sent: the caller replays it.
   */
  const holdProjectHomeMessage = async (
    context: CommandContext,
    sender: CoordinatorSender,
    home: Environment,
    reason: string,
    mail: OutgoingMail,
  ): Promise<{ held: JsonRecord } | { sent: true }> => {
    const approvalRequestId = projectHomeApprovalRequestId(sender.coordinatorId, mail.requestId);
    const existing = await context.nodeCoordination?.actions.get(approvalRequestId);
    // A direct send has no approval record. Replay it before consulting the clock;
    // the mail store also refuses a changed payload under the same request id.
    if (
      !existing &&
      (await context.storage.replayAgentMail(sender, {
        requestId: mail.requestId,
        toEnvironmentId: home.id,
        toTabId: mail.toTabId,
        body: mail.body,
        ...(mail.subject !== undefined ? { subject: mail.subject } : {}),
        ...(mail.replyToMessageId !== undefined ? { replyToMessageId: mail.replyToMessageId } : {}),
      }))
    )
      return { sent: true };
    // Before the first request exists, a recent sent message lets this one through.
    if (!existing && (await projectHomeWindowOpen(context, sender.coordinatorId, home.id)))
      return { sent: true };
    const projectHomeMessage: ProjectHomeMessage | null = parseProjectHomeMessage({
      mailRequestId: mail.requestId,
      ...(mail.toTabId ? { toTabId: mail.toTabId } : {}),
      ...(mail.subject !== undefined ? { subject: mail.subject } : {}),
      body: mail.body,
      ...(mail.replyToMessageId !== undefined ? { replyToMessageId: mail.replyToMessageId } : {}),
      ...(mail.steer ? { deliverNow: true } : {}),
    });
    if (!projectHomeMessage) throw new Error("That message cannot be held for approval.");
    const self = await run<JsonRecord>(context, "get_node_status", {});
    const request = await run<{
      requestId: string;
      state: string;
      result?: { message: string };
    }>(context, "create_node_action_request", {
      requestId: approvalRequestId,
      kind: "message-project-home",
      targets: [
        {
          nodeId: self.nodeId,
          nodeName: "this machine",
          environmentId: home.id,
          environmentName: home.name,
          projectId: sender.projectId,
        },
      ],
      requestedBy: {
        coordinatorEnvironmentId: sender.environmentId,
        coordinatorTabId: sender.tabId,
        projectId: sender.projectId,
      },
      reason,
      projectHomeMessage,
    });
    // Approved and sent (or being sent): the same requestId replays that mail.
    if (
      request.state === "executed" ||
      request.state === "approved" ||
      request.state === "outcome-unknown"
    )
      return { sent: true };
    return { held: heldResult(request, home) };
  };

  register(
    "send_coordinator_agent_mail",
    async (
      {
        projectId,
        coordinatorId,
        conversationId,
        requestId,
        toEnvironmentId,
        toTabId,
        subject,
        body,
        replyToMessageId,
        deliverNow,
        projectHomeReason,
      },
      context,
    ) => {
      const project = asNonBlankString(projectId, "projectId");
      const coordinator = asNonBlankString(coordinatorId, "coordinatorId");
      const conversation = asNonBlankString(conversationId, "conversationId");
      const steer = deliverNow === true;
      const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(coordinator);
      if (!workspace || workspace.projectId !== project || workspace.lifecycleState !== "ready") {
        throw new Error("Coordinator identity is unavailable");
      }
      const tab = workspace.conversations.find(
        (item) => item.id === conversation && !item.closedAt,
      );
      if (!tab) throw new Error("Coordinator conversation is unavailable");
      const sender: CoordinatorSender = {
        kind: "coordinator",
        projectId: project,
        coordinatorId: coordinator,
        conversationId: conversation,
        environmentId: coordinatorRuntimeId(coordinator, conversation),
        tabId: tab.tabId,
      };
      const stableRequestId = asNonBlankString(requestId, "requestId");
      const target = asNonBlankString(toEnvironmentId, "toEnvironmentId");
      // Main ↔ side agent mail. Not a delegation: nothing to wait on, and the
      // mail store decides which of the two may talk to which.
      if (
        target === COORDINATOR_MAIL_ADDRESS ||
        coordinatorIdFromRuntimeId(target) === coordinator
      ) {
        const message = await context.storage.sendAgentMail(sender, {
          requestId: stableRequestId,
          toEnvironmentId: target,
          toTabId: typeof toTabId === "string" ? toTabId : "",
          body: asNonBlankString(body, "body"),
          ...(typeof subject === "string" ? { subject } : {}),
          ...(typeof replyToMessageId === "string" ? { replyToMessageId } : {}),
        });
        return {
          ...message,
          coordinatorDelegationOpened: false,
          // A coordinator conversation is never steered: a side agent must not
          // cut into the main's turn with the user, nor the main into a side's.
          ...(steer ? coordinatorDeliverNowResult(message) : {}),
        };
      }
      if (tab.role === "side") {
        throw new Error(
          'A side agent can only message the main coordinator. Send to "coordinator".',
        );
      }
      const destination = await context.storage.getEnvironment(target);
      if (!destination || destination.projectId !== project) {
        throw new Error("Coordinator messages must stay within their project");
      }
      const mail: OutgoingMail = {
        requestId: stableRequestId,
        toTabId: typeof toTabId === "string" ? toTabId.trim() : "",
        body: asNonBlankString(body, "body"),
        ...(typeof subject === "string" ? { subject } : {}),
        ...(typeof replyToMessageId === "string" ? { replyToMessageId } : {}),
        steer,
      };
      if (destination.projectHome !== true)
        return sendCoordinatorWorkerMail(context, sender, destination, mail);
      const reason =
        typeof projectHomeReason === "string" ? projectHomeReason.trim().replace(/\s+/g, " ") : "";
      if (!reason) throw new Error(PROJECT_HOME_REASON_REQUIRED);
      if (reason.length > PROJECT_HOME_MESSAGE_LIMITS.reasonChars)
        throw new Error(
          `projectHomeReason must be at most ${PROJECT_HOME_MESSAGE_LIMITS.reasonChars} characters.`,
        );
      const admitted = await holdProjectHomeMessage(context, sender, destination, reason, mail);
      if ("held" in admitted) return admitted.held;
      return {
        ...(await sendCoordinatorWorkerMail(context, sender, destination, mail)),
        projectHome: true,
        projectHomeWarning: PROJECT_HOME_WARNING,
      };
    },
  );

  /**
   * Runs only from the user's approval of a `message-project-home` request
   * (the coordinator's command invoker refuses it by name). Sends the held
   * message exactly as the coordinator wrote it, from the conversation that
   * asked, under its own requestId.
   */
  register("send_approved_project_home_message", async ({ approvalRequestId }, context) => {
    const id = asNonBlankString(approvalRequestId, "approvalRequestId");
    const request = await context.nodeCoordination?.actions.get(id);
    const held = request?.projectHomeMessage;
    if (
      !request ||
      request.kind !== "message-project-home" ||
      request.state !== "approved" ||
      !held
    )
      throw new Error("Only an approved project home message can be sent.");
    const [target] = request.targets;
    const runtimeId = request.requestedBy.coordinatorEnvironmentId;
    const coordinatorId = coordinatorIdFromRuntimeId(runtimeId);
    const conversationId = coordinatorConversationIdFromRuntimeId(runtimeId);
    if (!target?.environmentId || !coordinatorId || !conversationId)
      throw new Error("The request does not name a coordinator and a project home.");
    const projectId = request.requestedBy.projectId;
    const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(coordinatorId);
    const tab = workspace?.conversations.find(
      (item) =>
        item.id === conversationId &&
        item.tabId === request.requestedBy.coordinatorTabId &&
        !item.closedAt,
    );
    if (!workspace || workspace.projectId !== projectId || !tab)
      return { result: "stale", reason: "The coordinator conversation that asked was closed." };
    if (workspace.lifecycleState !== "ready")
      throw new Error("The coordinator is paused or unavailable; nothing was sent.");
    const home = await context.storage.getEnvironment(target.environmentId);
    if (!home || home.projectHome !== true || home.projectId !== projectId)
      return { result: "stale", reason: "The project home no longer exists." };
    const message = await sendCoordinatorWorkerMail(
      context,
      {
        kind: "coordinator",
        projectId,
        coordinatorId,
        conversationId,
        environmentId: coordinatorRuntimeId(coordinatorId, conversationId),
        tabId: tab.tabId,
      },
      home,
      {
        requestId: held.mailRequestId,
        toTabId: held.toTabId ?? "",
        body: held.body,
        ...(held.subject !== undefined ? { subject: held.subject } : {}),
        ...(held.replyToMessageId !== undefined ? { replyToMessageId: held.replyToMessageId } : {}),
        steer: held.deliverNow === true,
      },
    );
    if (message.placement === "bounced" || message.placement === "undeliverable")
      throw new Error(
        `The project home message was not sent (${message.placement}: ${message.placementReason ?? "recipient unavailable"}).`,
      );
    return {
      result: "sent",
      ...(typeof message.id === "string" ? { messageId: message.id } : {}),
      ...(typeof message.placement === "string" ? { placement: message.placement } : {}),
    };
  });
}
