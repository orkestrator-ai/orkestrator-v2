import { renderAgentMailCarrier } from "@orkestrator/protocol/agent-mail";
import type { NativeAgentService } from "./native-agent-service.js";
import type { StorageService } from "./storage.js";
import type { PromptQueueDrainer } from "./prompt-queue-drainer.js";

export class AgentMailService {
  private drainTask: Promise<void> | null = null;
  private recovered = false;

  constructor(
    private readonly storage: StorageService,
    private readonly nativeAgents: Pick<
      NativeAgentService,
      "dispatchMailInject" | "reconcileMailInject" | "sessionActivitySnapshot"
    >,
    private readonly tmux: Pick<PromptQueueDrainer, "dispatchMailInject">,
  ) {}

  async init(): Promise<void> {
    await this.storage.synchronizeAgentMailboxes();
    const interrupted = await this.storage.listInterruptedAgentMailInjects();
    for (const { mailbox, message } of interrupted) {
      if (mailbox.kind !== "native" || !mailbox.agent || !message.injectRequestId) continue;
      const logicalSessionKey = `env-${mailbox.environmentId}:${mailbox.tabId}`;
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
    const pending = await this.storage.listPendingAgentMailInjects(100);
    for (const { mailbox, message } of pending) {
      if (mailbox.injectPolicy !== "idle" || mailbox.mutedInbound || mailbox.tombstonedAt) continue;
      if (!mailbox.capabilities.canInject) continue;
      const environment = await this.storage.getEnvironment(mailbox.environmentId);
      if (!environment || environment.status !== "running") continue;
      if (
        environment.setupPhase !== "ready" &&
        environment.setupScriptsComplete !== true &&
        environment.setupOverride !== true
      ) {
        continue;
      }
      const logicalSessionKey = `env-${mailbox.environmentId}:${mailbox.tabId}`;
      if (mailbox.kind === "native" && mailbox.agent) {
        const activity = this.nativeAgents.sessionActivitySnapshot(
          mailbox.environmentId,
          mailbox.agent,
          logicalSessionKey,
        );
        // A never-prompted tab has no observed activity yet. Let the native
        // dispatch gate perform its authoritative provider-status check so an
        // opted-in cold tab can receive its first turn. Known live activity is
        // still rejected here without claiming the message.
        if (activity !== "idle" && activity !== "unknown") continue;
      } else if (mailbox.kind !== "tmux") {
        continue;
      }
      const claimed = await this.storage.beginAgentMailInject(
        mailbox.mailboxId,
        message.id,
        mailbox.incarnationId,
      );
      if (!claimed) continue;
      const carrier = renderAgentMailCarrier(claimed);
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
                origin: "interactive-native",
                prompt: carrier,
                requestId: claimed.injectRequestId ?? `mail-inject-${claimed.id}`,
                allowProviderCommands: false,
              });
      } catch {
        await this.storage.finishAgentMailInject(mailbox.mailboxId, message.id, {
          outcome: "failed",
          reason: "ambiguous",
        });
        continue;
      }
      if (outcome.outcome === "accepted") {
        await this.storage.finishAgentMailInject(mailbox.mailboxId, message.id, {
          outcome: "accepted",
        });
      } else if (outcome.outcome === "held") {
        await this.storage.finishAgentMailInject(mailbox.mailboxId, message.id, {
          outcome: "held",
          reason: outcome.reason,
        });
      } else {
        await this.storage.finishAgentMailInject(mailbox.mailboxId, message.id, {
          outcome: "failed",
          reason: outcome.outcome === "unknown" ? "ambiguous" : "rejected",
        });
      }
    }
  }
}
