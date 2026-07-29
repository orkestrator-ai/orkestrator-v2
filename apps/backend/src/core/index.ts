import {
  closeLocalServerAdmission,
  createCommandRegistry,
  shutdownDiffStatsTracking,
  shutdownLocalServers,
  shutdownPrMonitorTracking,
  type BackendEmit,
  type CommandContext,
} from "./commands.js";
import {
  reapOrphanedClaudeTmuxRuntimes,
  reapOrphanedLocalServers,
} from "./local-server-reaper.js";
import { claudeTmuxRuntimeRootPrefix } from "./tmux.js";
import { StorageService } from "./storage.js";
import { AgentToolsServer } from "./agent-tools.js";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { FRONTEND_AGENT_ACTIVITY_LEASE_MS } from "@orkestrator/protocol/agent-activity";
import {
  ENVIRONMENT_LIFECYCLE_DRAIN_TIMEOUT_MS,
  EnvironmentLifecycleTaskTracker,
  reconcileInterruptedEnvironmentLifecycleTasks,
} from "./environment-lifecycle-tasks.js";

export class OrkestratorBackend {
  private readonly commands = createCommandRegistry();
  private readonly context: CommandContext;
  private readonly environmentLifecycleTasks: EnvironmentLifecycleTaskTracker;
  private readonly environmentLifecycleDrainTimeoutMs: number;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private activityLeaseSweep: ReturnType<typeof setInterval> | null = null;
  private readonly reapPidServers: typeof reapOrphanedLocalServers;
  private readonly reapTmuxRuntimes: typeof reapOrphanedClaudeTmuxRuntimes;
  private readonly agentTools: Pick<
    AgentToolsServer,
    "connection" | "revokeEnvironment" | "start" | "stop"
  >;

  constructor(options: {
    dataDir: string;
    toolchainBinDir: string;
    appRoot: string;
    resourceRoot: string;
    emit: BackendEmit;
    startupReapers?: {
      localServers?: typeof reapOrphanedLocalServers;
      claudeTmuxRuntimes?: typeof reapOrphanedClaudeTmuxRuntimes;
    };
    agentTools?: Pick<
      AgentToolsServer,
      "connection" | "revokeEnvironment" | "start" | "stop"
    >;
    environmentLifecycleTasks?: EnvironmentLifecycleTaskTracker;
    environmentLifecycleDrainTimeoutMs?: number;
  }) {
    const storage = new StorageService(options.dataDir);
    this.agentTools = options.agentTools ?? new AgentToolsServer(storage);
    this.environmentLifecycleTasks =
      options.environmentLifecycleTasks ?? new EnvironmentLifecycleTaskTracker();
    this.environmentLifecycleDrainTimeoutMs =
      options.environmentLifecycleDrainTimeoutMs
      ?? ENVIRONMENT_LIFECYCLE_DRAIN_TIMEOUT_MS;
    // Every committed mutation fans out to all connected clients, so a second
    // window or browser converges without polling. `emit` is read lazily by the
    // caller's closure, which is how this survives the gateway not existing yet.
    storage.setResourceChangeListener((change) => {
      options.emit(RESOURCE_CHANGED_EVENT, change);
    });
    this.context = {
      storage,
      toolchainBinDir: options.toolchainBinDir,
      appRoot: options.appRoot,
      resourceRoot: options.resourceRoot,
      emit: options.emit,
      agentTools: this.agentTools,
      environmentLifecycleTasks: this.environmentLifecycleTasks,
    };
    this.reapPidServers =
      options.startupReapers?.localServers ?? reapOrphanedLocalServers;
    this.reapTmuxRuntimes =
      options.startupReapers?.claudeTmuxRuntimes
      ?? reapOrphanedClaudeTmuxRuntimes;
  }

