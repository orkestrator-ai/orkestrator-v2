import { createCommandRegistry, type BackendEmit, type CommandContext } from "./commands.js";
import { StorageService } from "./storage.js";

export class OrkestratorBackend {
  private readonly commands = createCommandRegistry();
  private readonly context: CommandContext;

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
  }

  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const handler = this.commands.get(command);
    if (!handler) throw new Error(`Unknown backend command: ${command}`);
    return await handler(args, this.context) as T;
  }
}
