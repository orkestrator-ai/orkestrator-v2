import {
  buildTmuxPromptWithAttachments,
  parseClaudeTmuxStateKey,
  parseTmuxPromptAttachments,
} from "@orkestrator/protocol/tmux-prompt";
import type { StorageService } from "./storage.js";
import type { Environment } from "./models.js";
import { isGeneratedEnvironmentName } from "./environment-name.js";

type CommandInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Queues this drainer owns. Native agent queues are drained by `NativeAgentService`. */
const TMUX_AGENT = "claude-tmux";

const QUEUE_RETRY_BASE_MS = 2_000;
const QUEUE_RETRY_CEILING_MS = 60_000;
const MAX_QUEUE_DISPATCH_ATTEMPTS = 5;

/** Backend view of a tmux tab, as `claude_tmux_status` reports it. */
interface TmuxStatusSnapshot {
  running?: unknown;
  busy?: unknown;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * An agent can only be driven once its environment is running and its setup has
 * finished. Mirrors the guard `NativeAgentService` applies to its own queues.
 */
function isEnvironmentReadyForAgents(environment: Environment): boolean {
  return (
    environment.status === "running" &&
    (environment.setupPhase === "ready" || environment.setupScriptsComplete === true)
  );
}

export interface PromptQueueDrainerOptions {
  retryBaseMs?: number;
  retryCeilingMs?: number;
  maxDispatchAttempts?: number;
}

/**
 * Backend-owned drainer for claude-tmux prompt queues.
 *
 * The native agent queues (claude, codex, opencode) are drained by
 * `NativeAgentService`, which dispatches through a bridge provider. tmux has no
 * bridge — a prompt is typed into a pane — so it needs its own supervisor, and
 * until it had one nothing sent the next queued tmux prompt unless a React tree
 * happened to be mounted, connected and re-rendering.
 *
 * The durable pieces already existed: the queue, the claim lease, and the
 * `dispatchError` latch all live in storage. This only moves the *dispatcher*
 * server-side, where a renderer reload cannot abandon a claim.
 */
export class PromptQueueDrainer {
  private readonly queueTasks = new Map<string, Promise<void>>();
  private readonly queueAttempts = new Map<string, number>();
  private readonly queueRetryAt = new Map<string, number>();
  /**
   * Confirmed terminal submissions whose durable post-submit marker has not
   * been written yet. This only bridges a transient storage failure in this
   * process. After a process crash, a durable `submittingAt` without
   * `submittedAt` is deliberately treated as ambiguous and parked for a human.
   */
  private readonly confirmedSubmissions = new Map<string, string>();
  private sweep: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: PromptQueueDrainerOptions = {},
  ) {}

  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...(this.sweep ? [this.sweep] : []), ...this.queueTasks.values()]);
    this.queueTasks.clear();
    this.queueAttempts.clear();
    this.queueRetryAt.clear();
    this.confirmedSubmissions.clear();
  }

  /**
   * One pass over every tmux queue that is due.
   *
   * Deliberately timer-free: the backend drives this from the activity sweep it
   * already runs, so tmux queues share one cadence with the native ones instead
   * of adding a third interval polling the same store.
   */
  drainAll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.sweep) return this.sweep;
    const sweep = this.runSweep().finally(() => {
      if (this.sweep === sweep) this.sweep = null;
    });
    this.sweep = sweep;
    return sweep;
  }

  private async runSweep(): Promise<void> {
    const now = Date.now();
    const queues = await this.storage.listAllPromptQueues();
    if (this.stopped) return;
    await Promise.allSettled(
      queues
        .filter((queue) => {
          const separator = queue.queueKey.indexOf("\0");
          if (queue.queueKey.slice(0, separator) !== TMUX_AGENT) return false;
          return (
            (queue.messages.length > 0 || queue.inFlight !== undefined) &&
            // A latched dispatch error is the user's to clear; retrying it here
            // would spin on the same prompt and hide the error they must see.
            queue.dispatchError === undefined &&
            (this.queueRetryAt.get(queue.queueKey) ?? 0) <= now
          );
        })
        .map((queue) => this.drainQueue(queue.queueKey)),
    );
  }

  /** Drain one queue, collapsing concurrent requests onto the in-flight pass. */
  drainQueue(queueKey: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.queueTasks.get(queueKey);
    if (existing) return existing;
    const task = this.drainQueueOnce(queueKey).finally(() => {
      if (this.queueTasks.get(queueKey) === task) this.queueTasks.delete(queueKey);
    });
    this.queueTasks.set(queueKey, task);
    return task;
  }

  private async drainQueueOnce(queueKey: string): Promise<void> {
    try {
      await this.drainReadyQueue(queueKey);
    } catch (error) {
      // Any fault that escapes must still back off. A storage read that throws
      // bypasses every inner handler and the sweep's `allSettled` swallows it,
      // so without this the queue would be retried every two seconds with no
      // attempt counter, no latch and no log.
      await this.defer(queueKey, error instanceof Error ? error.name : "unknown drain error").catch(
        () => undefined,
      );
    }
  }

  private async drainReadyQueue(queueKey: string): Promise<void> {
    if (this.stopped) return;
    const separator = queueKey.indexOf("\0");
    if (separator <= 0) return;
    if (queueKey.slice(0, separator) !== TMUX_AGENT) return;
    const stateKey = queueKey.slice(separator + 1);
    const target = parseClaudeTmuxStateKey(stateKey);
    if (!target) return;

    const queue = await this.storage.getPromptQueue(queueKey);
    if (!queue || queue.dispatchError) return;
    if (queue.environmentId !== target.environmentId) {
      // A persisted queue is a trust boundary. Never let the owner field and
      // the environment encoded in its routing key select different targets.
      await this.defer(queueKey, "queue target does not match its owner");
      return;
    }
    if (queue.inFlight?.submittedAt) {
      await this.storage.acknowledgePromptQueueDispatch(queueKey, queue.inFlight.requestId);
      this.confirmedSubmissions.delete(queueKey);
      this.clearBackoff(queueKey);
      return;
    }
    if (queue.inFlight?.submittingAt) {
      if (this.confirmedSubmissions.get(queueKey) === queue.inFlight.requestId) {
        const submitted = await this.storage.markPromptQueueDispatchSubmitted(
          queueKey,
          queue.inFlight.requestId,
        );
        if (
          submitted?.inFlight?.requestId !== queue.inFlight.requestId ||
          !submitted.inFlight.submittedAt
        ) {
          this.confirmedSubmissions.delete(queueKey);
          return;
        }
        await this.storage.acknowledgePromptQueueDispatch(queueKey, queue.inFlight.requestId);
        this.confirmedSubmissions.delete(queueKey);
        this.clearBackoff(queueKey);
        return;
      }
      await this.storage.failPromptQueueDispatch(
        queueKey,
        queue.inFlight.requestId,
        "Queued prompt submission was interrupted and may already have reached Claude. Review the pane before retrying.",
      );
      this.clearBackoff(queueKey);
      return;
    }
    const environment = await this.storage.getEnvironment(queue.environmentId);
    if (!environment || environment.deletionRequestedAt) return;
    // A stopped or still-provisioning environment must not be driven by a
    // leftover queued prompt.
    if (!isEnvironmentReadyForAgents(environment)) {
      await this.defer(queueKey, "environment is not ready for agents");
      return;
    }

    // The composer owns the pane while the user is mid-draft. Draining under it
    // would type the queued prompt into whatever they are still writing.
    const draftKey = `${TMUX_AGENT}:${queue.environmentId}:${encodeURIComponent(stateKey)}`;
    const draft = await this.storage.getComposeDraft(draftKey);
    if (this.composeDraftHoldsQueue(draft?.value)) return;

    let status = await this.invoke<TmuxStatusSnapshot | null>("claude_tmux_status", {
      environmentId: target.environmentId,
      tabId: target.tabId,
    });
    if (!status || status.running !== true) {
      // The renderer is not the owner of a queued decision. Reconstruct an
      // existing detached tmux session (or start the missing one) so a backend
      // restart can continue draining with no mounted tab.
      status = await this.invoke<TmuxStatusSnapshot | null>("claude_tmux_start", {
        environmentId: target.environmentId,
        tabId: target.tabId,
      });
      if (!status || status.running !== true) {
        await this.defer(queueKey, "tmux session is not running");
        return;
      }
    }
    // Busy is not a failure: the turn in flight will finish and the next sweep
    // picks the queue up. Backing off here would delay it for no reason.
    if (status.busy === true) return;

    if (this.stopped) return;
    // Re-read the draft: the whole point of the interlock is the window between
    // the first check and taking the head.
    const latestDraft = await this.storage.getComposeDraft(draftKey);
    if (this.composeDraftHoldsQueue(latestDraft?.value)) return;

    const reservation = await this.storage.reservePromptQueueHeadForDispatch(queueKey);
    if (!reservation || typeof reservation.message !== "object") return;
    if (reservation.submittedAt) {
      await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
      this.confirmedSubmissions.delete(queueKey);
      this.clearBackoff(queueKey);
      return;
    }
    if (reservation.submittingAt) {
      if (this.confirmedSubmissions.get(queueKey) === reservation.requestId) {
        const submitted = await this.storage.markPromptQueueDispatchSubmitted(
          queueKey,
          reservation.requestId,
        );
        if (
          submitted?.inFlight?.requestId !== reservation.requestId ||
          !submitted.inFlight.submittedAt
        ) {
          this.confirmedSubmissions.delete(queueKey);
          return;
        }
        await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
        this.confirmedSubmissions.delete(queueKey);
        this.clearBackoff(queueKey);
        return;
      }
      await this.storage.failPromptQueueDispatch(
        queueKey,
        reservation.requestId,
        "Queued prompt submission was interrupted and may already have reached Claude. Review the pane before retrying.",
      );
      this.clearBackoff(queueKey);
      return;
    }

    // Revalidate every durable routing fact after reservation. Environment
    // deletion and queue replacement can both race the earlier asynchronous
    // status/draft checks.
    const [latestEnvironment, latestQueue, finalDraft] = await Promise.all([
      this.storage.getEnvironment(target.environmentId),
      this.storage.getPromptQueue(queueKey),
      this.storage.getComposeDraft(draftKey),
    ]);
    if (
      !latestEnvironment ||
      latestEnvironment.deletionRequestedAt ||
      !isEnvironmentReadyForAgents(latestEnvironment) ||
      latestQueue?.environmentId !== target.environmentId ||
      latestQueue.inFlight?.requestId !== reservation.requestId
    ) {
      await this.storage.failPromptQueueDispatch(
        queueKey,
        reservation.requestId,
        "Queued prompt target changed before submission. Review it before retrying.",
      );
      this.clearBackoff(queueKey);
      return;
    }
    if (this.composeDraftHoldsQueue(finalDraft?.value)) {
      // The reservation stays durable and will be revisited after the draft is
      // cleared. It has not crossed the irreversible submission boundary.
      return;
    }
    const message = reservation.message as Record<string, unknown>;
    const attachments = parseTmuxPromptAttachments(message.attachments);
    if (!nonBlank(message.text) && attachments.length === 0) {
      // Nothing to type. Consume it rather than retrying an empty prompt.
      await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
      return;
    }

    const prompt = buildTmuxPromptWithAttachments(
      nonBlank(message.text) ? message.text : "",
      attachments,
      latestEnvironment.containerId ?? undefined,
    );
    await this.renameEnvironmentFromFirstPrompt(latestEnvironment, prompt);
    const submitting = await this.storage.markPromptQueueDispatchSubmitting(
      queueKey,
      reservation.requestId,
    );
    if (
      submitting?.inFlight?.requestId !== reservation.requestId ||
      !submitting.inFlight.submittingAt
    )
      return;
    try {
      await this.invoke("claude_tmux_submit_queued", {
        environmentId: target.environmentId,
        tabId: target.tabId,
        text: prompt,
      });
    } catch (error) {
      // `send-keys` can fail after typing some or all of the prompt. There is no
      // safe automatic retry after crossing this boundary, so park it for an
      // explicit, informed user decision.
      await this.storage.failPromptQueueDispatch(
        queueKey,
        reservation.requestId,
        `Queued prompt submission may have partially completed (${error instanceof Error ? error.name : "unknown error"}). Review the pane before retrying.`,
      );
      this.clearBackoff(queueKey);
      return;
    }
    this.confirmedSubmissions.set(queueKey, reservation.requestId);
    const submitted = await this.storage.markPromptQueueDispatchSubmitted(
      queueKey,
      reservation.requestId,
    );
    if (
      submitted?.inFlight?.requestId !== reservation.requestId ||
      !submitted.inFlight.submittedAt
    ) {
      this.confirmedSubmissions.delete(queueKey);
      return;
    }
    await this.storage.acknowledgePromptQueueDispatch(queueKey, reservation.requestId);
    this.confirmedSubmissions.delete(queueKey);
    this.clearBackoff(queueKey);
  }

  /**
   * Back off failures that happen before a prompt has a dispatch reservation.
   * Once a reservation exists, failures are handled at their call sites and
   * parked with a durable error carrying that request identity.
   */
  private async defer(queueKey: string, reason: string): Promise<void> {
    const attempts = (this.queueAttempts.get(queueKey) ?? 0) + 1;
    this.queueAttempts.set(queueKey, attempts);
    if (attempts >= (this.options.maxDispatchAttempts ?? MAX_QUEUE_DISPATCH_ATTEMPTS)) {
      // The key and the reason are safe to log; the prompt itself never is.
      console.warn(`[prompt-queue] tmux queue ${queueKey} has failed ${attempts} times: ${reason}`);
    }
    const backoff = Math.min(
      this.options.retryCeilingMs ?? QUEUE_RETRY_CEILING_MS,
      (this.options.retryBaseMs ?? QUEUE_RETRY_BASE_MS) * 2 ** Math.min(attempts - 1, 8),
    );
    this.queueRetryAt.set(queueKey, Date.now() + backoff);
  }

  private clearBackoff(queueKey: string): void {
    this.queueAttempts.delete(queueKey);
    this.queueRetryAt.delete(queueKey);
  }

  /**
   * A draft that cannot be read is treated as holding the composer.
   *
   * Failing closed is the safe direction: the cost is a queue that waits, and
   * the alternative is typing over what the user is writing.
   */
  private composeDraftHoldsQueue(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (!value || typeof value !== "object" || Array.isArray(value)) return true;
    const draft = value as Record<string, unknown>;
    if (typeof draft.text !== "string") return true;
    if (!Array.isArray(draft.mentions) || !Array.isArray(draft.attachments)) return true;
    return (
      draft.text.trim().length > 0 || draft.mentions.length > 0 || draft.attachments.length > 0
    );
  }

  private async renameEnvironmentFromFirstPrompt(
    environment: Environment,
    prompt: string,
  ): Promise<void> {
    if (!nonBlank(prompt) || !isGeneratedEnvironmentName(environment.name)) return;
    try {
      await this.invoke("prepare_environment_first_prompt", {
        environmentId: environment.id,
        prompt,
      });
    } catch (error) {
      // A name is cosmetic; never let it block the prompt.
      console.warn(
        `[prompt-queue] Failed to rename ${environment.id} from its first prompt:`,
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }
}