  async init(): Promise<void> {
    await this.context.storage.init();
    // Do not accept commands while durable state claims work is still running
    // from a previous process. If this write fails, startup fails closed rather
    // than exposing progress that this backend can never complete.
    const lifecycleRecovery =
      await reconcileInterruptedEnvironmentLifecycleTasks(this.context.storage);
    await this.agentTools.start();
    // No renderer can be alive yet, so every persisted `frontend` activity
    // snapshot belongs to a process that is gone. They cannot be retracted
    // later — the aggregate is a max — so a renderer that quit mid-turn would
    // otherwise leave its environment showing "working" forever.
    await this.context.storage.clearFrontendAgentActivity().catch((error) => {
      console.warn("[backend] Failed to clear stale agent activity:", error);
    });
    this.activityLeaseSweep ??= setInterval(() => {
      void this.context.storage.expireFrontendAgentActivityLeases().catch(
        (error) => {
          console.warn("[backend] Failed to expire agent activity leases:", error);
        },
      );
    }, FRONTEND_AGENT_ACTIVITY_LEASE_MS / 2);
    this.activityLeaseSweep.unref?.();
    // Before the gateway can accept a start command: bridges left behind by a
    // backend that died without draining must be reaped first, or the codex
    // pidfile they still hold blocks this instance's app-server ownership.
    await this.reapPidServers({ storage: this.context.storage }).catch(
      (error) => {
        console.warn("[backend] Failed to reap orphaned local servers:", error);
      },
    );
    // claude-tmux leaves no PID behind — its sessions belong to a tmux server
    // we do not own — so its orphans are found by their runtime roots instead.
    await this.reapTmuxRuntimes({
      storage: this.context.storage,
      runtimeRootPrefix: claudeTmuxRuntimeRootPrefix(
        this.context.storage.getDataDir(),
      ),
    }).catch(
      (error) => {
        console.warn("[backend] Failed to reap orphaned claude-tmux runtimes:", error);
      },
    );

    // The durable deletion tombstone stays in place across a crash so queues,
    // pipelines, and starts remain blocked. Once orphaned processes have been
    // reaped, re-admit the ordinary idempotent delete path; it owns every child
    // cleanup and removes the tombstone only by removing the environment.
    const deleteEnvironment = this.commands.get("delete_environment");
    if (!deleteEnvironment && lifecycleRecovery.deletionRecoveryEnvironmentIds.length > 0) {
      throw new Error("Delete command is unavailable during lifecycle recovery");
    }
    for (const environmentId of lifecycleRecovery.deletionRecoveryEnvironmentIds) {
      const recovery = Promise.resolve(
        deleteEnvironment?.({ environmentId }, this.context),
      );
      void recovery.catch(() => {
        // Detailed subprocess failures are logged at their owning boundary.
        // Keep this coordination log free of paths, command output, or secrets.
        console.warn(
          `[backend] Interrupted deletion remains pending for ${environmentId}`,
        );
      });
    }
  }

  /**
   * Whether `command` is registered, independent of whether it can run now.
   *
   * The gateway gates metric labels on this so a name it rejects is never
   * retained, including when `invoke` refuses for an unrelated reason such as
   * shutdown and so never reaches the registry lookup below.
   */
  hasCommand(command: string): boolean {
    return this.commands.has(command);
  }

  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.shuttingDown) throw new Error("Backend is shutting down");
    const handler = this.commands.get(command);
    if (!handler) throw new Error(`Unknown backend command: ${command}`);
    return await handler(args, this.context) as T;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    if (this.activityLeaseSweep) {
      clearInterval(this.activityLeaseSweep);
      this.activityLeaseSweep = null;
    }
    // Synchronous and cannot fail, so it runs before the awaited drain rather
    // than racing it: every watcher holds a file descriptor and a debounce timer.
    shutdownDiffStatsTracking();
    shutdownPrMonitorTracking();
    const attempt = (async () => {
      try {
        const lifecycleDeadline =
          Date.now() + this.environmentLifecycleDrainTimeoutMs;
        // Both admission gates close together, before either drain begins.
        // Draining lifecycle work first while local-server starts stayed open
        // would let a bridge spawn during the very window shutdown exists to
        // close, and a SIGKILL in that window orphans its process tree.
        closeLocalServerAdmission();
        await this.environmentLifecycleTasks.beginShutdown(
          this.environmentLifecycleDrainTimeoutMs,
        );
        await shutdownLocalServers({
          operationDrainTimeoutMs: Math.max(0, lifecycleDeadline - Date.now()),
        });
      } finally {
        await this.agentTools.stop();
      }
    })();
    this.shutdownPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.shutdownPromise === attempt) this.shutdownPromise = null;
      throw error;
    }
  }
}
