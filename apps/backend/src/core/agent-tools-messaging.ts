import { AgentMailError, AGENT_MAIL_MAX_BODY_BYTES } from "@orkestrator/protocol/agent-mail";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { StorageService } from "./storage.js";

export type AgentMessagingToolScope = {
  environmentId: string;
  projectId: string;
  tabId?: string;
  requireUniqueTab?: boolean;
};
export type AgentMessagingRateLimitKind = "read" | "send";

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorText(error: unknown): never {
  if (error instanceof AgentMailError) throw new Error(`${error.code}: ${error.message}`);
  throw error;
}

async function assertCallerMailbox(
  storage: StorageService,
  scope: AgentMessagingToolScope,
  tabId: string,
) {
  if (scope.tabId && tabId !== scope.tabId) {
    throw new AgentMailError("capability-denied", "This credential belongs to another tab");
  }
  if (!scope.tabId) {
    throw new AgentMailError(
      "capability-denied",
      "Agent messaging requires a tab-scoped credential",
    );
  }
  if (
    scope.requireUniqueTab &&
    (await storage.resolveUniqueAgentMailPullTabId(scope.environmentId)) !== tabId
  ) {
    throw new AgentMailError(
      "capability-denied",
      "This environment credential no longer identifies one agent tab",
    );
  }
  const mailbox = await storage.getAgentMailMailbox(scope.environmentId, tabId, { limit: 1 });
  if (!mailbox.descriptor.capabilities.canPull || mailbox.descriptor.kind === "ui") {
    throw new AgentMailError(
      "capability-denied",
      "This mailbox is available only to the user interface",
    );
  }
  return mailbox;
}

