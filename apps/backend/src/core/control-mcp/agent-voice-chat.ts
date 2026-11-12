import { createHash } from "node:crypto";
/**
 * Agent voice chat over Control MCP: a voice agent's short, two-way exchange
 * with Orkestrator, separate from the main coordinator's conversation, plus
 * the one way it can reach that conversation: interrupting it.
 *
 * - `agent_voice_chat_say` opens a chat (with `projectId`) or continues one
 *   (`chatId`), and waits a few seconds for the spoken reply.
 * - `agent_voice_chat_listen` hears a reply that took longer, or catches up.
 * - `agent_voice_chat_end` ends a chat.
 * - `agent_voice_chat_interrupt` steers the main coordinator's running turn
 *   with the person's words (or prompts it when idle), or stops the turn.
 *
 * A reply is written by a quick, tool-free model run (the listener's
 * `agentVoiceChatReply`, `agent-voice-chat-replies.ts`) over a digest this module reads with the
 * caller's own authority: the coordinator's state and latest messages, the
 * project's agents, and what needs attention. The model therefore sees only
 * what the credential may read, and nothing it writes changes Orkestrator.
 * The interrupt is exactly one public session action under the caller's
 * `requestId`, like every other Control MCP mutation.
 *
 * This is not a coordinator side agent and creates none: the chat lives in
 * the listener's memory (`agent-voice-chats.ts`) and belongs to the credential.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import {
  AGENT_VOICE_CHAT_LIMITS,
  buildAgentVoiceChatPrompt,
  renderAgentVoiceChatInterrupt,
  type AgentVoiceChatView,
} from "@orkestrator/protocol/agent-voice-chat";
import type {
  AgentRegistryEntry,
  AgentRegistrySnapshot,
} from "@orkestrator/protocol/agent-registry";
import { stripCoordinatorContext } from "@orkestrator/protocol/coordinator";
import {
  publicSuccessEnvelope,
  isPublicRequestId,
  type PublicActionName,
} from "@orkestrator/protocol/public-api";
import type {
  PublicAttentionPage,
  PublicTranscriptPage,
} from "@orkestrator/protocol/public-api-resources";
import { stripSystemInstructions } from "@orkestrator/protocol/review-evidence-frames";
import {
  AgentVoiceChatError,
  type AgentVoiceChatHost,
  type AgentVoiceChatRecord,
} from "../agent-voice-chats.js";
import { allowed, dispatchAs, onNode, runPublicAction, type ControlMcpCaller } from "./caller.js";
import { sayForEnvelope } from "./gateway.js";
import { integer, leanSchema, oneOf, text } from "./lean-schema.js";
import { ControlMcpNodeError, operatorNode } from "./operator-tools.js";
import { adapterError, envelopeToolResult, type ControlMcpEnvelope } from "./results.js";
import { attentionSentence, spokenMailRow } from "./voice.js";

/** Each tool and the public actions it needs before it is listed. */
export const AGENT_VOICE_CHAT_TOOL_ACTIONS: Readonly<Record<string, readonly PublicActionName[]>> =
  Object.freeze({
    // A reply spends a model run on what the credential can read: the same bar as prompting.
    agent_voice_chat_say: ["session.prompt", "session.transcript"],
    agent_voice_chat_listen: ["session.prompt", "session.transcript"],
    agent_voice_chat_end: ["session.prompt", "session.transcript"],
    agent_voice_chat_interrupt: ["session.steer", "session.prompt", "session.stop"],
  });

export const AGENT_VOICE_CHAT_TOOL_NAMES = Object.keys(AGENT_VOICE_CHAT_TOOL_ACTIONS);

export function agentVoiceChatToolListed(caller: ControlMcpCaller, tool: string): boolean {
  const actions = AGENT_VOICE_CHAT_TOOL_ACTIONS[tool];
  return Boolean(caller.agentVoiceChats && actions?.every((action) => allowed(caller, action)));
}

// The voice list is byte-budgeted: only fields whose meaning is not obvious are described.
const REQUEST_ID = text("New per message; reuse only to retry it.");
const WAIT = integer(0, AGENT_VOICE_CHAT_LIMITS.waitMaxMs);

