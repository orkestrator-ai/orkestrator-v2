/** The shared agent mail tools: mailboxes, sending, reading and acknowledging. */
import { coordinatorDeliverNowResult } from "../coordinator-deliver-now.js";
import { nodeMailReplyTarget } from "../node-mail-reply-target.js";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  AGENT_MAIL_MAX_ATTACHMENT_BYTES,
  AGENT_MAIL_MAX_ATTACHMENTS,
} from "@orkestrator/protocol/agent-mail";
import {
  COMMAND_NODE_COORDINATOR_MAIL_ADDRESS,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import { Schema } from "effect";
import { describe, int, list, refine, str, toolInput, withDefault } from "../tool-schema.js";
import { mailboxFingerprint, pollKey } from "./poll-guard.js";
import { onNode as callerOnNode } from "./caller.js";
import {
  isRecord,
  nodeIdField,
  readAnnotations,
  toolResult,
  type JsonRecord,
} from "./tool-support.js";
import { operatorListMailboxes, operatorSendMessage } from "./operator-tools.js";
import type { ControlMcpInvoker } from "../control-shared-actions.js";
import type { CoordinatorControlScope } from "./tools.js";
import {
  asyncDelegationResult,
  coordinatorNodeRefused,
  type ControlMcpToolContext,
} from "./tools-shared.js";

/** This coordinator conversation's own mailbox address, if it still has one. */
async function ownConversationMailbox(
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
): Promise<{ environmentId: string; tabId: string } | null> {
  const snapshot = await invoke<unknown>("get_project_coordinator", { projectId: scope.projectId });
  const conversations =
    isRecord(snapshot) &&
    isRecord(snapshot.workspace) &&
    Array.isArray(snapshot.workspace.conversations)
      ? snapshot.workspace.conversations
      : [];
  const own = conversations.find((item) => isRecord(item) && item.id === scope.conversationId) as
    JsonRecord | undefined;
  return own && typeof own.tabId === "string"
    ? {
        environmentId: coordinatorRuntimeId(scope.coordinatorId, scope.conversationId),
        tabId: own.tabId,
      }
    : null;
}

/**
 * Refuse a mailbox other than this conversation's own: the one rule behind
 * reading a page, reading a message and acknowledging one. The conversation is
 * found whether or not it has closed, as its mailbox outlives it.
 */
async function assertOwnMailbox(
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
  input: { environmentId: string; tabId: string },
  verb: "read" | "acknowledge",
): Promise<void> {
  const own = await ownConversationMailbox(invoke, scope);
  if (!own || input.environmentId !== own.environmentId || input.tabId !== own.tabId) {
    throw new Error(`Coordinator credential may only ${verb} its own mailbox`);
  }
}

/** The agent mail tools, listed only while agent messaging is on. */
export function registerMailTools(
  server: McpServer,
  {
    invoke,
    coordinatorScope,
    operator,
    pollGuard,
    messagingEnabled,
    onNode,
    environmentInvoker,
  }: ControlMcpToolContext,
): void {
  if (messagingEnabled) {
    server.registerTool(
      "list_mailboxes",
      {
        title: "List agent mailboxes",
        description: coordinatorScope
          ? "List durable agent-message destinations without transcript or filesystem content. With environmentId, lists that environment's mailboxes; for a pipeline environment that is one mailbox per build pipeline worker (build, each reviewer, preparation, consolidation, address, verify, fix, PR, conflict resolution, every round), each with its address (tabId), pipelineWorker step, round, slot, label, agent, model and status (running, idle, finished, failed, cancelled). With nodeId and environmentId, lists that node's environment the same way; with nodeId alone, says whether that node's copy of this project has a coordinator you can reach with send_message, nodeId and toEnvironmentId \"coordinator\"."
          : "List durable agent-message destinations without transcript or filesystem content.",
        inputSchema: toolInput(
          Schema.Struct({
            q: Schema.optionalKey(str({ trim: true, max: 200 })),
            ...(coordinatorScope
              ? {
                  environmentId: Schema.optionalKey(
                    describe(
                      str({ trim: true, min: 1, max: 200 }),
                      "Only this environment's mailboxes, including its build pipeline workers.",
                    ),
                  ),
                }
              : {}),
            offset: withDefault(int({ min: 0 }), 0),
            limit: withDefault(int({ min: 1, max: 200 }), 100),
            nodeId: nodeIdField,
          }),
        ),
        annotations: readAnnotations(),
      },
      async ({ q, offset, limit, nodeId, ...filters }) => {
        if (operator)
          return operatorListMailboxes(callerOnNode(operator, nodeId), { q, offset, limit });
        const environmentId =
          "environmentId" in filters && typeof filters.environmentId === "string"
            ? filters.environmentId
            : undefined;
        if (coordinatorScope && environmentId) {
          // One environment, on this node or a connected one: its tabs and
          // its build pipeline workers.
          const { inv, target, where } = await environmentInvoker(nodeId, environmentId);
          const page = await inv<unknown>("list_agent_mailboxes", {
            environmentId,
            q,
            offset,
            limit,
            projectId: target ? target.projectId : coordinatorScope.projectId,
            strictProjectScope: true,
          });
          if (!isRecord(page)) throw new Error("Mailbox directory returned no result");
          return toolResult({ ...page, ...where });
        }
        if (coordinatorScope && nodeId) {
          // Another node's mailboxes are not listed; whether its coordinator
          // for this project can be reached is.
          const reach = await invoke<unknown>("get_coordinator_node_mailbox", {
            scope: coordinatorScope,
            nodeId,
          });
          if (!isRecord(reach)) throw new Error("That node returned no mailbox information");
          return toolResult(reach);
        }
        coordinatorNodeRefused(nodeId);
        const page = await invoke<unknown>("list_agent_mailboxes", {
          q,
          offset,
          limit,
          ...(coordinatorScope
            ? { projectId: coordinatorScope.projectId, strictProjectScope: true }
            : {}),
        });
        if (!isRecord(page)) throw new Error("Mailbox directory returned no result");
        return toolResult(page);
      },
    );

    server.registerTool(
      "send_message",
      {
        title: coordinatorScope ? "Send a coordinator message" : "Send an external agent message",
        description: coordinatorScope
          ? 'Durably send an authenticated same-project delegation or reply from this coordinator conversation. toTabId may be omitted: an environment resolves to the tab you are waiting on or its only agent tab. A pipeline environment never resolves that way: name one build pipeline worker with toTabId set to its address from list_mailboxes (with environmentId) or get_build_pipeline. The message goes to that worker only and is never re-routed; a worker that has finished, failed or been cancelled refuses it, and mail still queued when its worker ends expires and you are told. Queued mail reaches the worker as its next turn when its current turn ends, before the pipeline moves on; deliverNow steers it into the running turn. Side agents and the main coordinator reach each other through toEnvironmentId "coordinator" (to the main) or the side agent\'s environment id from list_mailboxes. To pass on an image the user pasted to you, do not describe it in words: name it in attachments; the backend copies it, you need no file access, and the recipient gets a path it can open. On a command node, nodeId with toEnvironmentId "coordinator" asks that node\'s main coordinator for this project (list_mailboxes with nodeId says whether it has one); its answer arrives as mail. On a node in leaf mode, toEnvironmentId "command-node-coordinator" starts a message to the controlling command node\'s coordinator, and replyToMessageId answers its mail; that is the only cross-node send there. A busy worker normally receives mail when its turn ends. Set deliverNow only for a course correction the worker must see mid-turn ("add this to your task", "stop, the requirement changed"), not for routine follow-ups or replies: if the worker\'s agent can steer, the message is steered into its running turn. The result\'s deliverNow says what happened: steered, delivered (worker was idle), queued until idle, unsupported, queued (agent cannot take mail mid-turn), verifying (steer handed off, being confirmed; never sent twice), or not queued. The project home (the user\'s own checkout) is for exceptional circumstances only: a message to it needs projectHomeReason, and is held for the user\'s approval unless you messaged it in the last 3 hours. Messages with images always need their own approval; their files are kept outside the user\'s checkout.'
          : "Durably place text in one Orkestrator tab inbox. External messages are never auto-injected into an agent turn.",
        inputSchema: toolInput(
          Schema.Struct({
            requestId: str({ trim: true, min: 1, max: 256 }),
            toEnvironmentId: str({ trim: true, min: 1, max: 200 }),
            toTabId: coordinatorScope
              ? Schema.optionalKey(str({ trim: true, min: 1, max: 200 }))
              : str({ trim: true, min: 1, max: 200 }),
            subject: Schema.optionalKey(str({ trim: true, max: 200 })),
            body: str({ min: 1 }).check(
              refine(
                (value) => Buffer.byteLength(value, "utf8") <= 32 * 1024,
                "body must be at most 32 KiB UTF-8",
              ),
            ),
            replyToMessageId: Schema.optionalKey(str({ trim: true, min: 1, max: 300 })),
            ...(coordinatorScope
              ? {
                  attachments: Schema.optionalKey(
                    describe(
                      list(str({ trim: true, min: 1, max: 1024 }), {
                        min: 1,
                        max: AGENT_MAIL_MAX_ATTACHMENTS,
                        maxMessage: `A message can carry at most ${AGENT_MAIL_MAX_ATTACHMENTS} images.`,
                      }),
                      `Images the user pasted into this conversation, by the path you were given with each one. They reach the recipient wherever it is: an agent tab, build pipeline worker, container, side agent or coordinator, on this node or another. PNG, JPEG, GIF or WebP, at most ${AGENT_MAIL_MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB each. Copied before sending: if a copy fails, no message is sent and you are told why; retry with the same requestId.`,
                    ),
                  ),
                  deliverNow: Schema.optionalKey(
                    describe(
                      Schema.Boolean,
                      "Steer this message into the worker's running turn instead of waiting for it to end. For course corrections only. Default false.",
                    ),
                  ),
                  projectHomeReason: Schema.optionalKey(
                    describe(
                      str({ trim: true, min: 1, max: 500 }),
                      "Required only when toEnvironmentId is the project home: why an isolated environment will not do. Shown to the user if the message needs their approval.",
                    ),
                  ),
                }
              : {}),
            nodeId: describe(
              nodeIdField,
              coordinatorScope
                ? 'Message an agent on that node (a nodeId from list_nodes); toEnvironmentId is that node\'s environment, or "coordinator" for its main coordinator. A reply to mail from another node goes back to it without nodeId.'
                : "Message an agent on that machine (a nodeId from list_nodes); toEnvironmentId is that machine's environment. Omit for this machine.",
            ),
          }),
        ),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ nodeId, deliverNow, ...input }) => {
        if (operator) {
          return operatorSendMessage(callerOnNode(operator, nodeId), input);
        }
        const target = await onNode(nodeId);
        if (coordinatorScope) {
          let remote: { nodeId: string; toEnvironmentId: string; toTabId?: string } | null = target
            ? {
                nodeId: target.nodeId,
                toEnvironmentId: input.toEnvironmentId,
                ...(input.toTabId ? { toTabId: input.toTabId } : {}),
              }
            : null;
          let upward = !remote && input.toEnvironmentId === COMMAND_NODE_COORDINATOR_MAIL_ADDRESS;
          if (!remote && !upward && input.replyToMessageId) {
            // A reply to mail from another node goes back across the node
            // link: to its agent or coordinator there, or, from a leaf's
            // coordinator, up to the command node's coordinator.
            const own = await ownConversationMailbox(invoke, coordinatorScope);
            const parent = own
              ? await invoke<unknown>("get_agent_mail_message", {
                  ...own,
                  messageId: input.replyToMessageId,
                }).catch(() => null)
              : null;
            if (!isRecord(parent))
              throw new Error("Reply parent could not be loaded from this conversation mailbox");
            const replyTarget = nodeMailReplyTarget(parent.from);
            if (replyTarget?.kind === "command-node") upward = true;
            else if (replyTarget) {
              remote = {
                nodeId: replyTarget.nodeId,
                toEnvironmentId: replyTarget.toEnvironmentId,
                ...(replyTarget.toTabId ? { toTabId: replyTarget.toTabId } : {}),
              };
            }
          }
          if (upward) {
            const sent = await invoke<unknown>("send_coordinator_command_node_mail", {
              scope: coordinatorScope,
              requestId: input.requestId,
              ...(input.subject ? { subject: input.subject } : {}),
              body: input.body,
              ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
              ...(input.attachments ? { attachments: input.attachments } : {}),
            });
            if (!isRecord(sent)) throw new Error("Message send returned no result");
            const { coordinatorDelegationOpened: _opened, ...summary } = sent;
            return toolResult({
              message: summary,
              ...(deliverNow === true
                ? coordinatorDeliverNowResult(summary, { unsupported: true })
                : {}),
            });
          }
          if (remote) {
            const sent = await invoke<unknown>("send_coordinator_node_mail", {
              scope: coordinatorScope,
              ...remote,
              requestId: input.requestId,
              ...(input.subject ? { subject: input.subject } : {}),
              body: input.body,
              ...(deliverNow === true ? { deliverNow: true } : {}),
              ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
              ...(input.attachments ? { attachments: input.attachments } : {}),
            });
            if (!isRecord(sent)) throw new Error("Message send returned no result");
            const {
              coordinatorDelegationOpened,
              deliverNow: remoteOutcome,
              deliverNowNote: remoteNote,
              // Mail to another node's coordinator says what happens next.
              delivery,
              wake,
              nextStep,
              delegationNote: remoteDelegationNote,
              ...summary
            } = sent;
            return toolResult({
              ...(typeof remoteDelegationNote === "string"
                ? { warning: remoteDelegationNote }
                : {}),
              message: summary,
              ...(delivery !== undefined ? { delivery, wake, nextStep } : {}),
              // The leaf's outcome when it could steer; an older leaf cannot.
              ...(deliverNow !== true
                ? {}
                : remoteOutcome !== undefined
                  ? { deliverNow: remoteOutcome, deliverNowNote: remoteNote }
                  : coordinatorDeliverNowResult(summary, { unsupported: true })),
              ...(coordinatorDelegationOpened === true ? asyncDelegationResult() : {}),
            });
          }
        }
        const message = await invoke<unknown>("send_coordinator_agent_mail", {
          ...input,
          ...coordinatorScope,
          ...(coordinatorScope && deliverNow === true ? { deliverNow: true } : {}),
        });
        if (!isRecord(message)) throw new Error("Message send returned no result");
        // A project-home message held for (or refused by) the user: nothing was sent.
        if (message.projectHome === true && message.sent === false)
          return toolResult({
            projectHomeApproval: message,
            ...(message.state === "pending"
              ? {
                  delivery: "async",
                  wake: "You will be woken by mail when the user approves (the message is then sent) or declines it.",
                  nextStep: "Finish your turn now. Do not poll.",
                }
              : {}),
          });
        const {
          body: _body,
          coordinatorDelegationOpened: delegationOpened,
          deliverNow: deliverNowOutcome,
          deliverNowNote,
          projectHome: _projectHome,
          projectHomeWarning,
          delegationNote,
          ...summary
        } = message;
        // The message was sent either way; a warning says what the coordinator
        // must not expect (a wake) and why, without reading as a failed send.
        const warnings = [projectHomeWarning, delegationNote].filter(
          (item): item is string => typeof item === "string",
        );
        return toolResult({
          ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          message: summary,
          ...(deliverNowOutcome !== undefined
            ? { deliverNow: deliverNowOutcome, deliverNowNote }
            : {}),
          ...(coordinatorScope && delegationOpened === true ? asyncDelegationResult() : {}),
        });
      },
    );

    if (coordinatorScope)
      server.registerTool(
        "read_messages",
        {
          title: "Read mailbox messages",
          description:
            "Read a bounded mailbox page. Coordinator credentials may only read their own conversation mailbox.",
          inputSchema: toolInput(
            Schema.Struct({
              environmentId: str({ trim: true, min: 1, max: 200 }),
              tabId: str({ trim: true, min: 1, max: 200 }),
              unreadOnly: withDefault(Schema.Boolean, false),
              offset: withDefault(int({ min: 0 }), 0),
              limit: withDefault(int({ min: 1, max: 200 }), 100),
            }),
          ),
          annotations: readAnnotations(),
        },
        async (input) => {
          if (coordinatorScope) await assertOwnMailbox(invoke, coordinatorScope, input, "read");
          const page = await invoke<unknown>("get_agent_mail_mailbox", input);
          if (!isRecord(page)) throw new Error("Mailbox returned no result");
          const guidance = pollGuard?.(
            // Paging and page size do not change the question being asked.
            pollKey("read_messages", input.environmentId, input.tabId, input.unreadOnly),
            mailboxFingerprint(page),
          );
          return toolResult(guidance ? { ...page, ...guidance } : page);
        },
      );

    if (coordinatorScope)
      server.registerTool(
        "get_message",
        {
          title: "Get a mailbox message",
          description: "Read one message body from this coordinator conversation's own mailbox.",
          inputSchema: toolInput(
            Schema.Struct({
              environmentId: str({ trim: true, min: 1, max: 200 }),
              tabId: str({ trim: true, min: 1, max: 200 }),
              messageId: str({ trim: true, min: 1, max: 300 }),
            }),
          ),
          annotations: readAnnotations(),
        },
        async (input) => {
          await assertOwnMailbox(invoke, coordinatorScope, input, "read");
          const message = await invoke<unknown>("get_agent_mail_message", input);
          if (!isRecord(message)) throw new Error("Mailbox message was not found");
          return toolResult({ message });
        },
      );

    if (coordinatorScope)
      server.registerTool(
        "get_message_status",
        {
          title: "Get message delivery status",
          description:
            "Inspect durable stored, pending, injected, acknowledged, and seen state without returning the message body.",
          inputSchema: toolInput(
            Schema.Struct({ messageId: str({ trim: true, min: 1, max: 300 }) }),
          ),
          annotations: readAnnotations(),
        },
        async ({ messageId }) => {
          const status = await invoke<unknown>("get_agent_mail_status", { messageId });
          if (!isRecord(status)) throw new Error("Message status was not found");
          const ownRuntime = coordinatorRuntimeId(
            coordinatorScope.coordinatorId,
            coordinatorScope.conversationId,
          );
          const from = isRecord(status.from) ? status.from : null;
          const allowedBySender = from?.projectId === coordinatorScope.projectId;
          const destination =
            typeof status.toEnvironmentId === "string" ? status.toEnvironmentId : "";
          if (!allowedBySender && destination !== ownRuntime) {
            const environment = await invoke<unknown>("get_environment", {
              environmentId: destination,
            });
            if (!isRecord(environment) || environment.projectId !== coordinatorScope.projectId) {
              throw new Error("Coordinator credential cannot inspect that message");
            }
          }
          // Guarded only after authorization, so a refusal can never answer for
          // a message this credential was not allowed to look at.
          const statusRefusal = pollGuard?.(
            pollKey("get_message_status", messageId),
            JSON.stringify({
              placement: status.placement,
              injectedAt: status.injectedAt,
              ackedAt: status.ackedAt,
              revision: status.revision,
            }),
          );
          return toolResult({ message: status, ...statusRefusal });
        },
      );

    if (coordinatorScope)
      server.registerTool(
        "ack_message",
        {
          title: "Acknowledge a mailbox message",
          description: "Mark a message handled without claiming that its task succeeded.",
          inputSchema: toolInput(
            Schema.Struct({
              environmentId: str({ trim: true, min: 1, max: 200 }),
              tabId: str({ trim: true, min: 1, max: 200 }),
              messageId: str({ trim: true, min: 1, max: 300 }),
            }),
          ),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (input) => {
          if (coordinatorScope) {
            await assertOwnMailbox(invoke, coordinatorScope, input, "acknowledge");
          }
          const result = await invoke<unknown>("ack_agent_mail", input);
          if (!isRecord(result)) throw new Error("Message acknowledgement returned no result");
          const { body: _body, ...summary } = result;
          return toolResult({ message: summary });
        },
      );
  }
}
