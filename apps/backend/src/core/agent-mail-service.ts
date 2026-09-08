import {
  AGENT_MAIL_MAX_LIST_LIMIT,
  renderAgentMailCarrier,
} from "@orkestrator/protocol/agent-mail";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import type { NativeAgentService } from "./native-agent-service.js";
import type { StorageService } from "./storage.js";
import type { PromptQueueDrainer } from "./prompt-queue-drainer.js";
import type { MailboxDescriptor, MailboxPresence } from "@orkestrator/protocol/agent-mail";

const OBSERVED_PRESENCE_TTL_MS = 4_000;

/**
 * How many waiting messages one injected turn may carry, and how large the
 * combined carrier may get.
 *
 * Both bounds exist because the batch is built from whatever a worker chose to
 * send: without them a chatty or hostile worker decides how big the
 * coordinator's next prompt is. Anything over budget stays pending and is
 * delivered by a later pass rather than dropped.
 */
const MAX_MAIL_INJECT_BATCH = 10;
const MAX_MAIL_INJECT_BATCH_BYTES = 128 * 1024;

export class AgentMailService {
  private drainTask: Promise<void> | null = null;
  private recovered = false;
  private readonly presence = new Map<string, { presence: MailboxPresence; at: number }>();
  private unsubscribe: (() => void) | null = null;
  private readonly syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private syncRevision = 0;
  private synchronizedRevision = 0;
  private syncTask: Promise<void> | null = null;
  private presenceTask: Promise<void> | null = null;

  constructor(
    private readonly storage: StorageService,
    private readonly nativeAgents: Pick<
      NativeAgentService,
      "dispatchMailInject" | "reconcileMailInject" | "sessionActivitySnapshot"
    > &
      Partial<Pick<NativeAgentService, "sessionPresentationSnapshot" | "mailInjectPresence">>,
    private readonly tmux: Pick<PromptQueueDrainer, "dispatchMailInject"> &
      Partial<Pick<PromptQueueDrainer, "mailInjectPresence">>,
  ) {
    this.storage.setAgentMailRuntimeProvider((mailbox) => {
      const observed = this.presence.get(mailbox.mailboxId);
      const currentObserved =
        observed && Date.now() - observed.at <= OBSERVED_PRESENCE_TTL_MS ? observed : undefined;
      if (observed && !currentObserved) this.presence.delete(mailbox.mailboxId);
      if (mailbox.kind === "native" && mailbox.agent) {
        const presentation = this.nativeAgents.sessionPresentationSnapshot?.(
          mailbox.environmentId,
          mailbox.agent,
          mailbox.logicalSessionKey ?? `env-${mailbox.environmentId}:${mailbox.tabId}`,
        ) ?? { presence: "unknown" as const };
        return {
          presence: currentObserved?.presence ?? presentation.presence,
          title: presentation.title,
        };
      }
      return currentObserved;
    });
  }

  private async recordPresence(mailboxId: string, presence: MailboxPresence): Promise<void> {
    const previous = this.presence.get(mailboxId)?.presence;
    this.presence.set(mailboxId, { presence, at: Date.now() });
    if (previous && previous !== presence) {
      await this.storage.resetAgentMailInjectBackoff(mailboxId);
    }
  }