const SAY_INPUT = leanSchema<{
  text: string;
  requestId: string;
  chatId?: string;
  projectId?: string;
  nodeId?: string;
  waitMs?: number;
}>(
  {
    text: text(),
    requestId: REQUEST_ID,
    chatId: text("Or projectId to start one."),
    projectId: text(),
    nodeId: text(),
    waitMs: WAIT,
  },
  ["text", "requestId"],
);
const LISTEN_INPUT = leanSchema<{ chatId: string; afterTurnId?: string; waitMs?: number }>(
  { chatId: text(), afterTurnId: text(), waitMs: WAIT },
  ["chatId"],
);
const END_INPUT = leanSchema<{ chatId: string }>({ chatId: text() }, ["chatId"]);
const INTERRUPT_INPUT = leanSchema<{
  requestId: string;
  text?: string;
  mode?: "message" | "stop";
  chatId?: string;
  projectId?: string;
  nodeId?: string;
}>(
  {
    requestId: REQUEST_ID,
    text: text(),
    mode: oneOf(["message", "stop"]),
    chatId: text(),
    projectId: text(),
    nodeId: text(),
  },
  ["requestId"],
);

const mutationAnnotations = { idempotentHint: true } as const;

function short(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function success(tool: string, result: unknown): ControlMcpEnvelope {
  return publicSuccessEnvelope(tool, result) as ControlMcpEnvelope;
}

function chatFailure(tool: string, error: unknown): ControlMcpEnvelope {
  if (error instanceof AgentVoiceChatError) return adapterError(tool, error.code, error.message);
  if (error instanceof ControlMcpNodeError) {
    return adapterError(tool, error.code as never, error.message);
  }
  throw error;
}

/** The project's agents as the registry has them, on the chat's machine. */
async function projectAgents(
  caller: ControlMcpCaller,
  projectId: string,
  nodeId: string | undefined,
): Promise<AgentRegistryEntry[]> {
  const node = await operatorNode(caller, nodeId);
  const registry = await node.invoke<AgentRegistrySnapshot>("get_agent_registry", { projectId });
  return registry.entries.filter((entry) => entry.projectId === projectId);
}

function mainCoordinator(entries: readonly AgentRegistryEntry[]): AgentRegistryEntry | undefined {
  return entries.find(
    (entry) =>
      entry.ownerKind === "coordinator" && entry.coordinatorRole !== "side" && entry.sessionId,
  );
}

/** A transcript row as the digest shows it: the words, never the transport frames. */
function digestRow(message: PublicTranscriptPage["messages"][number]): string | null {
  if (message.role === "user") {
    const mail = spokenMailRow(message.text, message.textTruncated);
    if (mail) return `Coordinator received: ${mail}`;
  }
  const words = stripSystemInstructions(stripCoordinatorContext(message.text));
  if (!words.trim()) return null;
  const speaker =
    message.role === "assistant"
      ? "Coordinator said"
      : `${message.role === "user" ? "User" : message.role} wrote`;
  return `${speaker}: ${short(words, 500)}`;
}

/**
 * What the reply run knows: the coordinator's state and latest messages, the
 * project's other agents and what needs attention. Every read is the
 * caller's own; one that is not allowed or fails is left out, not guessed.
 */
async function projectDigest(
  caller: ControlMcpCaller,
  chat: AgentVoiceChatRecord,
): Promise<{ digest: string; projectName: string; coordinatorAgent?: string }> {
  const routed = onNode(caller, chat.nodeId);
  const lines: string[] = [];
  const [project, entries, attention] = await Promise.all([
    allowed(caller, "project.get")
      ? dispatchAs<{ name?: string }>(routed, "project.get", { projectId: chat.projectId }).catch(
          () => null,
        )
      : null,
    allowed(caller, "session.list") && allowed(caller, "session.get")
      ? projectAgents(caller, chat.projectId, chat.nodeId).catch(() => null)
      : null,
    allowed(caller, "attention.list")
      ? dispatchAs<PublicAttentionPage>(routed, "attention.list", { limit: 20 }).catch(() => null)
      : null,
  ]);
  const projectName = project?.ok ? (project.result.name ?? "") : "";
  const coordinator = entries ? mainCoordinator(entries) : undefined;
  if (!entries) {
    lines.push("The project's agents could not be read.");
  } else if (!coordinator) {
    lines.push("The main coordinator is not running.");
  } else {
    lines.push(
      `Main coordinator: ${coordinator.agent ?? "agent"}, ${coordinator.state}${coordinator.goal ? `, goal ${coordinator.goal.status}` : ""}.`,
    );
    const transcript = await dispatchAs<PublicTranscriptPage>(routed, "session.transcript", {
      sessionId: coordinator.sessionId,
      limit: 4,
    }).catch(() => null);
    if (transcript?.ok) {
      const rows = transcript.result.messages.map(digestRow).filter((row) => row !== null);
      lines.push(...(rows.length ? rows : ["The coordinator has no messages yet."]));
    }
  }
  if (entries) {
    const workers = entries.filter((entry) => entry.ownerKind === "environment");
    const busy = workers.filter((entry) => entry.state === "working" || entry.state === "waiting");
    lines.push(
      `${workers.length} agent tab${workers.length === 1 ? "" : "s"} in this project's environments, ${busy.length} working or waiting.`,
    );
    for (const entry of busy.slice(0, 8)) {
      lines.push(`- ${entry.displayName} in ${entry.environmentName}: ${entry.state}`);
    }
  }
  if (attention?.ok && entries) {
    const environments = new Set(entries.map((entry) => entry.environmentId));
    const items = attention.result.items.filter(
      (item) => item.environmentId !== null && environments.has(item.environmentId),
    );
    if (items.length) {
      lines.push("Needs attention:");
      for (const item of items.slice(0, 5)) lines.push(`- ${attentionSentence(item)}`);
    }
  }
  return {
    digest: lines.join("\n"),
    projectName,
    ...(coordinator?.agent ? { coordinatorAgent: coordinator.agent } : {}),
  };
}

function replyRun(caller: ControlMcpCaller, host: AgentVoiceChatHost) {
  return async (chat: AgentVoiceChatRecord, signal: AbortSignal) => {
    const { digest, projectName, coordinatorAgent } = await projectDigest(caller, chat);
    signal.throwIfAborted();
    // Every voice message since the last reply is answered together; notes stay context.
    const lastAgent = chat.turns.map((turn) => turn.role).lastIndexOf("agent");
    const history = chat.turns.filter((turn, index) => index <= lastAgent || turn.role === "event");
    const unanswered = chat.turns
      .slice(lastAgent + 1)
      .filter((turn) => turn.role === "voice")
      .map((turn) => turn.text);
    return host.reply({
      signal,
      prompt: buildAgentVoiceChatPrompt({
        projectName,
        digest,
        turns: history,
        message: unanswered.join(" … "),
      }),
      ...(coordinatorAgent ? { agent: coordinatorAgent } : {}),
    });
  };
}

function replyResult(host: AgentVoiceChatHost, chat: AgentVoiceChatRecord, turnId: string) {
  const reply = host.chats.replyTo(chat, turnId);
  return {
    chatId: chat.id,
    title: chat.title,
    turnId,
    state: reply ? "idle" : chat.state,
    reply: reply?.text ?? null,
    ...(reply ? { replyTurnId: reply.id } : {}),
    ...(!reply && chat.error ? { error: chat.error } : {}),
  };
}

function spokenReply(result: ReturnType<typeof replyResult>): string {
  if (result.reply) return result.reply;
  if (result.state === "failed") return `No reply: ${result.error ?? "try again"}.`;
  return "Still thinking.";
}

export function registerAgentVoiceChatTools(server: McpServer, caller: ControlMcpCaller): void {
  const host = caller.agentVoiceChats;
  if (!host) return;
  const profile = caller.profile;
  const owner = caller.credential.id;
  const listed = (tool: string) => agentVoiceChatToolListed(caller, tool);

  if (listed("agent_voice_chat_say")) {
    server.registerTool(
      "agent_voice_chat_say",
      {
        description:
          "Agent voice chat: quick two-way talk about a project, apart from its coordinator. Waits for the short spoken reply.",
        inputSchema: SAY_INPUT,
        annotations: mutationAnnotations,
      },
      async ({ text: said, requestId, chatId, projectId, nodeId, waitMs }) => {
        const tool = "agent_voice_chat_say";
        try {
          if (!said.trim() || !isPublicRequestId(requestId)) {
            return envelopeToolResult(
              adapterError(tool, "invalid-input", "Say something and pass a valid requestId"),
              profile,
            );
          }
          if (Array.from(said).length > AGENT_VOICE_CHAT_LIMITS.messageMaxChars) {
            return envelopeToolResult(
              adapterError(tool, "input-too-large", "Say it in fewer words"),
              profile,
            );
          }
          if (!chatId && !projectId) {
            return envelopeToolResult(
              adapterError(tool, "invalid-input", "Pass chatId, or projectId to start a chat"),
              profile,
            );
          }
          let chat: AgentVoiceChatRecord;
          if (chatId) {
            chat = host.chats.get(owner, chatId);
          } else {
            // A misheard project ID fails here, not as a reply about nothing.
            if (allowed(caller, "project.get")) {
              const project = await dispatchAs<{ id: string }>(
                onNode(caller, nodeId),
                "project.get",
                { projectId },
              );
              if (!project.ok) return envelopeToolResult(project, profile, sayForEnvelope(project));
            }
            chat = host.chats.openRequest({
              requestId,
              ownerId: owner,
              projectId: projectId!,
              ...(nodeId ? { nodeId } : {}),
              firstMessage: said,
            });
          }
          const { turn, replayed } = host.chats.say({
            ownerId: owner,
            chatId: chat.id,
            text: said,
            requestId,
            reply: replyRun(caller, host),
          });
          await host.chats.waitForReply(
            owner,
            chat.id,
            waitMs ?? AGENT_VOICE_CHAT_LIMITS.waitDefaultMs,
            turn.id,
          );
          const result = { ...replyResult(host, chat, turn.id), replayed };
          return envelopeToolResult(success(tool, result), profile, {
            say: spokenReply(result),
            ids: { chatId: chat.id, turnId: turn.id },
            ...(result.reply
              ? {}
              : result.state === "failed"
                ? { next: "Say it again with the same requestId to retry." }
                : { next: "Call agent_voice_chat_listen with chatId and afterTurnId=turnId." }),
          });
        } catch (error) {
          return envelopeToolResult(chatFailure(tool, error), profile);
        }
      },
    );
  }

  if (listed("agent_voice_chat_listen")) {
    server.registerTool(
      "agent_voice_chat_listen",
      {
        description: "Hear an agent voice chat's newest turns, waiting for a pending reply.",
        inputSchema: LISTEN_INPUT,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ chatId, afterTurnId, waitMs }) => {
        const tool = "agent_voice_chat_listen";
        try {
          await host.chats.waitForReply(
            owner,
            chatId,
            waitMs ?? AGENT_VOICE_CHAT_LIMITS.waitDefaultMs,
          );
          const chat = host.chats.get(owner, chatId);
          const view: AgentVoiceChatView = host.chats.view(chat, afterTurnId);
          const reply = view.turns.filter((turn) => turn.role === "agent").at(-1);
          const last = view.turns.at(-1);
          return envelopeToolResult(success(tool, view), profile, {
            say:
              view.state === "replying"
                ? "Still thinking."
                : view.state === "failed"
                  ? `No reply: ${view.error ?? "try again"}.`
                  : (reply?.text ?? "Nothing new."),
            ids: { chatId, ...(last ? { turnId: last.id } : {}) },
          });
        } catch (error) {
          return envelopeToolResult(chatFailure(tool, error), profile);
        }
      },
    );
  }

  if (listed("agent_voice_chat_end")) {
    server.registerTool(
      "agent_voice_chat_end",
      {
        description: "End an agent voice chat.",
        inputSchema: END_INPUT,
        annotations: { idempotentHint: true, destructiveHint: false },
      },
      async ({ chatId }) => {
        const tool = "agent_voice_chat_end";
        try {
          const chat = host.chats.end(owner, chatId);
          return envelopeToolResult(success(tool, { chatId: chat.id, ended: true }), profile, {
            say: "Voice chat ended.",
          });
        } catch (error) {
          return envelopeToolResult(chatFailure(tool, error), profile);
        }
      },
    );
  }

  if (listed("agent_voice_chat_interrupt")) {
    server.registerTool(
      "agent_voice_chat_interrupt",
      {
        description:
          "Interrupt a project's main coordinator: message gives it the person's words now (as a new message when idle); stop ends its turn.",
        inputSchema: INTERRUPT_INPUT,
        annotations: mutationAnnotations,
      },
      async ({ requestId, text: words, mode, chatId, projectId, nodeId }) => {
        const tool = "agent_voice_chat_interrupt";
        try {
          const chat = chatId ? host.chats.get(owner, chatId) : undefined;
          const project = chat?.projectId ?? projectId;
          const node = chat ? chat.nodeId : nodeId;
          if (!project) {
            return envelopeToolResult(
              adapterError(tool, "invalid-input", "Pass chatId or projectId"),
              profile,
            );
          }
          const stop = mode === "stop";
          if (!stop && !words?.trim()) {
            return envelopeToolResult(
              adapterError(tool, "empty-input", "Say what the coordinator should hear"),
              profile,
            );
          }
          if (words && Array.from(words).length > AGENT_VOICE_CHAT_LIMITS.interruptMaxChars) {
            return envelopeToolResult(
              adapterError(tool, "input-too-large", "Say it in fewer words"),
              profile,
            );
          }
          if (!isPublicRequestId(requestId))
            return envelopeToolResult(
              adapterError(tool, "invalid-input", "Pass a valid requestId"),
              profile,
            );
          const fingerprint = createHash("sha256")
            .update(
              JSON.stringify([
                node ?? "",
                project,
                mode ?? "message",
                words?.trim() ?? "",
                chat?.title ?? "",
              ]),
            )
            .digest("hex");
          const bindingInput = { ownerId: owner, requestId, fingerprint };
          let binding = host.bindInterrupt(bindingInput);
          if (!binding) {
            const coordinator = mainCoordinator(await projectAgents(caller, project, node));
            if (!coordinator?.sessionId)
              return envelopeToolResult(
                adapterError(tool, "not-found", "This project's main coordinator is not running"),
                profile,
                { say: "The coordinator is not running, so there is nothing to interrupt." },
              );
            binding = host.bindInterrupt({
              ...bindingInput,
              choice: {
                sessionId: coordinator.sessionId,
                action: stop
                  ? "session.stop"
                  : coordinator.state === "working" || coordinator.state === "waiting"
                    ? "session.steer"
                    : "session.prompt",
              },
            })!;
          }
          const routed = onNode(caller, node);
          const sessionId = binding.sessionId;
          const action = binding.action;
          const message = stop
            ? ""
            : renderAgentVoiceChatInterrupt({
                text: words!,
                ...(chat ? { chatTitle: chat.title } : {}),
              });
          const send = (chosen: typeof action) =>
            runPublicAction(
              routed,
              chosen,
              chosen === "session.stop"
                ? { sessionId }
                : chosen === "session.steer"
                  ? { sessionId, text: message }
                  : { sessionId, prompt: message },
              requestId,
              undefined,
            );
          const envelope = await send(action);
          // A refusal is returned as-is. Switching actions after admission can
          // race another delivery; a retry always uses this durable choice.
          if (chat && envelope.ok && !envelope.receipt?.replayed) {
            host.chats.note(
              owner,
              chat.id,
              stop
                ? "The voice agent stopped the coordinator's turn."
                : `The voice agent interrupted the coordinator: ${short(words!, 400)}`,
            );
          }
          return envelopeToolResult(envelope, profile, {
            ...sayForEnvelope(envelope),
            ...(envelope.ok
              ? {
                  say: stop
                    ? "Stopping the coordinator's turn."
                    : action === "session.steer"
                      ? "Interrupted the coordinator; it has your words now."
                      : "The coordinator was idle, so it got your words as a new message.",
                  ids: { sessionId, ...(chat ? { chatId: chat.id } : {}) },
                }
              : {}),
          });
        } catch (error) {
          return envelopeToolResult(chatFailure(tool, error), profile);
        }
      },
    );
  }
}