export function registerAgentMessagingTools(
  server: McpServer,
  storage: StorageService,
  scope: AgentMessagingToolScope,
  consumeRateLimit: (kind: AgentMessagingRateLimitKind) => void,
): void {
  server.registerTool(
    "list_mailboxes",
    {
      title: "List agent mailboxes",
      description:
        "Discover addressable tabs. Cache addresses for the current task; do not poll this directory.",
      inputSchema: z.object({
        q: z.string().trim().max(200).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(100),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ q, offset, limit }) => {
      consumeRateLimit("read");
      const config = await storage.loadConfig();
      try {
        return result(
          await storage.listAgentMailboxes({
            projectId: scope.projectId,
            allowCrossProject: config.global.agentMessaging?.allowCrossProject === true,
            q,
            offset,
            limit,
          }),
        );
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send an agent message",
      description:
        "Durably send bounded Markdown text to one tab. The recipient may have opted into idle delivery, so this can start a turn that edits files. Use a stable requestId when retrying.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        fromTabId: z.string().trim().min(1).max(256),
        toEnvironmentId: z.string().trim().min(1).max(256),
        toTabId: z.string().trim().min(1).max(256),
        subject: z.string().trim().max(200).optional(),
        body: z
          .string()
          .min(1)
          .refine(
            (value) => Buffer.byteLength(value, "utf8") <= AGENT_MAIL_MAX_BODY_BYTES,
            "body must be at most 32 KiB UTF-8",
          ),
        replyToMessageId: z.string().trim().min(1).max(256).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fromTabId, ...input }) => {
      consumeRateLimit("send");
      try {
        await assertCallerMailbox(storage, scope, fromTabId);
        const message = await storage.sendAgentMail(
          {
            kind: "tab",
            environmentId: scope.environmentId,
            projectId: scope.projectId,
            tabId: fromTabId,
          },
          input,
        );
        return result({ message: { ...message, body: undefined } });
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "check_inbox",
    {
      title: "Check agent inbox",
      description:
        "List message metadata without bodies or acknowledgement. Do not poll; check at task boundaries and after long operations.",
      inputSchema: z.object({
        tabId: z.string().trim().min(1).max(256),
        unreadOnly: z.boolean().default(true),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(100),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tabId, unreadOnly, offset, limit }) => {
      consumeRateLimit("read");
      try {
        const mailbox = await assertCallerMailbox(storage, scope, tabId);
        const snapshot = await storage.getAgentMailMailbox(scope.environmentId, tabId, {
          unreadOnly,
          offset,
          limit,
          incarnationId: mailbox.descriptor.incarnationId,
        });
        return result({ ...snapshot });
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "read_message",
    {
      title: "Read an agent message",
      description: "Read one message body. Reading does not acknowledge it.",
      inputSchema: z.object({
        tabId: z.string().trim().min(1).max(256),
        messageId: z.string().trim().min(1).max(256),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tabId, messageId }) => {
      consumeRateLimit("read");
      try {
        const mailbox = await assertCallerMailbox(storage, scope, tabId);
        const message = await storage.getAgentMailMessage(scope.environmentId, tabId, messageId);
        if (message.toIncarnationId !== mailbox.descriptor.incarnationId) {
          throw new AgentMailError(
            "recipient-superseded",
            "Message belongs to a prior incarnation of this tab",
          );
        }
        return result({
          message,
        });
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "ack_message",
    {
      title: "Acknowledge an agent message",
      description:
        "Explicitly acknowledge one received message. This is idempotent and separate from the human seen receipt.",
      inputSchema: z.object({
        tabId: z.string().trim().min(1).max(256),
        messageId: z.string().trim().min(1).max(256),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tabId, messageId }) => {
      consumeRateLimit("read");
      try {
        const mailbox = await assertCallerMailbox(storage, scope, tabId);
        const current = await storage.getAgentMailMessage(scope.environmentId, tabId, messageId);
        if (current.toIncarnationId !== mailbox.descriptor.incarnationId) {
          throw new AgentMailError(
            "recipient-superseded",
            "Message belongs to a prior incarnation of this tab",
          );
        }
        const message = await storage.ackAgentMail(scope.environmentId, tabId, messageId);
        return result({ message: { ...message, body: undefined } });
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "reply_message",
    {
      title: "Reply to an agent message",
      description:
        "Reply to one inbound message. The backend derives the sender and destination; this tool cannot redirect the thread.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        fromTabId: z.string().trim().min(1).max(256),
        messageId: z.string().trim().min(1).max(256),
        subject: z.string().trim().max(200).optional(),
        body: z
          .string()
          .min(1)
          .refine(
            (value) => Buffer.byteLength(value, "utf8") <= AGENT_MAIL_MAX_BODY_BYTES,
            "body must be at most 32 KiB UTF-8",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fromTabId, messageId, requestId, body, subject }) => {
      consumeRateLimit("send");
      try {
        await assertCallerMailbox(storage, scope, fromTabId);
        const message = await storage.replyAgentMail(
          {
            kind: "tab",
            environmentId: scope.environmentId,
            projectId: scope.projectId,
            tabId: fromTabId,
          },
          messageId,
          requestId,
          body,
          subject,
        );
        await storage.ackAgentMail(scope.environmentId, fromTabId, messageId);
        return result({ message: { ...message, body: undefined } });
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "get_message_status",
    {
      title: "Get sent-message status",
      description: "Read placement and receipt state for one message sent by this tab.",
      inputSchema: z.object({
        fromTabId: z.string().trim().min(1).max(256),
        messageId: z.string().trim().min(1).max(256),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fromTabId, messageId }) => {
      consumeRateLimit("read");
      try {
        const mailbox = await assertCallerMailbox(storage, scope, fromTabId);
        const message = await storage.getAgentMailStatus(messageId);
        if (
          message.from.kind !== "tab" ||
          message.from.environmentId !== scope.environmentId ||
          message.from.tabId !== fromTabId ||
          message.from.incarnationId !== mailbox.descriptor.incarnationId
        ) {
          throw new AgentMailError("policy-denied", "Message was not sent by this tab");
        }
        return result({ message });
      } catch (error) {
        return errorText(error);
      }
    },
  );
}
