import {
  AgentMailError,
  normalizeAgentMessagingSettings,
  type AgentMailRefusalCode,
} from "@orkestrator/protocol/agent-mail";
import { PUBLIC_API_LIMITS, type PublicErrorCode } from "@orkestrator/protocol/public-api";
import { PublicActionError } from "./errors.js";
import {
  onlyActionKeys,
  optionalInteger,
  optionalString,
  requiredId,
  requiredString,
} from "./input.js";
import type {
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * Agent mail for operators: the same external-message path Control MCP's
 * `send_message` uses. External messages are always inbox-only; nothing here
 * can inject text into a running turn. The operation ID is the store's
 * request key, and a receipt carries the message ID, never its body.
 */

const MAIL_ERRORS: Record<AgentMailRefusalCode, PublicErrorCode> = {
  "rate-limited": "busy",
  "policy-denied": "capability-unavailable",
  "mailbox-backlog-full": "busy",
  "hop-limit": "conflict",
  "messaging-disabled": "capability-unavailable",
  "recipient-superseded": "not-found",
  "recipient-not-found": "not-found",
  "sender-not-found": "not-found",
  "idempotency-conflict": "request-conflict",
  "message-not-found": "not-found",
  "capability-denied": "capability-unavailable",
  "store-full": "store-capacity",
};

function publicMailError(error: unknown): unknown {
  if (error instanceof AgentMailError) {
    return new PublicActionError(MAIL_ERRORS[error.code] ?? "operation-failed", error.message, {
      details: { mailCode: error.code },
      ...(error.code === "rate-limited" || error.code === "mailbox-backlog-full"
        ? { retryable: true }
        : {}),
    });
  }
  return error;
}

/** Refused before admission, so a disabled inbox never consumes a request key. */
async function requireMessaging(context: PublicActionContext): Promise<void> {
  const config = await context.command.storage.loadConfig();
  if (!normalizeAgentMessagingSettings(config.global.agentMessaging).enabled) {
    throw new PublicActionError("capability-unavailable", "Agent messaging is disabled");
  }
}

const mailMailboxes: ReadActionHandler<{ q?: string; offset?: number; limit?: number }> = {
  kind: "read",
  action: "mail.mailboxes",
  parse(input) {
    onlyActionKeys(input, "mail.mailboxes");
    return {
      q: optionalString(input, "q", 200),
      offset: optionalInteger(input, "offset", 0, Number.MAX_SAFE_INTEGER),
      limit: optionalInteger(input, "limit", 1, PUBLIC_API_LIMITS.pageMaxItems),
    };
  },
  async run(input, context) {
    await requireMessaging(context);
    try {
      const page = await context.invoke<unknown>("list_agent_mailboxes", {
        ...(input.q ? { q: input.q } : {}),
        offset: input.offset ?? 0,
        limit: input.limit ?? 100,
      });
      return { result: page };
    } catch (error) {
      throw publicMailError(error);
    }
  },
};

interface SendInput {
  toEnvironmentId: string;
  toTabId: string;
  subject?: string;
  body: string;
}

const mailSend: MutationActionHandler<SendInput> = {
  kind: "mutation",
  action: "mail.send",
  parse(input) {
    onlyActionKeys(input, "mail.send");
    const body = requiredString(input, "body", 32 * 1024);
    if (Buffer.byteLength(body, "utf8") > 32 * 1024) {
      throw new PublicActionError("input-too-large", "body must be at most 32 KiB of UTF-8");
    }
    const subject = optionalString(input, "subject", 200)?.trim();
    const value: SendInput = {
      toEnvironmentId: requiredId(input, "toEnvironmentId"),
      toTabId: requiredId(input, "toTabId"),
      body,
      ...(subject ? { subject } : {}),
    };
    return {
      value,
      scope: `mailbox:${value.toEnvironmentId}:${value.toTabId}`,
      intent: { subject: value.subject ?? null, body },
    };
  },
  async prepare(input, context) {
    await requireMessaging(context);
    return {
      resources: { environmentId: input.toEnvironmentId, tabId: input.toTabId },
      async execute(operation) {
        let message: { id?: unknown; placement?: unknown };
        try {
          message = await context.invoke<{ id?: unknown; placement?: unknown }>(
            "send_external_agent_mail",
            { ...input, requestId: operation.operationId },
          );
        } catch (error) {
          throw publicMailError(error);
        }
        return {
          state: "succeeded",
          result: {
            messageId: typeof message.id === "string" ? message.id : null,
            toEnvironmentId: input.toEnvironmentId,
            toTabId: input.toTabId,
            placement: typeof message.placement === "string" ? message.placement : null,
          },
        };
      },
    };
  },
};

export const MAIL_HANDLERS: PublicActionHandler[] = [mailMailboxes, mailSend];
