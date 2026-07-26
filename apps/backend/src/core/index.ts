import {
  createCommandRegistry,
  shutdownLocalServers,
  type BackendEmit,
  type CommandContext,
} from "./commands.js";
import { reapOrphanedLocalServers } from "./local-server-reaper.js";
import { StorageService } from "./storage.js";

export class OrkestratorBackend {
  private readonly commands = createCommandRegistry();
  private readonly context: CommandContext;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: {
    dataDir: string;
    toolchainBinDir: string;
    appRoot: string;
    resourceRoot: string;
    emit: BackendEmit;
  }) {
    this.context = {
      storage: new StorageService(options.dataDir),
      toolchainBinDir: options.toolchainBinDir,
      appRoot: options.appRoot,
      resourceRoot: options.resourceRoot,
      emit: options.emit,
    };
  }

  async init(): Promise<void> {
    await this.context.storage.init();
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
