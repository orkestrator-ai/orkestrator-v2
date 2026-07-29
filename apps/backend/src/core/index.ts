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
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { FRONTEND_AGENT_ACTIVITY_LEASE_MS } from "@orkestrator/protocol/agent-activity";
import {
  EnvironmentLifecycleTaskTracker,
  reconcileInterruptedEnvironmentLifecycleTasks,
} from "./environment-lifecycle-tasks.js";

export class OrkestratorBackend {
  private readonly commands = createCommandRegistry();
  private readonly context: CommandContext;
  private readonly environmentLifecycleTasks: EnvironmentLifecycleTaskTracker;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private activityLeaseSweep: ReturnType<typeof setInterval> | null = null;
  private readonly reapPidServers: typeof reapOrphanedLocalServers;
  private readonly reapTmuxRuntimes: typeof reapOrphanedClaudeTmuxRuntimes;

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
    environmentLifecycleTasks?: EnvironmentLifecycleTaskTracker;
  }) {
    const storage = new StorageService(options.dataDir);
    this.environmentLifecycleTasks =
      options.environmentLifecycleTasks ?? new EnvironmentLifecycleTaskTracker();
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
    await reconcileInterruptedEnvironmentLifecycleTasks(this.context.storage);
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
      // Both admission gates close together, before either drain begins.
      // Draining lifecycle work first while local-server starts stayed open
      // would let a bridge spawn during the very window shutdown exists to
      // close, and a SIGKILL in that window orphans its process tree.
      closeLocalServerAdmission();
      await this.environmentLifecycleTasks.beginShutdown();
      await shutdownLocalServers();
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
