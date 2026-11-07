import {
  AGENT_MAIL_MAX_BODY_BYTES,
  type AgentMailAttachment,
} from "@orkestrator/protocol/agent-mail";
import { BACKEND_CAPABILITIES } from "@orkestrator/protocol/backend-profile";
import { sendCoordinatorCommandNodeMailCommand } from "@orkestrator/protocol/contract/domains/node-mail";
import {
  COMMAND_NODE_COORDINATOR_MAIL_ADDRESS,
  COORDINATOR_MAIL_ADDRESS,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";

import type { CommandContext } from "./commands-context.js";
import { ASYNC_HANDLER } from "./commands-registry-async-decode.js";
import type { CoordinatorNodeTarget } from "./commands-registry-coordinator-nodes.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { coordinatorCaller } from "./coordinator-action-scope.js";
import { attachmentReferences, readCallerAttachments } from "./coordinator-mail-attachments.js";
import type { MailAttachmentBatch } from "./mail-attachments.js";
import { mailAttachmentBatchId, mailAttachmentFiles } from "./mail-attachments.js";

/**
 * Mail between a command node's main coordinator and a leaf's main
 * coordinator for the same repository (docs/architecture/agent-messaging.md,
 * "Node mail"; docs/architecture/command-nodes.md, "Leaf mode").
 *
 * - Down: `send_message` with `nodeId` and `toEnvironmentId: "coordinator"`
 *   calls the leaf's `deliver_node_mail` with the leaf's project. The leaf
 *   stores it as node mail from a coordinator, which wakes its main.
 * - Up: the leaf coordinator replies on that thread, or starts a message to
 *   `"command-node-coordinator"`; both wait in the leaf's outbox until the
 *   command node collects them, and arrive as an agent's mail (untrusted).
 *
 * Neither end is the other's worker: no delegation opens, and the command
 * node's pair budget for the leaf coordinator's mail, which only its user
 * resets, is what stops two coordinators waking each other forever.
 */

type JsonRecord = Record<string, unknown>;

function nonBlank(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected ${name}`);
  return value;
}

/**
 * Counted: a pre-contract leaf that predates `node-coordinator-mail`
 * (version-compatibility.md, Register). A leaf with the `node-mail` domain
 * always takes the address (the node-mail client's version 1).
 */
function olderNodeRefusal(nodeName: string): string {
  compatibilityPathUsage.record("node-coordinator-mail.older-node");
  return `${nodeName} runs an older Orkestrator whose coordinator cannot take mail from this one; update that machine, then retry. Its workers can still be messaged by environment id.`;
}

/** The command node's coordinator mails a leaf's main coordinator for this project. */
export async function sendToNodeCoordinator(
  target: CoordinatorNodeTarget,
  input: {
    coordinatorId: string;
    mailbox: { coordinatorEnvironmentId: string; coordinatorTabId: string };
    requestId: string;
    subject?: string;
    body: string;
    nodeParent?: { id: string; threadId: string; hopCount: number };
    /** Already in that node's spool, for its `deliver_node_mail` to place. */
    attachments?: MailAttachmentBatch;
    /** Left out by the node-mail client for a pre-contract leaf without `node-mail-turn-origin`. */
    turnOrigin?: "mail";
  },
): Promise<JsonRecord> {
  const mail = target.nodeMail(`mail:${input.coordinatorId}:${input.requestId}`);
  if (!mail.supports(BACKEND_CAPABILITIES.nodeCoordinatorMail)) {
    throw new Error(olderNodeRefusal(target.nodeName));
  }
  const delivered = await mail.deliver({
    controllerId: target.selfId,
    ...input.mailbox,
    requestId: input.requestId,
    toEnvironmentId: COORDINATOR_MAIL_ADDRESS,
    projectId: target.projectId,
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.turnOrigin ? { turnOrigin: input.turnOrigin } : {}),
    body: input.body,
    ...(input.nodeParent ? { nodeParent: input.nodeParent } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
  });
  const scheduled =
    delivered?.placement === "pending-inject" || delivered?.placement === "injected";
  return {
    nodeId: target.nodeId,
    node: target.nodeName,
    ...(delivered?.messageId ? { messageId: delivered.messageId } : {}),
    toEnvironmentId: COORDINATOR_MAIL_ADDRESS,
    ...(delivered?.toTabId ? { toTabId: delivered.toTabId } : {}),
    toEnvironmentName: "Coordinator",
    ...(delivered?.toTabName ? { toTabName: delivered.toTabName } : {}),
    ...(delivered?.placement ? { placement: delivered.placement } : {}),
    ...(delivered?.placementReason ? { placementReason: delivered.placementReason } : {}),
    ...(delivered?.attachments?.length
      ? { attachments: delivered.attachments as AgentMailAttachment[] }
      : {}),
    // Not a worker: nothing to wait on but its answer.
    coordinatorDelegationOpened: false,
    ...(scheduled
      ? {
          delivery: "async",
          wake: `The coordinator on ${target.nodeName} answers by mail; this conversation is woken when its reply arrives while its unattended budget remains. Held replies need the user to resume delivery.`,
          nextStep: "Finish your turn now. Do not poll.",
        }
      : {
          deliveryNote: `Not scheduled for the coordinator on ${target.nodeName} (${delivered?.placementReason ?? delivered?.placement ?? "unknown"}); it waits in that coordinator's inbox.`,
        }),
  };
}

