import {
  AGENT_MAIL_MAX_LIST_LIMIT,
  AGENT_MAIL_MAX_PENDING_INJECTS,
  agentMailRouteWakes,
  normalizeAgentMessagingSettings,
  renderAgentMailCarrier,
  type AgentMessagingSettings,
} from "@orkestrator/protocol/agent-mail";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import { randomUUID } from "node:crypto";
import type { NativeAgentService } from "./native-agent-service.js";
import type { MailSteerDispatchOutcome } from "./native-agent-service-shared.js";
import type { StorageService } from "./storage.js";
import type { PromptQueueDrainer } from "./prompt-queue-drainer.js";
import type {
  AgentMailMessageSummary,
  MailboxDescriptor,
  MailboxPresence,
} from "@orkestrator/protocol/agent-mail";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { AGENT_MAIL_MAX_VERIFY_ATTEMPTS } from "./storage-agent-mail-injects.js";

const OBSERVED_PRESENCE_TTL_MS = 4_000;
const HOURLY_RELEASE_INTERVAL_MS = 30_000;

/**
 * Native presence reads `unknown` while a session's retained idle is older
 * than the injection gate trusts (a backed-off observer group between safety
 * reads), and `idle` again once it is re-read. That flip says nothing about
 * the session, so it must not reset the inject backoff the way a real change
 * does; the drain still resets it when it sees `idle`.
 */
function idleFreshnessFlip(previous: MailboxPresence, next: MailboxPresence): boolean {
  return (previous === "idle" && next === "unknown") || (previous === "unknown" && next === "idle");
}

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
/** Keep the fully rendered, joined steer below the native 64 KB text limit. */
const MAX_MAIL_STEER_BATCH_BYTES = 60 * 1024;

/** Presences that mean a turn may be running, so Deliver now tries steering into it. */
const STEERABLE_PRESENCES: ReadonlySet<MailboxPresence> = new Set(["working", "waiting", "draft"]);

function mayInjectMessage(
  mailbox: MailboxDescriptor,
  message: AgentMailMessageSummary,
  settings: Pick<AgentMessagingSettings, "wakePeers">,
): boolean {
  // Mail sent before routes existed keeps the rule it was scheduled under.
  const routed =
    message.route !== undefined
      ? agentMailRouteWakes(message.route, mailbox.injectOverride, settings)
      : message.trust === "same-project" &&
        mailbox.injectOverride === "inherit" &&
        (message.from.kind === "coordinator" ||
          message.from.kind === "system" ||
          mailbox.ownerKind === "coordinator");
  return (
    (mailbox.injectPolicy === "idle" || routed || message.userReleasedAt !== undefined) &&
    !mailbox.mutedInbound &&
    !mailbox.tombstonedAt &&
    mailbox.capabilities.canInject
  );
}

export class AgentMailService {
  private drainTask: Promise<void> | null = null;
  private drainRequested = false;
  private drainIncludeDeferred = false;
  private injectorMutating = false;
  private recovered = false;
  private readonly presence = new Map<string, { presence: MailboxPresence; at: number }>();
  private unsubscribe: (() => void) | null = null;
  private readonly syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private syncRevision = 0;
  private synchronizedRevision = 0;
  private syncTask: Promise<void> | null = null;
  private presenceTask: Promise<void> | null = null;
  private lastHourlyReleaseAt = 0;
  /** Last skip reason logged per pending message, so a waiting message logs once per change. */
  private readonly skipReasons = new Map<string, string>();

