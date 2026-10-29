import {
  AGENT_MAIL_HOURLY_LIMIT_REASON,
  agentMailboxId,
  isAgentMailBudgetHeld,
  normalizeAgentMessagingSettings,
  type AgentMailMessage,
  nodeMailSenderKey,
} from "@orkestrator/protocol/agent-mail";
import type { StorageContext } from "./storage-context.js";
import type { StorageRepositories } from "./storage-repositories.js";
import {
  AgentMailStore,
  type PersistedAgentMailStore,
  type PersistedMailbox,
} from "./storage-agent-mail-store.js";

/** Pairs whose epoch the store keeps (`pairEpochs`); the oldest are dropped. */
const MAX_PAIR_EPOCHS = 2_000;

function pairEpochKey(firstId: string, secondId: string): string {
  return firstId < secondId ? `${firstId}\n${secondId}` : `${secondId}\n${firstId}`;
}

/**
 * Who a routed message is budgeted as: the sending tab's mailbox, or for a
 * workflow status notice its resource's stand-in (`statusBudgetKey`).
 */
function budgetSenderOf(message: AgentMailMessage): string | null {
  if (message.from.kind === "tab" || message.from.kind === "coordinator") {
    return agentMailboxId(message.from.environmentId, message.from.tabId);
  }
  if (message.from.kind === "node") return nodeMailSenderKey(message.from);
  return message.from.kind === "system" && message.statusBudgetKey ? message.statusBudgetKey : null;
}

function sameMailboxPair(
  message: AgentMailMessage,
  firstMailboxId: string,
  secondMailboxId: string,
): boolean {
  const from = budgetSenderOf(message);
  if (!from) return false;
  const to = agentMailboxId(message.toEnvironmentId, message.toTabId);
  return (
    (from === firstMailboxId && to === secondMailboxId) ||
    (from === secondMailboxId && to === firstMailboxId)
  );
}

/** The sequence at or before which a pair's routed mail no longer counts. */
export function pairBudgetEpoch(
  store: PersistedAgentMailStore,
  firstMailboxId: string,
  secondMailboxId: string,
): number {
  return Math.max(
    store.mailboxes[firstMailboxId]?.budgetResetSequence ?? 0,
    store.mailboxes[secondMailboxId]?.budgetResetSequence ?? 0,
    store.pairEpochs?.[pairEpochKey(firstMailboxId, secondMailboxId)] ?? 0,
    ...[firstMailboxId, secondMailboxId].flatMap((id) =>
      (store.mailboxes[id]?.messages ?? [])
        .filter((message) => sameMailboxPair(message, firstMailboxId, secondMailboxId))
        .map((message) => message.autonomousBudgetEpoch ?? 0),
    ),
  );
}

export function latestMailboxPairDepth(
  store: PersistedAgentMailStore,
  firstMailboxId: string,
  secondMailboxId: string,
  cutoff: number,
): number | null {
  const epoch = pairBudgetEpoch(store, firstMailboxId, secondMailboxId);
  let latest: AgentMailMessage | null = null;
  for (const mailboxId of [firstMailboxId, secondMailboxId]) {
    const mailbox = store.mailboxes[mailboxId];
    if (!mailbox) continue;
    for (const message of mailbox.messages) {
      if (message.autonomousSequence === undefined) continue;
      if (message.autonomousSequence <= epoch) continue;
      if (Date.parse(message.createdAt) < cutoff) continue;
      if (!sameMailboxPair(message, firstMailboxId, secondMailboxId)) continue;
      if (
        !latest ||
        (message.autonomousSequence ?? -1) > (latest.autonomousSequence ?? -1) ||
        ((message.autonomousSequence ?? -1) === (latest.autonomousSequence ?? -1) &&
          (message.createdAt > latest.createdAt ||
            (message.createdAt === latest.createdAt && message.id > latest.id)))
      ) {
        latest = message;
      }
    }
  }
  return latest?.threadDepth ?? null;
}

/**
 * Routed messages this pair scheduled in the last hour, in either direction.
 *
 * Mail held over a budget has not been scheduled and does not count, so the
 * hourly hold releases itself as older messages age out of the window.
 */
