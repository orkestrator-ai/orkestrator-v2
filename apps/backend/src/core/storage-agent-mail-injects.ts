import {
  AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX,
  AGENT_MAIL_MAX_PENDING_INJECTS,
  AgentMailError,
  agentMailCapabilities,
  agentMailboxId,
  isAgentMailBudgetHeld,
  normalizeAgentMessagingSettings,
  type AgentMailMessage,
  type MailboxDescriptor,
} from "@orkestrator/protocol/agent-mail";
import { COORDINATOR_DELEGATION_HOLD_REASON } from "@orkestrator/protocol/coordinator";
import type { StorageContext } from "./storage-context.js";
import type { StorageRepositories } from "./storage-repositories.js";
import {
  AgentMailStore,
  exceedsThreadHops,
  findMessage,
  promoteStoredMessages,
  routedMessageWakes,
  type PersistedAgentMailStore,
  type PersistedMailbox,
} from "./storage-agent-mail-store.js";

export type PendingAgentMailInject = {
  mailbox: MailboxDescriptor;
  message: AgentMailMessage;
  deferredUntil?: string;
  /** Present when an earlier dispatch's outcome is unknown and must be confirmed first. */
  verifyRequestId?: string;
  retryAttempts?: number;
  verificationAttempts?: number;
  /**
   * A status notice still inside its coalescing hold, listed only when asked
   * for: it may join a batch going to the same mailbox, never start one.
   */
  coalescingUntil?: string;
  /** The person pressed Deliver now: steer into a running turn rather than wait for it. */
  steerRequested?: true;
  /** The steer this claim or verification belongs to, when it was one. */
  steerRequestId?: string;
};

/**
 * Delay before retrying a failed delivery: quick at first, then settling at a
 * quarter of an hour. A refused dispatch is retried for as long as the message
 * is retained, so nobody has to press Retry for mail to arrive eventually.
 */
const AGENT_MAIL_RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000];

export function agentMailRetryDelayMs(attempt: number): number {
  return AGENT_MAIL_RETRY_DELAYS_MS[
    Math.min(Math.max(attempt, 1), AGENT_MAIL_RETRY_DELAYS_MS.length) - 1
  ]!;
}

/** Inconclusive journal checks before an ambiguous dispatch is given up as failed. */
export const AGENT_MAIL_MAX_VERIFY_ATTEMPTS = 8;

/**
 * When a coalescing hold for this recipient ends: an open window if a notice
 * already started one, otherwise a new one. Joining rather than starting keeps
 * a burst of notices in one delivery instead of a chain of overlapping holds.
 */
export function coalescingWindow(
  store: PersistedAgentMailStore,
  mailboxId: string,
  coalesceMs: number,
): string {
  const now = Date.now();
  const open = store.pendingInject
    .filter(
      (entry) =>
        entry.mailboxId === mailboxId &&
        entry.coalescing === true &&
        entry.retryAt !== undefined &&
        Date.parse(entry.retryAt) > now,
    )
    .map((entry) => entry.retryAt!)
    .sort()[0];
  return open ?? new Date(now + coalesceMs).toISOString();
}

/**
 * Inject scheduling: the queue of mail waiting to be delivered into a turn,
 * its claim/settle cycle, retries and verification, and the holds (stored
 * mail, delegation reports, a replaced coordinator's mail) that release onto
 * it.
 */
export class AgentMailInjects {
  constructor(
    private readonly context: StorageContext,
    private readonly repos: StorageRepositories,
    private readonly store: AgentMailStore,
  ) {}

