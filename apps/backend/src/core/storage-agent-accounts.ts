import path from "node:path";

import { parseAgentAccountStore, type AgentAccountStore } from "./agent-accounts-store.js";
import type { StorageContext } from "./storage-context.js";

/** The registry of provider accounts (`agent-accounts.json`). */
export class AgentAccountsRepository {
  constructor(private readonly context: StorageContext) {}

  /** Root of the per-account provider configuration directories. */
  agentAccountsDirectory(): string {
    return path.join(this.context.dataDir, "agent-accounts");
  }

  private agentAccountsFile(): string {
    return this.context.file("agent-accounts.json");
  }

  async loadAgentAccounts(): Promise<AgentAccountStore> {
    return parseAgentAccountStore(
      await this.context.loadJsonCached<unknown>(this.agentAccountsFile(), () => null),
    );
  }

  /**
   * Serialized read-modify-write of the account registry. Returning the store
   * unchanged (the same object) skips the write.
   */
  mutateAgentAccounts<T>(
    mutate: (
      store: AgentAccountStore,
    ) => { store: AgentAccountStore; result: T } | Promise<{ store: AgentAccountStore; result: T }>,
  ): Promise<T> {
    return this.context.serialize(this.agentAccountsFile(), "agent account storage", async () => {
      const current = await this.loadAgentAccounts();
      const { store, result } = await mutate(current);
      if (store !== current) {
        await this.context.saveSensitiveJson(
          this.agentAccountsFile(),
          parseAgentAccountStore(store),
        );
      }
      return result;
    });
  }
}
