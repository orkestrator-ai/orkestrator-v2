import {
  AGENT_MAIL_MAX_MAILBOXES,
  AGENT_MAIL_MAX_LIST_LIMIT,
  AgentMailError,
  normalizeAgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";
import type { CommandRegistrar } from "./commands-registry-types.js";
import type { StorageService } from "./storage.js";

/**
 * Start a new routed mail budget for a tab that was just prompted.
 *
 * Called from the prompt commands, which a person (renderer, CLI) or a
 * coordinator request (`send_prompt_to_tab`) reaches but mail injection never
 * does: either way the next exchange was asked for rather than run away. Mail
 * bookkeeping must never block a prompt, so failure is logged and ignored.
 */
export async function resetAgentMailBudget(
  context: { storage: Pick<StorageService, "resetAgentMailBudgetForSession"> },
  environmentId: string,
  logicalSessionKey: string,
): Promise<void> {
  try {
    await context.storage.resetAgentMailBudgetForSession(environmentId, logicalSessionKey);
  } catch (error) {
    console.warn(
      "[agent-mail] Could not reset the mail budget for a prompted tab:",
      error instanceof Error ? error.message : error,
    );
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

async function requireMessagingEnabled(storage: StorageService) {
  const settings = normalizeAgentMessagingSettings(
    (await storage.loadConfig()).global.agentMessaging,
  );
  if (!settings.enabled) {
    throw new AgentMailError("messaging-disabled", "Agent messaging is disabled");
  }
  return settings;
}

export function registerAgentMailCommands(register: CommandRegistrar): void {
  // Not mail, but read by the same audiences: the renderer, Control MCP, and
  // any service that needs to know which agents exist and which are busy.
  register("get_agent_registry", async ({ projectId, environmentId }, context) => {
    if (!context.agentRegistry) throw new Error("Agent registry is unavailable");
    return context.agentRegistry.snapshot({
      ...(typeof projectId === "string" && projectId ? { projectId } : {}),
      ...(typeof environmentId === "string" && environmentId ? { environmentId } : {}),
    });
  });

  register(
    "list_agent_mailboxes",
    async ({ projectId, q, offset, limit, includeTombstoned, strictProjectScope }, { storage }) => {
      const settings = await requireMessagingEnabled(storage);
      return storage.listAgentMailboxes({
        ...(typeof projectId === "string" && projectId.trim()
          ? { projectId: projectId.trim() }
          : {}),
        allowCrossProject: strictProjectScope === true ? false : settings.allowCrossProject,
        ...(typeof q === "string" ? { q } : {}),
        ...(typeof offset === "number" ? { offset } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        includeTombstoned: includeTombstoned === true,
      });
    },
  );
  register("get_agent_mail_summary", async (_args, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.getAgentMailSummary();
  });
  register("get_agent_mail_inbox_snapshot", async (_args, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.getAgentMailInboxSnapshot();
  });
  register(
    "get_agent_mail_mailbox",
    async ({ environmentId, tabId, unreadOnly, offset, limit }, { storage }) => {
      await requireMessagingEnabled(storage);
      return storage.getAgentMailMailbox(
        required(environmentId, "environmentId"),
        required(tabId, "tabId"),
        {
          unreadOnly: unreadOnly === true,
          ...(typeof offset === "number" ? { offset } : {}),
          ...(typeof limit === "number" ? { limit } : {}),
        },
      );
    },
  );
  register("get_agent_mail_mailboxes", async ({ addresses }, { storage }) => {
    await requireMessagingEnabled(storage);
    if (!Array.isArray(addresses) || addresses.length > AGENT_MAIL_MAX_MAILBOXES) {
      throw new Error(`addresses must be an array of at most ${AGENT_MAIL_MAX_MAILBOXES} items`);
    }
    return storage.getAgentMailMailboxes(
      addresses.map((address, index) => {
        if (!address || typeof address !== "object" || Array.isArray(address)) {
          throw new Error(`addresses[${index}] must be an object`);
        }
        const record = address as Record<string, unknown>;
        return {
          environmentId: required(record.environmentId, `addresses[${index}].environmentId`),
          tabId: required(record.tabId, `addresses[${index}].tabId`),
        };
      }),
    );
  });
  register(
    "list_agent_mail_inbox",
    async ({ environmentId, tabId, unreadOnly, offset, limit }, { storage }) => {
      await requireMessagingEnabled(storage);
      return storage.getAgentMailMailbox(
        required(environmentId, "environmentId"),
        required(tabId, "tabId"),
        {
          unreadOnly: unreadOnly === true,
          ...(typeof offset === "number" ? { offset } : {}),
          ...(typeof limit === "number" ? { limit } : {}),
        },
      );
    },
  );
  register("get_agent_mail_message", async ({ environmentId, tabId, messageId }, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.getAgentMailMessage(
      required(environmentId, "environmentId"),
      required(tabId, "tabId"),
      required(messageId, "messageId"),
    );
  });
  register("get_agent_mail_status", async ({ messageId }, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.getAgentMailStatus(required(messageId, "messageId"));
  });
  register("list_agent_mail_sent", async ({ environmentId, tabId }, { storage }) => {
    await requireMessagingEnabled(storage);
    if (environmentId === undefined && tabId === undefined) return storage.listUserSentAgentMail();
    return storage.listAgentMailSentByMailbox(
      required(environmentId, "environmentId"),
      required(tabId, "tabId"),
    );
  });
  register("list_agent_mail_conversations", async ({ participant }, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.listAgentMailConversations(
      typeof participant === "string" && participant ? { participant } : {},
    );
  });
  register("get_agent_mail_conversation", async ({ a, b, limit }, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.getAgentMailConversation(
      required(a, "a"),
      required(b, "b"),
      typeof limit === "number" ? { limit } : {},
    );
  });
  register("mark_agent_mail_conversation_seen", async ({ a, b, messageIds }, { storage }) => {
    await requireMessagingEnabled(storage);
    const first = required(a, "a");
    const second = required(b, "b");
    if (!Array.isArray(messageIds) || messageIds.length > AGENT_MAIL_MAX_LIST_LIMIT)
      throw new Error(`messageIds must be an array of at most ${AGENT_MAIL_MAX_LIST_LIMIT} items`);
    const displayed = messageIds.map((id, index) => required(id, `messageIds[${index}]`));
    return {
      marked: await storage.markAgentMailConversationSeen(first, second, displayed),
    };
  });
  register(
    "send_agent_mail",
    ({ requestId, toEnvironmentId, toTabId, subject, body, replyToMessageId }, { storage }) =>
      storage.sendAgentMail(
        { kind: "user" },
        {
          requestId: required(requestId, "requestId"),
          toEnvironmentId: required(toEnvironmentId, "toEnvironmentId"),
          toTabId: required(toTabId, "toTabId"),
          body: required(body, "body"),
          ...(typeof subject === "string" ? { subject } : {}),
          ...(typeof replyToMessageId === "string" ? { replyToMessageId } : {}),
        },
      ),
  );
  register(
    "send_external_agent_mail",
    ({ requestId, toEnvironmentId, toTabId, subject, body }, { storage }) =>
      storage.sendAgentMail(
        { kind: "external" },
        {
          requestId: required(requestId, "requestId"),
          toEnvironmentId: required(toEnvironmentId, "toEnvironmentId"),
          toTabId: required(toTabId, "toTabId"),
          body: required(body, "body"),
          ...(typeof subject === "string" ? { subject } : {}),
        },
      ),
  );
  register("ack_agent_mail", ({ environmentId, tabId, messageId }, { storage }) =>
    storage.ackAgentMail(
      required(environmentId, "environmentId"),
      required(tabId, "tabId"),
      required(messageId, "messageId"),
    ),
  );
  register("mark_agent_mail_seen", ({ environmentId, tabId, messageId }, { storage }) =>
    storage.markAgentMailSeen(
      required(environmentId, "environmentId"),
      required(tabId, "tabId"),
      required(messageId, "messageId"),
    ),
  );
  register(
    "mute_agent_mail",
    ({ environmentId, tabId, inject, mutedInbound, mutedOutbound }, { storage }) => {
      if (inject !== undefined && inject !== "inherit" && inject !== "off" && inject !== "idle")
        throw new Error("inject must be inherit, off, or idle");
      return storage.updateAgentMailboxPolicy(
        required(environmentId, "environmentId"),
        required(tabId, "tabId"),
        {
          ...(inject ? { inject } : {}),
          ...(optionalBoolean(mutedInbound, "mutedInbound") !== undefined
            ? { mutedInbound: mutedInbound as boolean }
            : {}),
          ...(optionalBoolean(mutedOutbound, "mutedOutbound") !== undefined
            ? { mutedOutbound: mutedOutbound as boolean }
            : {}),
        },
      );
    },
  );
  register(
    "retry_agent_mail_inject",
    async ({ environmentId, tabId, messageId }, { storage, drainAgentMail }) => {
      const resolvedEnvironmentId = required(environmentId, "environmentId");
      const resolvedTabId = required(tabId, "tabId");
      const resolvedMessageId = required(messageId, "messageId");
      await storage.retryAgentMailInject(resolvedEnvironmentId, resolvedTabId, resolvedMessageId);
      await drainAgentMail?.();
      return storage.getAgentMailMessage(resolvedEnvironmentId, resolvedTabId, resolvedMessageId);
    },
  );
  register("discard_agent_mail_inject", ({ environmentId, tabId, messageId }, { storage }) =>
    storage.discardAgentMail(
      required(environmentId, "environmentId"),
      required(tabId, "tabId"),
      required(messageId, "messageId"),
    ),
  );
  register("get_agent_messaging_settings", async (_args, { storage }) =>
    normalizeAgentMessagingSettings((await storage.loadConfig()).global.agentMessaging),
  );
  register("update_agent_messaging_settings", async ({ settings }, { storage }) => {
    const current = await storage.loadConfig();
    const normalized = normalizeAgentMessagingSettings(
      settings,
      normalizeAgentMessagingSettings(current.global.agentMessaging),
    );
    return storage.updateGlobalConfig({ ...current.global, agentMessaging: normalized });
  });
  register("set_agent_messaging_paused", async ({ paused }, { storage }) => {
    if (typeof paused !== "boolean") throw new Error("paused must be a boolean");
    const current = await storage.loadConfig();
    const settings = normalizeAgentMessagingSettings(current.global.agentMessaging);
    await storage.updateGlobalConfig({
      ...current.global,
      agentMessaging: { ...settings, paused },
    });
    return { paused };
  });
}