/** Whether a node's copy of this project has a coordinator this one can mail. */
export async function nodeCoordinatorMailbox(target: CoordinatorNodeTarget): Promise<JsonRecord> {
  const node = { nodeId: target.nodeId, node: target.nodeName, projectId: target.projectId };
  const workers = `Workers on ${target.nodeName} are reached by environment id from list_environments with nodeId "${target.nodeId}".`;
  const mail = target.nodeMail();
  if (!mail.supports(BACKEND_CAPABILITIES.nodeCoordinatorMail)) {
    return {
      ...node,
      coordinator: { reachable: false, reason: olderNodeRefusal(target.nodeName) },
      workers,
    };
  }
  const answer = await mail.projectCoordinator({ projectId: target.projectId });
  if (!answer?.hasCoordinator) {
    return {
      ...node,
      coordinator: {
        reachable: false,
        reason: `${target.nodeName} has no coordinator for this project.`,
      },
      workers,
    };
  }
  return {
    ...node,
    coordinator: {
      reachable: true,
      address: COORDINATOR_MAIL_ADDRESS,
      ...(answer.main
        ? { title: answer.main.title, agent: answer.main.agent ?? null }
        : {
            note: "Its main conversation is closed: mail opens a new one with that node's default agent.",
          }),
    },
    workers,
  };
}

/**
 * The leaf side: this node's main coordinator writes to the command node's
 * coordinator. Registered on every backend; refused unless a command node
 * controls this one.
 */
export function registerCoordinatorCommandNodeMail(register: CommandRegistrar): void {
  // Lenient keys (`node-mail` domain): `coordinatorCaller` and `nonBlank` check them.
  register(
    sendCoordinatorCommandNodeMailCommand,
    async (args, context: CommandContext) => {
      const caller = await coordinatorCaller(args.scope, context);
      const workspace = await context.storage.coordinators.getCoordinatorWorkspaceById(
        caller.coordinatorId,
      );
      const conversation = workspace?.conversations.find(
        (item) => item.id === caller.conversationId && !item.closedAt,
      );
      if (!conversation) throw new Error("This coordinator conversation has no mailbox.");
      if (conversation.role === "side") {
        throw new Error(
          'A side agent can only message the main coordinator. Send to "coordinator".',
        );
      }
      if (!context.nodeCoordination) {
        throw new Error("Cross-node coordination is not available in this backend.");
      }
      const own = {
        environmentId: coordinatorRuntimeId(caller.coordinatorId, caller.conversationId),
        tabId: conversation.tabId,
      };
      const requestId = nonBlank(args.requestId, "requestId");
      const body = nonBlank(args.body, "body");
      if (Buffer.byteLength(body, "utf8") > AGENT_MAIL_MAX_BODY_BYTES) {
        throw new Error("body must be at most 32 KiB UTF-8");
      }
      const subject =
        typeof args.subject === "string" && args.subject.trim()
          ? args.subject.trim().slice(0, 200)
          : undefined;
      const replyToMessageId =
        typeof args.replyToMessageId === "string" && args.replyToMessageId.trim()
          ? args.replyToMessageId.trim()
          : undefined;
      if (replyToMessageId) {
        const parent = await context.storage.getAgentMailMessage(
          own.environmentId,
          own.tabId,
          replyToMessageId,
        );
        if (parent.from.kind !== "node" || parent.from.role !== "coordinator") {
          throw new Error("That message did not come from a command node's coordinator.");
        }
      }
      // Kept in this node's spool until the command node has collected the mail,
      // so a later deletion or a closed conversation cannot leave it hanging.
      const images = await readCallerAttachments(
        context,
        caller,
        attachmentReferences(args.attachments),
      );
      const sent = await context.nodeCoordination.sendFromCoordinator({
        ...(images.length
          ? {
              attachments: {
                batch: mailAttachmentBatchId([
                  caller.coordinatorId,
                  caller.conversationId,
                  requestId,
                ]),
                files: mailAttachmentFiles(images),
              },
              own: images,
            }
          : {}),
        projectId: caller.projectId,
        coordinatorEnvironmentId: own.environmentId,
        coordinatorTabId: own.tabId,
        requestId,
        ...(subject ? { subject } : {}),
        body,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      // Answered: the request leaves the inbox, as a worker's reply does.
      if (replyToMessageId) {
        await context.storage
          .ackAgentMail(own.environmentId, own.tabId, replyToMessageId)
          .catch(() => undefined);
      }
      const name = sent.controllerName ?? "the command node";
      return {
        outboxSeq: sent.item.seq,
        toEnvironmentId: COMMAND_NODE_COORDINATOR_MAIL_ADDRESS,
        ...(replyToMessageId ? { replyToMessageId } : {}),
        ...(images.length ? { attachments: images.map((file) => file.name) } : {}),
        placement: "node-outbox",
        coordinator: `command node ${name}`,
        deliveryHint: `queued for the coordinator on ${name}; delivered when it collects its mail with coordinator-mail support. Older command nodes leave it queued until updated.`,
        coordinatorDelegationOpened: false,
      };
    },
    ASYNC_HANDLER,
  );
}