  async init(): Promise<void> {
    await this.storage.synchronizeAgentMailboxes();
    await this.refreshPresence();
    this.unsubscribe ??= this.storage.addResourceChangeListener((change) => {
      if (
        ![
          "pane-layout",
          "environment",
          "project",
          "session",
          "native-agent-session",
          "coordinator",
        ].includes(change.resource)
      ) {
        return;
      }
      this.syncRevision += 1;
      const scope =
        change.resource === "project" || change.resource === "coordinator"
          ? `project:${change.projectId ?? change.id}`
          : `environment:${change.id}`;
      if (this.syncTimers.has(scope)) return;
      const timer = setTimeout(() => {
        this.syncTimers.delete(scope);
        void this.synchronizeChangedMailboxes();
      }, 250);
      this.syncTimers.set(scope, timer);
      timer.unref?.();
    });
    const interrupted = await this.storage.listInterruptedAgentMailInjects();
    for (const { mailbox, message } of interrupted) {
      if (mailbox.kind !== "native" || !mailbox.agent || !message.injectRequestId) continue;
      const logicalSessionKey =
        mailbox.logicalSessionKey ?? `env-${mailbox.environmentId}:${mailbox.tabId}`;
      let dispatched = false;
      try {
        dispatched =
          (await this.nativeAgents.reconcileMailInject({
            environmentId: mailbox.environmentId,
            agent: mailbox.agent,
            logicalSessionKey,
            requestId: message.injectRequestId,
          })) === "dispatched";
      } catch {
        dispatched = false;
      }
      await this.storage.finishAgentMailInject(
        mailbox.mailboxId,
        message.id,
        dispatched ? { outcome: "accepted" } : { outcome: "failed", reason: "ambiguous" },
      );
    }
    await this.storage.recoverInterruptedAgentMailInjects();
    this.recovered = true;
  }

  async shutdown(): Promise<void> {
    for (const timer of this.syncTimers.values()) clearTimeout(timer);
    this.syncTimers.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.storage.setAgentMailRuntimeProvider(null);
    await this.syncTask?.catch(() => undefined);
    await this.presenceTask?.catch(() => undefined);
    await this.drainTask?.catch(() => undefined);
  }

  private synchronizeChangedMailboxes(): Promise<void> {
    if (this.syncTask) return this.syncTask;
    const targetRevision = this.syncRevision;
    if (targetRevision <= this.synchronizedRevision) return Promise.resolve();
    let succeeded = false;
    const task = this.storage
      .synchronizeAgentMailboxes()
      .then(() => {
        succeeded = true;
        this.synchronizedRevision = Math.max(this.synchronizedRevision, targetRevision);
      })
      .catch((error) => {
        console.warn("[agent-mail] Failed to synchronize mailboxes:", error);
      })
      .finally(() => {
        if (this.syncTask === task) this.syncTask = null;
        if (
          succeeded &&
          this.synchronizedRevision < this.syncRevision &&
          this.syncTimers.size === 0
        ) {
          void this.synchronizeChangedMailboxes();
        }
      });
    this.syncTask = task;
    return task;
  }

  refreshPresence(): Promise<void> {
    if (this.presenceTask) return this.presenceTask;
    const task = this.refreshPresenceOnce().finally(() => {
      if (this.presenceTask === task) this.presenceTask = null;
    });
    this.presenceTask = task;
    return task;
  }

  private async refreshPresenceOnce(): Promise<void> {
    const mailboxes: MailboxDescriptor[] = [];
    let offset = 0;
    while (true) {
      const page = await this.storage.listAgentMailboxes({
        offset,
        limit: AGENT_MAIL_MAX_LIST_LIMIT,
      });
      mailboxes.push(...page.mailboxes);
      offset += page.mailboxes.length;
      if (page.mailboxes.length === 0 || offset >= page.total) break;
    }
    const concurrency = 8;
    for (let index = 0; index < mailboxes.length; index += concurrency) {
      await Promise.allSettled(
        mailboxes.slice(index, index + concurrency).map(async (mailbox) => {
          if (mailbox.kind === "native" && mailbox.agent) {
            const logicalSessionKey =
              mailbox.logicalSessionKey ?? `env-${mailbox.environmentId}:${mailbox.tabId}`;
            const activity = this.nativeAgents.sessionActivitySnapshot(
              mailbox.environmentId,
              mailbox.agent,
              logicalSessionKey,
            );
            const presence = this.nativeAgents.mailInjectPresence
              ? await this.nativeAgents.mailInjectPresence({
                  environmentId: mailbox.environmentId,
                  agent: mailbox.agent,
                  logicalSessionKey,
                })
              : activity === "idle" || activity === "working" || activity === "waiting"
                ? activity
                : "unknown";
            await this.recordPresence(mailbox.mailboxId, presence);
          } else if (mailbox.kind === "tmux" && this.tmux.mailInjectPresence) {
            await this.recordPresence(
              mailbox.mailboxId,
              await this.tmux.mailInjectPresence({
                environmentId: mailbox.environmentId,
                tabId: mailbox.tabId,
              }),
            );
          }
        }),
      );
    }
  }

