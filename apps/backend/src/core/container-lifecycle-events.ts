import type { CommandContext } from "./commands-context.js";
import { syncStoredEnvironmentStatus } from "./commands-environment.js";
import type { ContainerLifecycleAction } from "./container-oom-events.js";
import type { Environment } from "./models.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("docker");

/**
 * What a container lifecycle event from `docker events` does to the loops
 * that read that container.
 *
 * Without this, a container that died outside a lifecycle command (a crash,
 * an OOM of PID 1, `docker stop` by hand, a host restart) kept every loop
 * aimed at it running until something polled its status: the Claude state
 * poll and each tmux tab ran failing `docker exec`s, and the diff and PR
 * loops kept treating the environment as running.
 *
 * - The loops keyed by the container retire at once: the Claude state poll,
 *   its tmux hook doorbell, and each tmux tab, which checks liveness now and
 *   leaves through its own stopped path.
 * - Unless a lifecycle operation owns the environment right now (it settles
 *   status and loops itself), the stored status is reconciled with one
 *   `docker inspect`, then the diff and PR loops and the Claude state polls
 *   reconcile against it. A start outside the app re-adopts them the same way.
 *
 * Events for one container are coalesced: a burst (`die`, `stop`, `destroy`)
 * runs the reconciliation at most twice.
 */
export class ContainerLifecycleReactor {
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();

  constructor(private readonly context: () => CommandContext | null) {}

  handle(containerId: string, action: ContainerLifecycleAction): void {
    const context = this.context();
    if (!context) return;
    if (action !== "start") retireContainerLoops(context, containerId);
    this.schedule(containerId);
  }

  /** Settles once every reconciliation in flight has (tests). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all(Array.from(this.running.values()));
  }

  private schedule(containerId: string): void {
    if (this.running.has(containerId)) {
      this.again.add(containerId);
      return;
    }
    const run = this.reconcile(containerId).finally(() => {
      if (this.running.get(containerId) === run) this.running.delete(containerId);
      if (this.again.delete(containerId)) this.schedule(containerId);
    });
    this.running.set(containerId, run);
  }

  private async reconcile(containerId: string): Promise<void> {
    const context = this.context();
    if (!context) return;
    try {
      const environment = findByContainerId(await context.storage.loadEnvironments(), containerId);
      if (!environment) return;
      if (context.runtime.environments.hasLifecycleWork(environment.id)) return;
      await syncStoredEnvironmentStatus(environment, context);
      await context.runtime.diffStats.sync(context);
      await context.runtime.prMonitor.sync(context);
      await context.runtime.tmux.claudeStatePolls.reconcile(context);
    } catch (error) {
      log.warn("lifecycle-event.reconcile-failed", { error: formatLogError(error) });
    }
  }
}

/**
 * Retires the loops keyed by `containerId` (a full or short id) without
 * waiting for storage: the container is gone, so their next exec would fail.
 */
export function retireContainerLoops(context: CommandContext, containerId: string): void {
  const tmux = context.runtime.tmux;
  tmux.claudeStatePolls.shutdownMatching(containerId);
  tmux.hookSignals.forgetMatching(containerId);
  tmux.sessions.containerEnded(containerId);
}

export function containerIdsMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function findByContainerId(
  environments: readonly Environment[],
  containerId: string,
): Environment | undefined {
  return environments.find(
    (environment) =>
      environment.environmentType !== "local" &&
      Boolean(environment.containerId) &&
      containerIdsMatch(environment.containerId!, containerId),
  );
}