  /**
   * Make already-stored mail deliverable once a mailbox gains an agent.
   *
   * A coordinator conversation has no provider until its first prompt, and a
   * mailbox with no agent cannot be injected into — so a workflow notice or a
   * worker reply that arrives in the meantime is filed as `stored` and would
   * otherwise sit there for good. Assignment is the moment that becomes
   * deliverable, and this applies exactly the eligibility rule
   * `retryAgentMailInject` uses for the same transition, rather than a looser
   * one that could wake mail the user muted or already acknowledged.
   */
  async promoteStoredAgentMailForMailbox(environmentId: string, tabId: string): Promise<number> {
    const settings = normalizeAgentMessagingSettings(
      (await this.repos.config.loadConfig()).global.agentMessaging,
    );
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const mailbox = store.mailboxes[agentMailboxId(environmentId, tabId)];
      if (!mailbox) return 0;
      const promoted = promoteStoredMessages(store, mailbox, settings, "all");
      if (promoted === 0) return 0;
      mailbox.revision += 1;
      store.revision += 1;
      await this.store.save(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return promoted;
    });
  }

  /** Whether this exact delegation has a worker report waiting to be released. */
  async hasDelegationHeldAgentMail(
    associationId: string,
    coordinatorEnvironmentId: string,
    coordinatorTabId: string,
    workerEnvironmentId: string,
    workerTabId: string,
  ): Promise<boolean> {
    const store = await this.store.load();
    const mailbox = store.mailboxes[agentMailboxId(coordinatorEnvironmentId, coordinatorTabId)];
    return Boolean(
      mailbox?.messages.some(
        (message) =>
          message.placement === "inject-held" &&
          message.placementReason === COORDINATOR_DELEGATION_HOLD_REASON &&
          (message.coordinatorDelegationId === associationId ||
            message.coordinatorDelegationId === undefined) &&
          (message.from.kind === "tab" || message.from.kind === "node") &&
          message.from.environmentId === workerEnvironmentId &&
          message.from.tabId === workerTabId &&
          !message.ackedAt &&
          !message.discardedAt,
      ),
    );
  }

  /**
   * Release the mail a finished worker sent while its coordinator was waiting.
   *
   * Every held message becomes deliverable at once, oldest first, so the
   * coordinator's next turn sees the whole exchange in order rather than one
   * message now and the rest on later sweeps. The durable delegation wake kind,
   * recorded before this mutation, distinguishes a silent worker from a retry
   * after an earlier pass already released the report.
   */
  async releaseDelegationHeldAgentMail(
    associationId: string,
    coordinatorEnvironmentId: string,
    coordinatorTabId: string,
    workerEnvironmentId: string,
    workerTabId: string,
  ): Promise<number> {
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const mailboxId = agentMailboxId(coordinatorEnvironmentId, coordinatorTabId);
      const mailbox = store.mailboxes[mailboxId];
      if (!mailbox) return 0;
      let released = 0;
      const held = mailbox.messages
        .filter(
          (message) =>
            message.placement === "inject-held" &&
            message.placementReason === COORDINATOR_DELEGATION_HOLD_REASON &&
            (message.coordinatorDelegationId === associationId ||
              message.coordinatorDelegationId === undefined) &&
            (message.from.kind === "tab" || message.from.kind === "node") &&
            message.from.environmentId === workerEnvironmentId &&
            message.from.tabId === workerTabId &&
            !message.ackedAt &&
            !message.discardedAt,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const message of held) {
        message.placement = "pending-inject";
        delete message.placementReason;
        message.injectRequestId ??= `mail-inject-${message.id}`;
        message.revision += 1;
        if (
          !store.pendingInject.some(
            (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === message.id,
          )
        ) {
          store.pendingInject.push({ mailboxId, messageId: message.id });
        }
        released += 1;
      }
      if (released === 0) return 0;
      mailbox.revision += 1;
      store.revision += 1;
      await this.store.save(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return released;
    });
  }

  /**
   * Release worker mail still held for a delegation nobody owes a wake any
   * more.
   *
   * A report can be held in the instant between its delegation being read as
   * open and that delegation closing with a "finished without a report"
   * notice. The wake then never looks for it, and without this it would stay
   * held for good. `owed` is every delegation still open or closed but not yet
   * woken; anything held for a different delegation is released to deliver as
   * ordinary mail.
   */
  async releaseOrphanedDelegationHolds(owed: ReadonlySet<string>): Promise<number> {
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      let released = 0;
      const changed = new Set<PersistedMailbox>();
      for (const mailbox of Object.values(store.mailboxes)) {
        for (const message of mailbox.messages) {
          if (
            message.placement !== "inject-held" ||
            message.placementReason !== COORDINATOR_DELEGATION_HOLD_REASON ||
            !message.coordinatorDelegationId ||
            owed.has(message.coordinatorDelegationId) ||
            message.ackedAt ||
            message.discardedAt
          ) {
            continue;
          }
          message.placement = "pending-inject";
          delete message.placementReason;
          message.injectRequestId ??= `mail-inject-${message.id}`;
          message.revision += 1;
          store.pendingInject.push({ mailboxId: mailbox.mailboxId, messageId: message.id });
          changed.add(mailbox);
          released += 1;
        }
      }
      if (released === 0) return 0;
      for (const mailbox of changed) mailbox.revision += 1;
      store.revision += 1;
      await this.store.save(store);
      for (const mailbox of changed) {
        this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      }
      this.context.changes.announce("agent-mail-summary", "all");
      return released;
    });
  }

  /**
   * Hand a replaced main coordinator's unhandled mail to the new main.
   *
   * Closing the main tombstones its mailbox, which marks what was waiting there
   * undeliverable — including a worker's report held for a delegation. When a
   * new main starts it collects that mail: a report its delegation still owes
   * goes back to being held for that delegation (which moved with it),
   * anything else waits for delivery. Acknowledged, discarded and expired mail
   * stays where it was.
   */
  async moveClosedCoordinatorMail(
    coordinatorId: string,
    to: { environmentId: string; tabId: string },
    owedDelegations: ReadonlySet<string>,
  ): Promise<number> {
    const settings = normalizeAgentMessagingSettings(
      (await this.repos.config.loadConfig()).global.agentMessaging,
    );
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const target = store.mailboxes[agentMailboxId(to.environmentId, to.tabId)];
      if (!target || target.tombstonedAt) return 0;
      const cutoff = Date.now() - settings.retentionDays * 86_400_000;
      let moved = 0;
      for (const mailbox of Object.values(store.mailboxes)) {
        if (
          mailbox === target ||
          !mailbox.tombstonedAt ||
          mailbox.ownerKind !== "coordinator" ||
          mailbox.coordinatorId !== coordinatorId ||
          mailbox.coordinatorRole === "side"
        ) {
          continue;
        }
        const keep: AgentMailMessage[] = [];
        for (const message of mailbox.messages) {
          const waiting =
            message.placement === "pending-inject" ||
            message.placement === "inject-held" ||
            message.placement === "stored" ||
            (message.placement === "undeliverable" && message.placementReason === "tab-closed");
          if (
            !waiting ||
            message.ackedAt ||
            message.discardedAt ||
            Date.parse(message.createdAt) < cutoff ||
            target.messages.length >= AGENT_MAIL_MAX_MESSAGES_PER_MAILBOX
          ) {
            keep.push(message);
            continue;
          }
          message.toEnvironmentId = target.environmentId;
          message.toTabId = target.tabId;
          message.toIncarnationId = target.incarnationId;
          if (message.placement !== "stored") {
            const owed =
              message.coordinatorDelegationId !== undefined &&
              owedDelegations.has(message.coordinatorDelegationId);
            const canInject = agentMailCapabilities(
              target.tabType,
              target.agent,
              target.locked,
            ).canInject;
            message.placement = owed ? "inject-held" : canInject ? "pending-inject" : "stored";
            message.placementReason = owed
              ? COORDINATOR_DELEGATION_HOLD_REASON
              : canInject
                ? undefined
                : "recipient-cannot-inject";
            if (!owed && canInject) {
              message.injectRequestId ??= `mail-inject-${message.id}`;
              store.pendingInject.push({ mailboxId: target.mailboxId, messageId: message.id });
            }
          }
          message.revision += 1;
          target.messages.push(message);
          moved += 1;
        }
        if (keep.length !== mailbox.messages.length) {
          store.pendingInject = store.pendingInject.filter(
            (entry) =>
              entry.mailboxId !== mailbox.mailboxId ||
              keep.some((message) => message.id === entry.messageId),
          );
          mailbox.messages = keep;
          mailbox.revision += 1;
        }
      }
      if (moved === 0) return 0;
      target.revision += 1;
      store.revision += 1;
      await this.store.save(store);
      this.context.changes.announce("agent-mail", target.mailboxId, target.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return moved;
    });
  }

  /**
   * `steer`: Deliver now. If the recipient is mid-turn, the next dispatch
   * offers the message to that turn instead of waiting for it to end.
   */
  async retryAgentMailInject(
    environmentId: string,
    tabId: string,
    messageId: string,
    options: { steer?: boolean } = {},
  ): Promise<AgentMailMessage> {
    const settings = normalizeAgentMessagingSettings(
      (await this.repos.config.loadConfig()).global.agentMessaging,
    );
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const mailboxId = agentMailboxId(environmentId, tabId);
      const mailbox = store.mailboxes[mailboxId];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (!mailbox || !message)
        throw new AgentMailError("message-not-found", "Message not found in this mailbox");
      const resumesLoopBudget = isAgentMailBudgetHeld(message);
      const wakesPending = message.placement === "pending-inject";
      const wakesStored =
        message.placement === "stored" &&
        !message.ackedAt &&
        !message.discardedAt &&
        !mailbox.mutedInbound &&
        (message.injectDepth === 0 || routedMessageWakes(message, mailbox, settings)) &&
        !exceedsThreadHops(message) &&
        message.trust !== "cross-project" &&
        message.trust !== "external" &&
        agentMailCapabilities(mailbox.tabType, mailbox.agent, mailbox.locked).canInject;
      if (
        message.placement !== "inject_failed" &&
        !resumesLoopBudget &&
        !wakesPending &&
        !wakesStored
      )
        return message;
      if (wakesPending) {
        const pending = store.pendingInject.find(
          (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === message.id,
        );
        if (pending) {
          delete pending.nextAttemptAt;
          pending.attempts = 0;
          // A person asked: skip the remaining wait. A pending journal check
          // stays, so an ambiguous dispatch is still never sent twice.
          delete pending.retryAt;
        }
      }
      message.placement = "pending-inject";
      if (!wakesPending || wakesStored) delete message.placementReason;
      message.injectRequestId ??= `mail-inject-${message.id}`;
      // A person asked for this message. The drain delivers it once even when
      // the mailbox policy is off, without the caller having to change that
      // policy (which would also change how every later message is routed).
      message.userReleasedAt = new Date().toISOString();
      const released = [message];
      if (resumesLoopBudget) {
        // Resume is one decision for this tab, not one per message: release
        // everything its budgets were holding and start a new budget for every
        // pair it is in. Replies keep their thread identity, and the epoch
        // still cannot move by changing subject or acknowledging mail.
        mailbox.budgetResetSequence = store.revision + 1;
        for (const sibling of mailbox.messages) {
          if (sibling === message || !isAgentMailBudgetHeld(sibling) || sibling.discardedAt)
            continue;
          sibling.placement = "pending-inject";
          delete sibling.placementReason;
          sibling.injectRequestId ??= `mail-inject-${sibling.id}`;
          sibling.userReleasedAt = message.userReleasedAt;
          sibling.revision += 1;
          released.push(sibling);
        }
        for (const entry of released) {
          entry.threadDepth = 0;
          entry.injectDepth = 0;
          entry.autonomousSequence = store.revision + 1;
        }
      }
      for (const entry of released) {
        if (
          !store.pendingInject.some(
            (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === entry.id,
          )
        ) {
          store.pendingInject.push({ mailboxId, messageId: entry.id });
        }
      }
      if (options.steer) {
        const entry = store.pendingInject.find(
          (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === message.id,
        );
        // An unconfirmed dispatch is confirmed first; it is never offered again.
        if (entry && !entry.verifyRequestId) entry.steerRequested = true;
      }
      message.revision += 1;
      mailbox.revision += 1;
      store.revision += 1;
      await this.store.save(store);
      this.context.changes.announce("agent-mail", mailbox.mailboxId, mailbox.projectId);
      this.context.changes.announce("agent-mail-summary", "all");
      return message;
    });
  }

  /** Expire an unused one-pass steer without disturbing a dispatch or its journal. */
  async clearAgentMailSteerRequest(
    environmentId: string,
    tabId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const entry = store.pendingInject.find((candidate) => {
        const mailbox = store.mailboxes[candidate.mailboxId];
        return (
          mailbox?.environmentId === environmentId &&
          mailbox.tabId === tabId &&
          candidate.messageId === messageId
        );
      });
      if (!entry?.steerRequested || entry.verifyRequestId) return false;
      delete entry.steerRequested;
      await this.store.save(store);
      return true;
    });
  }

  async listPendingAgentMailInjects(
    limit = 100,
    options: { includeDeferred?: boolean; includeCoalescing?: boolean } = {},
  ): Promise<PendingAgentMailInject[]> {
    const [store, config] = await Promise.all([this.store.load(), this.repos.config.loadConfig()]);
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    const pending: PendingAgentMailInject[] = [];
    const now = Date.now();
    const entries = store.pendingInject.toSorted((a, b) => {
      const aDeferred = a.nextAttemptAt && Date.parse(a.nextAttemptAt) > now ? 1 : 0;
      const bDeferred = b.nextAttemptAt && Date.parse(b.nextAttemptAt) > now ? 1 : 0;
      return aDeferred - bDeferred;
    });
    for (const {
      mailboxId,
      messageId,
      nextAttemptAt,
      retryAt,
      retryAttempts,
      verificationAttempts,
      verifyRequestId,
      coalescing,
      steerRequested,
      steerRequestId,
    } of entries) {
      const held = Boolean(retryAt && Date.parse(retryAt) > now);
      if (held && !(coalescing && options.includeCoalescing)) continue;
      const deferred = Boolean(nextAttemptAt && Date.parse(nextAttemptAt) > now);
      if (deferred && !options.includeDeferred) continue;
      const mailbox = store.mailboxes[mailboxId];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (!mailbox || !message || message.placement !== "pending-inject") continue;
      pending.push({
        mailbox: this.repos.agentMailboxes.descriptor(mailbox, settings.defaultInjectPolicy),
        message,
        ...(deferred && nextAttemptAt ? { deferredUntil: nextAttemptAt } : {}),
        ...(verifyRequestId ? { verifyRequestId } : {}),
        ...(retryAttempts ? { retryAttempts } : {}),
        ...(verificationAttempts ? { verificationAttempts } : {}),
        ...(held && retryAt ? { coalescingUntil: retryAt } : {}),
        ...(steerRequested ? { steerRequested } : {}),
        ...(steerRequestId ? { steerRequestId } : {}),
      });
      if (pending.length >= Math.max(1, Math.min(limit, AGENT_MAIL_MAX_PENDING_INJECTS))) break;
    }
    return pending;
  }

  /** Activity edges make a held delivery immediately eligible without announcing UI churn. */
  async resetAgentMailInjectBackoff(mailboxId: string): Promise<void> {
    await this.store.enqueue(async () => {
      const store = await this.store.load();
      let changed = false;
      for (const entry of store.pendingInject) {
        if (entry.mailboxId !== mailboxId || !entry.nextAttemptAt) continue;
        delete entry.nextAttemptAt;
        entry.attempts = 0;
        changed = true;
      }
      if (changed) await this.store.save(store);
    });
  }

  async listInterruptedAgentMailInjects(): Promise<PendingAgentMailInject[]> {
    const [store, config] = await Promise.all([this.store.load(), this.repos.config.loadConfig()]);
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    const interrupted: PendingAgentMailInject[] = [];
    for (const mailbox of Object.values(store.mailboxes)) {
      for (const message of mailbox.messages) {
        if (message.placement !== "inject-held" || message.placementReason !== "submitting") {
          continue;
        }
        const steerRequestId = store.pendingInject.find(
          (entry) => entry.mailboxId === mailbox.mailboxId && entry.messageId === message.id,
        )?.steerRequestId;
        interrupted.push({
          mailbox: this.repos.agentMailboxes.descriptor(mailbox, settings.defaultInjectPolicy),
          message,
          ...(steerRequestId ? { steerRequestId } : {}),
        });
      }
    }
    return interrupted;
  }

  /** One durable startup attempt per queued item, only for a local family worker. */
  async claimAgentMailWorkerStart(environmentId: string, messageId: string): Promise<boolean> {
    const environment = await this.repos.projects.getEnvironment(environmentId);
    if (
      !environment ||
      environment.environmentType !== "local" ||
      environment.status !== "stopped" ||
      environment.deletionRequestedAt
    )
      return false;
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const located = findMessage(store, messageId);
      const message = located?.message;
      const recipient = located?.mailbox;
      if (
        !message ||
        !recipient ||
        message.from.kind !== "coordinator" ||
        message.route !== "coordinator" ||
        message.placement !== "pending-inject" ||
        !message.recipientStoppedAtSend ||
        message.workerStartAttemptedAt ||
        message.recipientStopGeneration !== (environment.stopGeneration ?? 0) ||
        recipient.coordinatorOrigin !== message.from.environmentId
      )
        return false;
      // A queued batch asks for one start, even if it contains several requests.
      const now = new Date().toISOString();
      for (const mailbox of Object.values(store.mailboxes)) {
        if (mailbox.environmentId !== environmentId) continue;
        for (const item of mailbox.messages) {
          if (
            item.placement === "pending-inject" &&
            item.recipientStopGeneration === message.recipientStopGeneration
          )
            item.workerStartAttemptedAt = now;
        }
      }
      await this.store.save(store);
      return true;
    });
  }

  /**
   * Claim one pending message for dispatch. `joinCoalescing` lets a status
   * notice still inside its coalescing hold ride along with a batch already
   * going to this mailbox: the hold only exists to gather notices into one
   * wake, and that wake is happening now. `steerRequestId` records, with the
   * claim, that this dispatch is a steer, so a restart asks the right journal.
   */
  async beginAgentMailInject(
    mailboxId: string,
    messageId: string,
    incarnationId: string,
    verificationRequestId?: string,
    options: { joinCoalescing?: boolean; steerRequestId?: string } = {},
  ): Promise<AgentMailMessage | null> {
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const mailbox = store.mailboxes[mailboxId];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (
        !mailbox ||
        !message ||
        mailbox.incarnationId !== incarnationId ||
        mailbox.tombstonedAt ||
        message.toIncarnationId !== incarnationId ||
        message.placement !== "pending-inject"
      )
        return null;
      const pendingEntry = store.pendingInject.find(
        (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === messageId,
      );
      if (
        pendingEntry?.verifyRequestId !== verificationRequestId ||
        (pendingEntry?.retryAt &&
          Date.parse(pendingEntry.retryAt) > Date.now() &&
          !(options.joinCoalescing && pendingEntry.coalescing)) ||
        (pendingEntry?.nextAttemptAt && Date.parse(pendingEntry.nextAttemptAt) > Date.now())
      )
        return null;
      message.placement = "inject-held";
      if (pendingEntry) {
        pendingEntry.lastHoldReason = message.placementReason;
        if (options.steerRequestId) pendingEntry.steerRequestId = options.steerRequestId;
      }
      message.placementReason = "submitting";
      await this.store.save(store);
      return message;
    });
  }

  async finishAgentMailInject(
    mailboxId: string,
    messageId: string,
    outcome:
      /** `via: "steer"`: it landed in the recipient's running turn. */
      | { outcome: "accepted"; via?: "steer" }
      | { outcome: "held"; reason: string }
      | { outcome: "failed"; reason: "ambiguous" | "rejected" }
      /** Refused before it reached the agent: queue it again after a delay. */
      | { outcome: "retry"; reason: string }
      /**
       * Outcome unknown: confirm `requestId` against the journal before
       * resending — the steer journal when `steer` is set.
       */
      | { outcome: "verify"; requestId: string; steer?: true },
  ): Promise<AgentMailMessage | null> {
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      const mailbox = store.mailboxes[mailboxId];
      const message = mailbox?.messages.find((candidate) => candidate.id === messageId);
      if (
        !mailbox ||
        !message ||
        message.placement !== "inject-held" ||
        message.placementReason !== "submitting"
      )
        return null;
      const pendingIndex = store.pendingInject.findIndex(
        (candidate) => candidate.mailboxId === mailboxId && candidate.messageId === messageId,
      );
      const pendingEntry = pendingIndex >= 0 ? store.pendingInject[pendingIndex] : undefined;
      let announce = true;
      if (outcome.outcome === "accepted") {
        message.placement = "injected";
        message.injectedAt = new Date().toISOString();
        if (outcome.via === "steer") message.injectedVia = "steer";
        delete message.placementReason;
        if (pendingIndex >= 0) store.pendingInject.splice(pendingIndex, 1);
      } else if (outcome.outcome === "held") {
        const reason = outcome.reason.slice(0, 100);
        const previousReason = pendingEntry?.lastHoldReason;
        message.placement = "pending-inject";
        message.placementReason = reason;
        const attempts = Math.min(5, (pendingEntry?.attempts ?? 0) + 1);
        const delayMs = Math.min(30_000, 2_000 * 2 ** (attempts - 1));
        const next = {
          mailboxId,
          messageId,
          attempts,
          nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
          lastHoldReason: reason,
          ...(pendingEntry?.coalescing &&
          pendingEntry.retryAt &&
          Date.parse(pendingEntry.retryAt) > Date.now()
            ? { coalescing: true as const, retryAt: pendingEntry.retryAt }
            : {}),
        };
        if (pendingIndex >= 0) store.pendingInject[pendingIndex] = next;
        else store.pendingInject.push(next);
        announce = previousReason !== reason;
      } else if (outcome.outcome === "retry" || outcome.outcome === "verify") {
        const retryAttempts =
          (pendingEntry?.retryAttempts ?? 0) + (outcome.outcome === "retry" ? 1 : 0);
        const verificationAttempts =
          outcome.outcome === "verify" ? (pendingEntry?.verificationAttempts ?? 0) + 1 : 0;
        const reason = outcome.outcome === "retry" ? "retrying" : "verifying";
        // `beginAgentMailInject` saved the placement reason it replaced.
        const previousReason = pendingEntry?.lastHoldReason;
        message.placement = "pending-inject";
        message.placementReason = reason;
        const next = {
          mailboxId,
          messageId,
          retryAttempts,
          verificationAttempts,
          retryAt: new Date(
            Date.now() +
              agentMailRetryDelayMs(
                outcome.outcome === "verify" ? verificationAttempts : retryAttempts,
              ),
          ).toISOString(),
          lastHoldReason: reason,
          ...(outcome.outcome === "verify" ? { verifyRequestId: outcome.requestId } : {}),
          ...(outcome.outcome === "verify" && outcome.steer
            ? { steerRequestId: outcome.requestId }
            : {}),
          ...(outcome.outcome === "retry" &&
          pendingEntry?.coalescing &&
          pendingEntry.retryAt &&
          Date.parse(pendingEntry.retryAt) > Date.now()
            ? { coalescing: true as const, retryAt: pendingEntry.retryAt }
            : {}),
        };
        if (pendingIndex >= 0) store.pendingInject[pendingIndex] = next;
        else store.pendingInject.push(next);
        announce = previousReason !== reason;
      } else {
        message.placement = "inject_failed";
        message.placementReason = outcome.reason;
        if (pendingIndex >= 0) store.pendingInject.splice(pendingIndex, 1);
      }
      if (announce) {
        message.revision += 1;
        mailbox.revision += 1;
        store.revision += 1;
      }
      await this.store.save(store);
      if (announce) {
        this.context.changes.announce("agent-mail", mailboxId, mailbox.projectId);
        this.context.changes.announce("agent-mail-summary", "all");
      }
      return message;
    });
  }

  async recoverInterruptedAgentMailInjects(): Promise<number> {
    return this.store.enqueue(async () => {
      const store = await this.store.load();
      let recovered = 0;
      for (const mailbox of Object.values(store.mailboxes)) {
        for (const message of mailbox.messages) {
          if (message.placement !== "inject-held" || message.placementReason !== "submitting")
            continue;
          message.placement = "inject_failed";
          message.placementReason = "ambiguous";
          message.revision += 1;
          mailbox.revision += 1;
          recovered += 1;
        }
      }
      if (recovered === 0) return 0;
      store.revision += 1;
      await this.store.save(store);
      this.context.changes.announce("agent-mail-summary", "all");
      return recovered;
    });
  }
}
