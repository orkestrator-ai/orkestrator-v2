import {
  AGENT_MAIL_MAX_MAILBOXES,
  AGENT_MAIL_MAX_LIST_LIMIT,
  AgentMailError,
  normalizeAgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";
import {
  ackAgentMailCommand,
  discardAgentMailInjectCommand,
  getAgentMailConversationCommand,
  getAgentMailInboxSnapshotCommand,
  getAgentMailMailboxCommand,
  getAgentMailMailboxesCommand,
  getAgentMailMessageCommand,
  getAgentMailStatusCommand,
  getAgentMailSummaryCommand,
  getAgentMessagingSettingsCommand,
  getAgentRegistryCommand,
  listAgentMailConversationsCommand,
  listAgentMailSentCommand,
  listAgentMailboxesCommand,
  markAgentMailConversationSeenCommand,
  markAgentMailSeenCommand,
  muteAgentMailCommand,
  retryAgentMailInjectCommand,
  sendAgentMailCommand,
  sendExternalAgentMailCommand,
  updateAgentMessagingSettingsCommand,
} from "@orkestrator/protocol/contract/domains/agent-mail";
import { withAsyncArgumentFailures } from "./commands-registry-async-args.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import type { StorageService } from "./storage.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("agent-mail");

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
    log.warn("budget.reset-failed", { error: formatLogError(error) });
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

/**
 * Registered with their `agent-mail` definitions (plan item 7008). Every
 * handler was lenient, so every argument is `optionalKey(Unknown)` and each
 * handler keeps its own checks and messages; `async` handlers keep reporting
 * a refused argument as a rejection (`withAsyncArgumentFailures`).
 */
export function registerAgentMailCommands(registrar: CommandRegistrar): void {
  const register = withAsyncArgumentFailures(registrar);
  // Not mail, but read by the same audiences: the renderer, Control MCP, and
  // any service that needs to know which agents exist and which are busy.
  register(getAgentRegistryCommand, async ({ projectId, environmentId }, context) => {
    if (!context.agentRegistry) throw new Error("Agent registry is unavailable");
    return context.agentRegistry.snapshot({
      ...(typeof projectId === "string" && projectId ? { projectId } : {}),
      ...(typeof environmentId === "string" && environmentId ? { environmentId } : {}),
    });
  });

  register(
    listAgentMailboxesCommand,
    async (
      { projectId, environmentId, q, offset, limit, includeTombstoned, strictProjectScope },
      { storage },
    ) => {
      const settings = await requireMessagingEnabled(storage);
      const environment =
        typeof environmentId === "string" && environmentId.trim() ? environmentId.trim() : "";
      // One environment's list includes its build pipeline workers as they
      // are now, not as of the last directory pass.
      if (environment) await storage.ensureAgentMailDirectoryFresh([environment]);
      return storage.listAgentMailboxes({
        ...(typeof projectId === "string" && projectId.trim()
          ? { projectId: projectId.trim() }
          : {}),
        ...(environment ? { environmentId: environment } : {}),
        allowCrossProject: strictProjectScope === true ? false : settings.allowCrossProject,
        ...(typeof q === "string" ? { q } : {}),
        ...(typeof offset === "number" ? { offset } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        includeTombstoned: includeTombstoned === true,
      });
    },
  );
  register(getAgentMailSummaryCommand, async (_args, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.getAgentMailSummary();
  });
  register(getAgentMailInboxSnapshotCommand, async (_args, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.getAgentMailInboxSnapshot();
  });
  register(
    getAgentMailMailboxCommand,
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
  register(getAgentMailMailboxesCommand, async ({ addresses }, { storage }) => {
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
  register(getAgentMailMessageCommand, async ({ environmentId, tabId, messageId }, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.getAgentMailMessage(
      required(environmentId, "environmentId"),
      required(tabId, "tabId"),
      required(messageId, "messageId"),
    );
  });
  register(getAgentMailStatusCommand, async ({ messageId }, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.getAgentMailStatus(required(messageId, "messageId"));
  });
  register(listAgentMailSentCommand, async ({ environmentId, tabId }, { storage }) => {
    await requireMessagingEnabled(storage);
    if (environmentId === undefined && tabId === undefined) return storage.listUserSentAgentMail();
    return storage.listAgentMailSentByMailbox(
      required(environmentId, "environmentId"),
      required(tabId, "tabId"),
    );
  });
  register(listAgentMailConversationsCommand, async ({ participant }, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.listAgentMailConversations(
      typeof participant === "string" && participant ? { participant } : {},
    );
  });
  register(getAgentMailConversationCommand, async ({ a, b, limit }, { storage }) => {
    await requireMessagingEnabled(storage);
    return storage.getAgentMailConversation(
      required(a, "a"),
      required(b, "b"),
      typeof limit === "number" ? { limit } : {},
    );
  });
  register(markAgentMailConversationSeenCommand, async ({ a, b, messageIds }, { storage }) => {
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
    sendAgentMailCommand,
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
    sendExternalAgentMailCommand,
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
  register(ackAgentMailCommand, ({ environmentId, tabId, messageId }, { storage }) =>
    storage.ackAgentMail(
      required(environmentId, "environmentId"),
      required(tabId, "tabId"),
      required(messageId, "messageId"),
    ),
  );
  register(markAgentMailSeenCommand, ({ environmentId, tabId, messageId }, { storage }) =>
    storage.markAgentMailSeen(
      required(environmentId, "environmentId"),
      required(tabId, "tabId"),
      required(messageId, "messageId"),
    ),
  );
  register(
    muteAgentMailCommand,
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
    retryAgentMailInjectCommand,
    async ({ environmentId, tabId, messageId, now }, { storage, drainAgentMail }) => {
      const resolvedEnvironmentId = required(environmentId, "environmentId");
      const resolvedTabId = required(tabId, "tabId");
      const resolvedMessageId = required(messageId, "messageId");
      // `now` is Deliver now: a recipient mid-turn has the message steered into that turn.
      await storage.retryAgentMailInject(resolvedEnvironmentId, resolvedTabId, resolvedMessageId, {
        steer: optionalBoolean(now, "now") === true,
      });
      await drainAgentMail?.();
      return storage.getAgentMailMessage(resolvedEnvironmentId, resolvedTabId, resolvedMessageId);
    },
  );
  register(discardAgentMailInjectCommand, ({ environmentId, tabId, messageId }, { storage }) =>
    storage.discardAgentMail(
      required(environmentId, "environmentId"),
      required(tabId, "tabId"),
      required(messageId, "messageId"),
    ),
  );
  register(getAgentMessagingSettingsCommand, async (_args, { storage }) =>
    normalizeAgentMessagingSettings((await storage.loadConfig()).global.agentMessaging),
  );
  register(updateAgentMessagingSettingsCommand, async ({ settings }, { storage }) => {
    const current = await storage.loadConfig();
    const normalized = normalizeAgentMessagingSettings(
      settings,
      normalizeAgentMessagingSettings(current.global.agentMessaging),
    );
    // Answer with the settings alone: the full config carries stored
    // credentials, and no client needs more than what it just saved.
    const updated = await storage.patchGlobalConfig({ agentMessaging: normalized });
    return normalizeAgentMessagingSettings(updated.global.agentMessaging);
  });
}
