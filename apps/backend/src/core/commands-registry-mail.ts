import {
  AGENT_MAIL_MAX_MAILBOXES,
  AgentMailError,
  normalizeAgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";
import type { CommandRegistrar } from "./commands-registry-types.js";
import type { StorageService } from "./storage.js";

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
  register(
    "list_agent_mailboxes",
    async ({ projectId, q, offset, limit, includeTombstoned }, { storage }) => {
      const settings = await requireMessagingEnabled(storage);
      return storage.listAgentMailboxes({
        ...(typeof projectId === "string" && projectId.trim()
          ? { projectId: projectId.trim() }
          : {}),
        allowCrossProject: settings.allowCrossProject,
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
  register("retry_agent_mail_inject", ({ environmentId, tabId, messageId }, { storage }) =>
    storage.retryAgentMailInject(
      required(environmentId, "environmentId"),
      required(tabId, "tabId"),
      required(messageId, "messageId"),
    ),
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