export function pairMessagesInLastHour(
  store: PersistedAgentMailStore,
  firstMailboxId: string,
  secondMailboxId: string,
  now: number,
): number {
  const since = now - 3_600_000;
  let count = 0;
  for (const mailboxId of [firstMailboxId, secondMailboxId]) {
    for (const message of store.mailboxes[mailboxId]?.messages ?? []) {
      if (
        message.autonomousSequence === undefined ||
        Date.parse(message.wakeAdmittedAt ?? message.createdAt) < since ||
        message.placement === "stored" ||
        message.placement === "bounced" ||
        isAgentMailBudgetHeld(message) ||
        !sameMailboxPair(message, firstMailboxId, secondMailboxId)
      ) {
        continue;
      }
      count += 1;
    }
  }
  return count;
}

/**
 * Routed mail budgets: the per-pair loop budget and hourly limit, their resets
 * and releases, and the notice a coordinator gets when a worker's mail is
 * held.
 */
export class AgentMailBudgets {
  constructor(
    private readonly context: StorageContext,
    private readonly repos: StorageRepositories,
    private readonly store: AgentMailStore,
  ) {}

  /**
   * Tell a coordinator, once per budget, that a worker's mail is being held.
   *
   * The held message cannot wake anyone, so without this the coordinator would
   * never learn the worker is still talking. The notice is a workflow message
   * and wakes it once; its request id is fixed per budget epoch (or per hour
   * for the hourly limit), so a worker that keeps sending does not keep waking
   * it. Mail the coordinator itself sent is not noticed: its send result
   * already reports the hold.
   */
  async noticeCoordinatorBudgetHold(message: AgentMailMessage): Promise<void> {
    const from = message.from;
    if (
      !(from.kind === "tab" || (from.kind === "node" && from.role === "agent")) ||
      message.route !== "coordinator"
    )
      return;
    if (!isAgentMailBudgetHeld(message)) return;
    const store = await this.store.snapshot();
    const coordinatorMailboxId = agentMailboxId(message.toEnvironmentId, message.toTabId);
    if (store.mailboxes[coordinatorMailboxId]?.ownerKind !== "coordinator") return;
    const workerMailboxId =
      from.kind === "node"
        ? nodeMailSenderKey(from)
        : agentMailboxId(from.environmentId, from.tabId);
    const onNode = from.kind === "node" ? ` on ${from.nodeName}` : "";
    const hourly = message.placementReason === AGENT_MAIL_HOURLY_LIMIT_REASON;
    const window = hourly
      ? `hour-${Math.floor(Date.parse(message.createdAt) / 3_600_000)}`
      : `epoch-${pairBudgetEpoch(store, workerMailboxId, coordinatorMailboxId)}`;
    const worker = from.title ?? from.tabId;
    try {
      await this.repos.agentMail.sendAgentMail(
        {
          kind: "system",
          projectId: from.projectId,
          source: "workflow",
          resourceId: from.environmentId,
        },
        {
          requestId: `mail-budget:${from.tabId}:${message.toTabId}:${window}`,
          toEnvironmentId: message.toEnvironmentId,
          toTabId: message.toTabId,
          subject: hourly ? "Worker mail held: hourly limit" : "Worker mail held: loop budget",
          body: hourly
            ? `Mail from worker ${worker} (environment ${from.environmentId}${onNode}) reached the hourly message limit for this conversation and is being held. It is delivered automatically as the hour passes. Read it now with read_messages if it cannot wait.`
            : `Mail from worker ${worker} (environment ${from.environmentId}${onNode}) used up its unattended message budget and is being held. Read it with read_messages, then send the worker a new request (which starts a new budget) or ask the user to resume delivery.`,
        },
        {
          notice: {
            resource: {
              kind: "agent-tab",
              id: from.tabId,
              environmentId: from.environmentId,
              tabId: from.tabId,
              ...(from.title ? { label: from.title } : {}),
            },
            state: "mail-held",
            tone: "attention",
          },
        },
      );
    } catch (error) {
      console.warn(
        "[agent-mail] Could not notify the coordinator of held worker mail:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * Start a new routed budget between a coordinator and a worker on another
   * node, as admitting a new local delegation does. The request itself went
   * to that node, so nothing here would otherwise mark the new epoch, and the
   * worker's reports would keep counting against every earlier delegation.
   */
  async startRemoteWorkerBudget(
    coordinator: { environmentId: string; tabId: string },
    worker: { nodeId: string; environmentId: string; tabId: string },
  ): Promise<void> {
    await this.store.enqueue(async () => {
      const store = await this.store.load();
      const key = pairEpochKey(
        agentMailboxId(coordinator.environmentId, coordinator.tabId),
        nodeMailSenderKey(worker),
      );
      const epochs = { ...store.pairEpochs, [key]: store.revision + 1 };
      const keys = Object.keys(epochs);
      if (keys.length > MAX_PAIR_EPOCHS) {
        for (const stale of keys
          .sort((a, b) => epochs[a]! - epochs[b]!)
          .slice(0, keys.length - MAX_PAIR_EPOCHS)) {
          delete epochs[stale];
        }
      }
      store.pairEpochs = epochs;
      store.revision += 1;
      await this.store.save(store);
    });
  }

  /**
   * Start a new routed budget for the tab a user just prompted.
   *
   * A person taking part in an exchange is the authority the budget stands in
   * for, so a prompt to either tab of a pair lets it run unattended again.
   * Mail already held stays held until Resume: the prompt is about what the
   * user typed, not consent to deliver a backlog. A no-op when nothing routed
   * has touched the tab since its last reset.
   */
  async resetAgentMailBudgetForSession(
    environmentId: string,
    logicalSessionKey: string,
  ): Promise<boolean> {
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const mailbox = Object.values(store.mailboxes).find(
        (candidate) =>
          candidate.environmentId === environmentId &&
          !candidate.tombstonedAt &&
          (candidate.logicalSessionKey ?? `env-${candidate.environmentId}:${candidate.tabId}`) ===
            logicalSessionKey,
      );
      if (!mailbox) return false;
      let latest = 0;
      for (const candidate of Object.values(store.mailboxes)) {
        for (const message of candidate.messages) {
          if (message.autonomousSequence === undefined) continue;
          if (
            candidate.mailboxId !== mailbox.mailboxId &&
            !(
              (message.from.kind === "tab" || message.from.kind === "coordinator") &&
              agentMailboxId(message.from.environmentId, message.from.tabId) === mailbox.mailboxId
            )
          ) {
            continue;
          }
          latest = Math.max(latest, message.autonomousSequence);
        }
      }
      if (latest <= (mailbox.budgetResetSequence ?? 0)) return false;
      mailbox.budgetResetSequence = store.revision + 1;
      mailbox.revision += 1;
      store.revision += 1;
      await this.store.save(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      return true;
    });
  }

  /**
   * Release mail held by the hourly limit once its pair is back under it.
   *
   * The hourly limit is a runaway guard, not a request for a person to step
   * in, so it clears itself. Oldest first, and only as many as the window has
   * room for, so a burst is spread across the hour rather than replayed at once.
   */
  async releaseHourlyHeldAgentMail(): Promise<number> {
    const settings = normalizeAgentMessagingSettings(
      (await this.repos.config.loadConfig()).global.agentMessaging,
    );
    const store = await this.store.snapshot();
    const hasHeld = Object.values(store.mailboxes).some((mailbox) =>
      mailbox.messages.some(
        (message) =>
          message.placement === "inject-held" &&
          message.placementReason === AGENT_MAIL_HOURLY_LIMIT_REASON,
      ),
    );
    if (!hasHeld) return 0;
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const now = Date.now();
      const changed = new Set<PersistedMailbox>();
      for (const mailbox of Object.values(store.mailboxes)) {
        if (mailbox.tombstonedAt || mailbox.mutedInbound) continue;
        const held = mailbox.messages
          .filter(
            (message) =>
              message.placement === "inject-held" &&
              message.placementReason === AGENT_MAIL_HOURLY_LIMIT_REASON &&
              !message.discardedAt &&
              budgetSenderOf(message) !== null,
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const message of held) {
          const senderMailboxId = budgetSenderOf(message);
          if (!senderMailboxId) continue;
          if (
            pairMessagesInLastHour(store, senderMailboxId, mailbox.mailboxId, now) >=
            settings.hourlyWakeLimit
          ) {
            continue;
          }
          message.placement = "pending-inject";
          message.wakeAdmittedAt = new Date(now).toISOString();
          delete message.placementReason;
          message.injectRequestId ??= `mail-inject-${message.id}`;
          message.revision += 1;
          store.pendingInject.push({ mailboxId: mailbox.mailboxId, messageId: message.id });
          changed.add(mailbox);
        }
      }
      if (changed.size === 0) return 0;
      for (const mailbox of changed) mailbox.revision += 1;
      store.revision += 1;
      await this.store.save(store);
      for (const mailbox of changed) {
        this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      }
      this.context.changes.announce("agent-mail-summary", "all");
      return changed.size;
    });
  }
}