  drainInjects(): Promise<void> {
    if (this.drainTask) return this.drainTask;
    this.drainTask = this.drainInjectsOnce().finally(() => {
      this.drainTask = null;
    });
    return this.drainTask;
  }

  private async drainInjectsOnce(): Promise<void> {
    if (!this.recovered) await this.init();
    const config = await this.storage.loadConfig();
    const settings = config.global.agentMessaging;
    if (!settings?.enabled || settings.paused) return;
    const pending = await this.storage.listPendingAgentMailInjects(100, {
      includeDeferred: true,
    });
    for (const { mailbox, message, deferredUntil } of pending) {
      const coordinatorExchange =
        message.trust === "same-project" &&
        mailbox.injectOverride === "inherit" &&
        (message.from.kind === "coordinator" ||
          message.from.kind === "system" ||
          mailbox.ownerKind === "coordinator");
      if (
        (mailbox.injectPolicy !== "idle" && !coordinatorExchange) ||
        mailbox.mutedInbound ||
        mailbox.tombstonedAt
      )
        continue;
      if (!mailbox.capabilities.canInject) continue;
      const coordinatorId = coordinatorIdFromRuntimeId(mailbox.environmentId);
      if (coordinatorId) {
        const workspace = await this.storage.getCoordinatorWorkspaceById(coordinatorId);
        if (!workspace || workspace.lifecycleState !== "ready") {
          await this.recordPresence(mailbox.mailboxId, "environment_unready");
          continue;
        }
      } else {
        const environment = await this.storage.getEnvironment(mailbox.environmentId);
        if (!environment || environment.status !== "running") {
          await this.recordPresence(mailbox.mailboxId, "environment_stopped");
          continue;
        }
        if (
          environment.setupPhase !== "ready" &&
          environment.setupScriptsComplete !== true &&
          environment.setupOverride !== true
        ) {
          await this.recordPresence(mailbox.mailboxId, "environment_unready");
          continue;
        }
      }
      const logicalSessionKey =
        mailbox.logicalSessionKey ?? `env-${mailbox.environmentId}:${mailbox.tabId}`;
      if (mailbox.kind === "native" && mailbox.agent) {
        const activity = this.nativeAgents.sessionActivitySnapshot(
          mailbox.environmentId,
          mailbox.agent,
          logicalSessionKey,
        );
        const nativePresence = this.nativeAgents.mailInjectPresence
          ? await this.nativeAgents.mailInjectPresence({
              environmentId: mailbox.environmentId,
              agent: mailbox.agent,
              logicalSessionKey,
            })
          : activity === "idle" || activity === "working" || activity === "waiting"
            ? activity
            : "unknown";
        await this.recordPresence(mailbox.mailboxId, nativePresence);
        if (deferredUntil) {
          if (nativePresence !== "idle") continue;
          await this.storage.resetAgentMailInjectBackoff(mailbox.mailboxId);
        }
        // A never-prompted tab has no observed provider activity. The dispatch
        // gate performs one authoritative provider-status check for that cold
        // tab; known queue, draft and live activity all stop before the claim.
        if (nativePresence !== "idle" && nativePresence !== "unknown") continue;
      } else if (mailbox.kind === "tmux") {
        const tmuxPresence = this.tmux.mailInjectPresence
          ? await this.tmux.mailInjectPresence({
              environmentId: mailbox.environmentId,
              tabId: mailbox.tabId,
            })
          : "idle";
        await this.recordPresence(mailbox.mailboxId, tmuxPresence);
        if (deferredUntil) {
          if (tmuxPresence !== "idle") continue;
          await this.storage.resetAgentMailInjectBackoff(mailbox.mailboxId);
        }
        if (tmuxPresence !== "idle") continue;
      } else {
        continue;
      }
      const claimed = await this.storage.beginAgentMailInject(
        mailbox.mailboxId,
        message.id,
        mailbox.incarnationId,
      );
      if (!claimed) continue;
      /*
       * Everything else already waiting for this same mailbox rides along.
       *
       * Dispatching one message per drain pass looks equivalent but is not:
       * the first dispatch marks the session working, so every sibling is held
       * `busy` and arrives as its own later turn. A worker that sent three
       * messages would wake its coordinator three times, which is the drip this
       * batching exists to prevent. One prompt, one turn, in send order.
       */
      const batched = [claimed];
      let carrierBytes = Buffer.byteLength(renderAgentMailCarrier(claimed), "utf8");
      for (const sibling of pending) {
        if (batched.length >= MAX_MAIL_INJECT_BATCH) break;
        if (sibling.mailbox.mailboxId !== mailbox.mailboxId) continue;
        if (sibling.message.id === message.id || sibling.deferredUntil) continue;
        const siblingClaim = await this.storage.beginAgentMailInject(
          mailbox.mailboxId,
          sibling.message.id,
          mailbox.incarnationId,
        );
        if (!siblingClaim) continue;
        const rendered = renderAgentMailCarrier(siblingClaim);
        const renderedBytes = Buffer.byteLength(rendered, "utf8");
        if (carrierBytes + renderedBytes > MAX_MAIL_INJECT_BATCH_BYTES) {
          // Over budget: give it back rather than carry it, so the next pass
          // delivers it as its own turn instead of dropping it.
          await this.storage.finishAgentMailInject(mailbox.mailboxId, sibling.message.id, {
            outcome: "held",
            reason: "batch-full",
          });
          break;
        }
        carrierBytes += renderedBytes;
        batched.push(siblingClaim);
      }
      batched.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const carrier = batched.map((entry) => renderAgentMailCarrier(entry)).join("\n\n");
      const settle = async (
        result:
          | { outcome: "accepted" }
          | { outcome: "held"; reason: string }
          | { outcome: "failed"; reason: "ambiguous" | "rejected" },
      ): Promise<void> => {
        for (const entry of batched) {
          await this.storage.finishAgentMailInject(mailbox.mailboxId, entry.id, result);
        }
      };
      let outcome:
        | Awaited<ReturnType<PromptQueueDrainer["dispatchMailInject"]>>
        | Awaited<ReturnType<NativeAgentService["dispatchMailInject"]>>;
      try {
        outcome =
          mailbox.kind === "tmux"
            ? await this.tmux.dispatchMailInject({
                environmentId: mailbox.environmentId,
                tabId: mailbox.tabId,
                text: carrier,
              })
            : await this.nativeAgents.dispatchMailInject({
                environmentId: mailbox.environmentId,
                agent: mailbox.agent!,
                logicalSessionKey,
                origin: coordinatorId ? "coordinator" : "interactive-native",
                prompt: carrier,
                requestId: claimed.injectRequestId ?? `mail-inject-${claimed.id}`,
                allowProviderCommands: false,
              });
      } catch {
        await settle({ outcome: "failed", reason: "ambiguous" });
        continue;
      }
      if (outcome.outcome === "accepted") {
        await settle({ outcome: "accepted" });
      } else if (outcome.outcome === "held") {
        await settle({ outcome: "held", reason: outcome.reason });
      } else {
        await settle({
          outcome: "failed",
          reason: outcome.outcome === "unknown" ? "ambiguous" : "rejected",
        });
      }
    }
  }
}