  constructor(
    private readonly storage: StorageService,
    private readonly nativeAgents: Pick<
      NativeAgentService,
      "dispatchMailInject" | "reconcileMailInject" | "sessionActivitySnapshot"
    > &
      Partial<
        Pick<
          NativeAgentService,
          | "sessionPresentationSnapshot"
          | "mailInjectPresence"
          | "steerMailInject"
          | "reconcileMailSteer"
        >
      >,
    private readonly tmux: Pick<PromptQueueDrainer, "dispatchMailInject"> &
      Partial<Pick<PromptQueueDrainer, "mailInjectPresence">>,
    private readonly hooks: {
      /**
       * Coordinator mail is waiting on a worker whose environment is stopped.
       * The backend starts a local one; a container is left to the coordinator.
       */
      coordinatorMailForStoppedEnvironment?: (
        environmentId: string,
        message: AgentMailMessageSummary,
      ) => Promise<void>;
    } = {},
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

  /**
   * Log why the drain passed over a pending message, once per change of
   * reason. The drain revisits every waiting message every pass; logging each
   * visit would bury the one line that explains a stuck delivery.
   */
  private noteSkip(message: AgentMailMessageSummary, mailbox: MailboxDescriptor, reason: string) {
    if (this.skipReasons.get(message.id) === reason) return;
    if (this.skipReasons.size >= AGENT_MAIL_MAX_PENDING_INJECTS) this.skipReasons.clear();
    this.skipReasons.set(message.id, reason);
    console.info("[agent-mail] waiting", {
      messageId: message.id,
      toEnvironmentId: mailbox.environmentId,
      toTabId: mailbox.tabId,
      route: message.route ?? "none",
      reason,
    });
  }

  private async recordPresence(mailboxId: string, presence: MailboxPresence): Promise<void> {
    const previous = this.presence.get(mailboxId)?.presence;
    this.presence.set(mailboxId, { presence, at: Date.now() });
    if (previous && previous !== presence && !idleFreshnessFlip(previous, presence)) {
      await this.storage.resetAgentMailInjectBackoff(mailboxId);
    }
  }

  async init(): Promise<void> {
    await this.storage.synchronizeAgentMailboxes();
    this.unsubscribe ??= this.storage.addResourceChangeListener((change) => {
      if (change.resource === "agent-mail") {
        // Durable mail is the authority. Wake the backend dispatcher from the
        // storage event so a worker report starts the coordinator's next turn
        // without a mounted renderer or a lucky activity-poll ordering. The
        // periodic sweep remains the recovery path for a missed event.
        if (this.recovered && !this.injectorMutating) {
          // Begin/finish writes announce agent-mail too. Those are injector
          // settlement, not newly injectable mail, so they must not wake a
          // pass that would clear the backoff the finish just stored.
          void this.drainInjects({ includeDeferred: false }).catch((error) => {
            console.warn("[agent-mail] Failed to drain newly received mail:", error);
          });
        }
        return;
      }
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
    for (const { mailbox, message, steerRequestId } of interrupted) {
      if (mailbox.kind !== "native" || !mailbox.agent || !message.injectRequestId) continue;
      const logicalSessionKey =
        mailbox.logicalSessionKey ?? `env-${mailbox.environmentId}:${mailbox.tabId}`;
      let status: "dispatched" | "not-dispatched" | "unknown" = "unknown";
      try {
        status = await this.nativeAgents.reconcileMailInject({
          environmentId: mailbox.environmentId,
          agent: mailbox.agent,
          logicalSessionKey,
          requestId: message.injectRequestId,
          steerRecovery: Boolean(steerRequestId),
        });
      } catch {
        status = "unknown";
      }
      // The claim was a Deliver now steer, which may have fallen back to an
      // ordinary dispatch. Delivered either way settles it; it is provably
      // unsent only if neither could have landed.
      if (steerRequestId && status !== "dispatched") {
        const steered = await this.reconcileSteer(mailbox, logicalSessionKey, steerRequestId);
        status =
          steered === "dispatched" ? "dispatched" : steered === "unknown" ? "unknown" : status;
      }
      await this.applyInjectorMutation(() =>
        this.storage.finishAgentMailInject(
          mailbox.mailboxId,
          message.id,
          status === "dispatched"
            ? { outcome: "accepted" }
            : status === "not-dispatched"
              ? { outcome: "held", reason: "parked" }
              : { outcome: "failed", reason: "ambiguous" },
        ),
      );
    }
    await this.storage.recoverInterruptedAgentMailInjects();
    // Presence recovery may clear a proven-unsent dispatch row. Reconcile the
    // interrupted mail first, while that durable refusal evidence still exists.
    await this.refreshPresence();
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
    recurringWorkMetrics.requested("mail-presence");
    if (this.presenceTask) {
      recurringWorkMetrics.coalesced("mail-presence");
      return this.presenceTask;
    }
    const task = recurringWorkMetrics
      .observe("mail-presence", () => this.refreshPresenceOnce())
      .finally(() => {
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

  /**
   * Settle a message whose earlier dispatch may or may not have reached the
   * agent, by asking the session's dispatch journal under the request id it
   * was sent with. Delivered settles as injected; provably not delivered goes
   * back to the queue; still unknown is asked again later, and only after
   * repeated inconclusive answers fails closed, so mail is never sent twice.
   */
  private async verifyAmbiguousInject(
    mailbox: MailboxDescriptor,
    message: AgentMailMessageSummary,
    logicalSessionKey: string,
    requestId: string,
    attempts: number,
    verified: Map<string, "dispatched" | "not-dispatched" | "unknown">,
    steer: boolean,
  ): Promise<void> {
    let status = verified.get(requestId);
    if (!status) {
      if (steer) status = await this.reconcileSteer(mailbox, logicalSessionKey, requestId);
      else {
        try {
          status = await this.nativeAgents.reconcileMailInject({
            environmentId: mailbox.environmentId,
            agent: mailbox.agent!,
            logicalSessionKey,
            requestId,
          });
        } catch {
          status = "unknown";
        }
      }
      verified.set(requestId, status);
    }
    const claimed = await this.applyInjectorMutation(() =>
      this.storage.beginAgentMailInject(
        mailbox.mailboxId,
        message.id,
        mailbox.incarnationId,
        requestId,
      ),
    );
    if (!claimed) return;
    const result =
      status === "dispatched"
        ? steer
          ? ({ outcome: "accepted", via: "steer" } as const)
          : ({ outcome: "accepted" } as const)
        : status === "not-dispatched"
          ? // The journal may still hold the refused row; "parked" lets presence
            // reconciliation clear it before the next attempt, as on startup.
            ({ outcome: "held", reason: "parked" } as const)
          : attempts >= AGENT_MAIL_MAX_VERIFY_ATTEMPTS
            ? ({ outcome: "failed", reason: "ambiguous" } as const)
            : steer
              ? ({ outcome: "verify", requestId, steer: true } as const)
              : ({ outcome: "verify", requestId } as const);
    this.skipReasons.delete(message.id);
    await this.applyInjectorMutation(() =>
      this.storage.finishAgentMailInject(mailbox.mailboxId, message.id, result),
    );
    console.info("[agent-mail] verified", {
      messageId: message.id,
      toEnvironmentId: mailbox.environmentId,
      toTabId: mailbox.tabId,
      journal: status,
      outcome: result.outcome,
    });
  }

  private async reconcileSteer(
    mailbox: MailboxDescriptor,
    logicalSessionKey: string,
    requestId: string,
  ): Promise<"dispatched" | "not-dispatched" | "unknown"> {
    if (!this.nativeAgents.reconcileMailSteer) return "unknown";
    try {
      return await this.nativeAgents.reconcileMailSteer({
        environmentId: mailbox.environmentId,
        agent: mailbox.agent!,
        logicalSessionKey,
        requestId,
      });
    } catch {
      return "unknown";
    }
  }

  drainInjects(options?: { includeDeferred?: boolean }): Promise<void> {
    const includeDeferred = options?.includeDeferred !== false;
    recurringWorkMetrics.requested("mail-injection");
    if (this.drainTask) {
      recurringWorkMetrics.coalesced("mail-injection");
      this.drainRequested = true;
      if (includeDeferred) this.drainIncludeDeferred = true;
      return this.drainTask;
    }
    this.drainTask = (async () => {
      this.drainIncludeDeferred = includeDeferred;
      do {
        const deferred = this.drainIncludeDeferred;
        this.drainRequested = false;
        this.drainIncludeDeferred = false;
        await recurringWorkMetrics.observe("mail-injection", () => this.drainInjectsOnce(deferred));
      } while (this.drainRequested);
    })().finally(() => {
      this.drainTask = null;
    });
    return this.drainTask;
  }

  private applyInjectorMutation<T>(work: () => Promise<T>): Promise<T> {
    this.injectorMutating = true;
    return work().finally(() => {
      this.injectorMutating = false;
    });
  }

  private async drainInjectsOnce(includeDeferred = true): Promise<void> {
    if (!this.recovered) await this.init();
    const config = await this.storage.loadConfig();
    if (!config.global.agentMessaging?.enabled || config.global.agentMessaging.paused) return;
    const settings = normalizeAgentMessagingSettings(config.global.agentMessaging);
    // Mail held by the hourly limit releases itself as the window moves. The
    // window is an hour wide, so checking every half minute is plenty.
    if (Date.now() - this.lastHourlyReleaseAt >= HOURLY_RELEASE_INTERVAL_MS) {
      this.lastHourlyReleaseAt = Date.now();
      await this.applyInjectorMutation(() => this.storage.releaseHourlyHeldAgentMail());
    }
    const pending = await this.storage.listPendingAgentMailInjects(100, {
      includeDeferred,
      // Held status notices are listed so they can join a batch below.
      includeCoalescing: true,
    });
    // One journal read per ambiguous dispatch per pass, shared by its batch.
    const verified = new Map<string, "dispatched" | "not-dispatched" | "unknown">();
    for (const {
      mailbox,
      message,
      deferredUntil,
      verifyRequestId,
      verificationAttempts,
      coalescingUntil,
      steerRequested,
      steerRequestId: verifySteerRequestId,
    } of pending) {
      // Still gathering other notices: it may ride along, not start a turn.
      if (coalescingUntil) continue;
      if (!mayInjectMessage(mailbox, message, settings)) {
        this.noteSkip(message, mailbox, "not-eligible");
        continue;
      }
      const coordinatorId = coordinatorIdFromRuntimeId(mailbox.environmentId);
      if (coordinatorId) {
        const workspace =
          await this.storage.coordinators.getCoordinatorWorkspaceById(coordinatorId);
        if (!workspace || workspace.lifecycleState !== "ready") {
          await this.recordPresence(mailbox.mailboxId, "environment_unready");
          this.noteSkip(message, mailbox, "environment_unready");
          continue;
        }
      } else {
        const environment = await this.storage.getEnvironment(mailbox.environmentId);
        if (!environment || environment.status !== "running") {
          await this.recordPresence(mailbox.mailboxId, "environment_stopped");
          this.noteSkip(message, mailbox, "environment_stopped");
          if (
            environment &&
            environment.status === "stopped" &&
            message.route === "coordinator" &&
            (message.from.kind === "coordinator" || message.from.kind === "system")
          ) {
            await this.hooks
              .coordinatorMailForStoppedEnvironment?.(environment.id, message)
              .catch((error) => {
                console.warn(
                  "[agent-mail] Could not act on a stopped worker:",
                  error instanceof Error ? error.message : error,
                );
              });
          }
          continue;
        }
        if (
          environment.setupPhase !== "ready" &&
          environment.setupScriptsComplete !== true &&
          environment.setupOverride !== true
        ) {
          await this.recordPresence(mailbox.mailboxId, "environment_unready");
          this.noteSkip(message, mailbox, "environment_unready");
          continue;
        }
      }
      const logicalSessionKey =
        mailbox.logicalSessionKey ?? `env-${mailbox.environmentId}:${mailbox.tabId}`;
      if (verifyRequestId && mailbox.kind === "native" && mailbox.agent) {
        await this.verifyAmbiguousInject(
          mailbox,
          message,
          logicalSessionKey,
          verifyRequestId,
          verificationAttempts ?? 0,
          verified,
          verifySteerRequestId === verifyRequestId,
        );
        continue;
      }
      // Deliver now, while a turn may be running: offer the mail to that turn.
      let steerRequestId: string | undefined;
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
        if (steerRequested && STEERABLE_PRESENCES.has(nativePresence)) {
          steerRequestId = randomUUID();
        } else if (deferredUntil) {
          if (nativePresence !== "idle") {
            this.noteSkip(message, mailbox, `backoff:${nativePresence}`);
            continue;
          }
          await this.storage.resetAgentMailInjectBackoff(mailbox.mailboxId);
        }
        // A never-prompted tab has no observed provider activity. The dispatch
        // gate performs one authoritative provider-status check for that cold
        // tab; known queue, draft and live activity all stop before the claim.
        if (!steerRequestId && nativePresence !== "idle" && nativePresence !== "unknown") {
          this.noteSkip(message, mailbox, nativePresence);
          continue;
        }
      } else if (mailbox.kind === "tmux") {
        const tmuxPresence = this.tmux.mailInjectPresence
          ? await this.tmux.mailInjectPresence({
              environmentId: mailbox.environmentId,
              tabId: mailbox.tabId,
            })
          : "idle";
        await this.recordPresence(mailbox.mailboxId, tmuxPresence);
        if (deferredUntil) {
          if (tmuxPresence !== "idle") {
            this.noteSkip(message, mailbox, `backoff:${tmuxPresence}`);
            continue;
          }
          await this.storage.resetAgentMailInjectBackoff(mailbox.mailboxId);
        }
        if (tmuxPresence !== "idle") {
          if (steerRequested && STEERABLE_PRESENCES.has(tmuxPresence)) {
            // A terminal agent cannot take mail mid-turn. Say so on the
            // message, which then waits for the turn to end as before.
            const claimed = await this.applyInjectorMutation(() =>
              this.storage.beginAgentMailInject(
                mailbox.mailboxId,
                message.id,
                mailbox.incarnationId,
              ),
            );
            if (claimed) {
              this.skipReasons.delete(message.id);
              await this.applyInjectorMutation(() =>
                this.storage.finishAgentMailInject(mailbox.mailboxId, message.id, {
                  outcome: "held",
                  reason: "steer-unsupported",
                }),
              );
            }
            continue;
          }
          this.noteSkip(message, mailbox, tmuxPresence);
          continue;
        }
      } else {
        continue;
      }
      const claimed = await this.applyInjectorMutation(() =>
        this.storage.beginAgentMailInject(
          mailbox.mailboxId,
          message.id,
          mailbox.incarnationId,
          undefined,
          steerRequestId ? { steerRequestId } : {},
        ),
      );
      if (!claimed) continue;
      const maxCarrierBytes = steerRequestId
        ? MAX_MAIL_STEER_BATCH_BYTES
        : MAX_MAIL_INJECT_BATCH_BYTES;
      /*
       * Everything else already waiting for this same mailbox rides along.
       *
       * Dispatching one message per drain pass looks equivalent but is not:
       * the first dispatch marks the session working, so every sibling is held
       * `busy` and arrives as its own later turn. A worker that sent three
       * messages would wake its coordinator three times, which is the drip this
       * batching exists to prevent. One prompt, one turn, in send order.
       *
       * That includes status notices still inside their coalescing hold. The
       * hold gathers notices into one wake; this dispatch is that wake, and
       * leaving them would wake the coordinator again seconds later.
       */
      const batched = [claimed];
      let carrierBytes = Buffer.byteLength(renderAgentMailCarrier(claimed), "utf8");
      if (steerRequestId && carrierBytes > maxCarrierBytes) {
        // Escaping can expand a valid mail body beyond the steer text limit.
        // Keep the complete message queued for ordinary idle delivery.
        this.skipReasons.delete(claimed.id);
        await this.applyInjectorMutation(() =>
          this.storage.finishAgentMailInject(mailbox.mailboxId, claimed.id, {
            outcome: "held",
            reason: "steer-too-large",
          }),
        );
        continue;
      }
      for (const sibling of pending) {
        if (batched.length >= MAX_MAIL_INJECT_BATCH) break;
        if (sibling.mailbox.mailboxId !== mailbox.mailboxId) continue;
        if (sibling.message.id === message.id || sibling.deferredUntil || sibling.verifyRequestId)
          continue;
        // Eligibility is per message, not merely per mailbox. A coordinator
        // exchange may bypass an inherited-off policy while a plain sibling in
        // the same pending snapshot must remain queued.
        if (!mayInjectMessage(sibling.mailbox, sibling.message, settings)) continue;
        const siblingClaim = await this.applyInjectorMutation(() =>
          this.storage.beginAgentMailInject(
            mailbox.mailboxId,
            sibling.message.id,
            mailbox.incarnationId,
            undefined,
            {
              joinCoalescing: Boolean(sibling.coalescingUntil),
              ...(steerRequestId ? { steerRequestId } : {}),
            },
          ),
        );
        if (!siblingClaim) continue;
        const rendered = renderAgentMailCarrier(siblingClaim);
        const renderedBytes = Buffer.byteLength(rendered, "utf8");
        if (carrierBytes + 2 + renderedBytes > maxCarrierBytes) {
          // Over budget: give it back rather than carry it, so the next pass
          // delivers it as its own turn instead of dropping it.
          await this.applyInjectorMutation(() =>
            this.storage.finishAgentMailInject(mailbox.mailboxId, sibling.message.id, {
              outcome: "held",
              reason: "batch-full",
            }),
          );
          break;
        }
        carrierBytes += 2 + renderedBytes;
        batched.push(siblingClaim);
      }
      batched.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const carrier = batched.map((entry) => renderAgentMailCarrier(entry)).join("\n\n");
      // A native dispatch whose fate is unknown is confirmed against the
      // session's dispatch journal before anything is resent. Tmux has no
      // journal to ask, so it still fails closed rather than risk a double send.
      const requestId = claimed.injectRequestId ?? `mail-inject-${claimed.id}`;
      const ambiguous = () =>
        mailbox.kind === "native"
          ? ({ outcome: "verify", requestId } as const)
          : ({ outcome: "failed", reason: "ambiguous" } as const);
      const settle = async (
        result:
          | { outcome: "accepted"; via?: "steer" }
          | { outcome: "held"; reason: string }
          | { outcome: "failed"; reason: "ambiguous" | "rejected" }
          | { outcome: "retry"; reason: string }
          | { outcome: "verify"; requestId: string; steer?: true },
        via: "inject" | "steer" = "inject",
      ): Promise<void> => {
        for (const entry of batched) {
          this.skipReasons.delete(entry.id);
          await this.applyInjectorMutation(() =>
            this.storage.finishAgentMailInject(mailbox.mailboxId, entry.id, result),
          );
        }
        console.info("[agent-mail] dispatched", {
          messageIds: batched.map((entry) => entry.id),
          toEnvironmentId: mailbox.environmentId,
          toTabId: mailbox.tabId,
          outcome: result.outcome,
          reason: "reason" in result ? result.reason : null,
          via,
        });
      };
      if (steerRequestId) {
        let steered: MailSteerDispatchOutcome;
        try {
          steered = this.nativeAgents.steerMailInject
            ? await this.nativeAgents.steerMailInject({
                environmentId: mailbox.environmentId,
                agent: mailbox.agent!,
                logicalSessionKey,
                text: carrier,
                requestId: steerRequestId,
              })
            : { outcome: "refused", reason: "steer-unsupported" };
        } catch {
          // Only the lookups before the steer throw; its dispatch reports
          // an unanswered hand-off as `unknown` instead.
          steered = { outcome: "refused", reason: "steer-refused" };
        }
        if (steered.outcome === "applied") {
          await settle({ outcome: "accepted", via: "steer" }, "steer");
          continue;
        }
        if (steered.outcome === "unknown") {
          await settle({ outcome: "verify", requestId: steerRequestId, steer: true }, "steer");
          continue;
        }
        if (steered.outcome === "refused") {
          // Not delivered: it waits for the turn to end, saying why.
          await settle({ outcome: "held", reason: steered.reason }, "steer");
          continue;
        }
        // No turn is running after all: deliver it the ordinary way, now.
      }
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
                requestId,
                allowProviderCommands: false,
              });
      } catch {
        await settle(ambiguous());
        continue;
      }
      if (outcome.outcome === "accepted") {
        await settle({ outcome: "accepted" });
      } else if (outcome.outcome === "held") {
        await settle({ outcome: "held", reason: outcome.reason });
      } else if (outcome.outcome === "unknown") {
        await settle(ambiguous());
      } else {
        // Refused before the agent saw it — a checkout lease, a bridge that
        // would not start, a rebuild fence. Safe to send again, so it waits
        // and retries rather than asking anyone to press Retry.
        await settle({ outcome: "retry", reason: "rejected" });
      }
    }
  }
}
