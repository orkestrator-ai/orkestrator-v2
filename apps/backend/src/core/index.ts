import {
  createCommandRegistry,
  shutdownLocalServers,
  type BackendEmit,
  type CommandContext,
} from "./commands.js";
import { reapOrphanedLocalServers } from "./local-server-reaper.js";
import { StorageService } from "./storage.js";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { FRONTEND_AGENT_ACTIVITY_LEASE_MS } from "@orkestrator/protocol/agent-activity";

export class OrkestratorBackend {
  private readonly commands = createCommandRegistry();
  private readonly context: CommandContext;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private activityLeaseSweep: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    dataDir: string;
    toolchainBinDir: string;
    appRoot: string;
    resourceRoot: string;
    emit: BackendEmit;
  }) {
    const storage = new StorageService(options.dataDir);
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
    };
  }

  async init(): Promise<void> {
    await this.context.storage.init();
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
    await reapOrphanedLocalServers({ storage: this.context.storage }).catch(
      (error) => {
        console.warn("[backend] Failed to reap orphaned local servers:", error);
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
    const attempt = shutdownLocalServers();
    this.shutdownPromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.shutdownPromise === attempt) this.shutdownPromise = null;
      throw error;
    }
  }
}
