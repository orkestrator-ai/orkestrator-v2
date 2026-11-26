/**
 * The inventory's native plugin listings, one provider CLI each
 * (docs/architecture/agent-capabilities-management.md, "Inventory reads").
 *
 * Each agent gets `INVENTORY_PLUGIN_LIST_TIMEOUT_MS`, far below the 20 s the
 * settings' extension discovery allows: a listing that does not answer in
 * time is reported as an inventory error naming the agent, and the other
 * agents' plugins are still listed. The first timeout of a run of timeouts is
 * logged with the agent's name, never its output.
 */
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { createLogger } from "@orkestrator/protocol/logger";
import { boundedWait } from "@orkestrator/protocol/node/bounded-wait";

import { CommandFailedError } from "../command-capture.js";
import {
  discoverAgentPlugins,
  type AgentPluginCatalog,
  type ExtensionCommandRunner,
} from "../extension-discovery.js";
import type { InventoryPlugin, InventoryPluginListing } from "./inventory.js";

const log = createLogger("capabilities");

/** How long one agent's plugin listing may take before the inventory reports it unreadable. */
export const INVENTORY_PLUGIN_LIST_TIMEOUT_MS = 5_000;

/** The providers whose plugins the inventory lists. */
export const INVENTORY_PLUGIN_PROVIDERS = ["claude", "codex", "grok", "opencode", "pi"] as const;

type InventoryPluginProvider = (typeof INVENTORY_PLUGIN_PROVIDERS)[number];

export function inventoryPluginTimeoutMessage(provider: AgentPlatform, timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `${AGENT_PLATFORM_LABELS[provider]} did not list its plugins within ${seconds} s.`;
}

/**
 * Builds the inventory's `plugins` source over a command runner. The runner
 * should carry the same timeout so a hung CLI is also killed; the deadline
 * here holds even when it is not.
 */
export function inventoryPluginLister(input: {
  run: ExtensionCommandRunner;
  timeoutMs?: number;
  providers?: readonly InventoryPluginProvider[];
  discover?: typeof discoverAgentPlugins;
}): () => Promise<InventoryPluginListing> {
  const timeoutMs = input.timeoutMs ?? INVENTORY_PLUGIN_LIST_TIMEOUT_MS;
  const providers = input.providers ?? INVENTORY_PLUGIN_PROVIDERS;
  const discover = input.discover ?? discoverAgentPlugins;
  /** Agents whose last listing timed out and was already logged. */
  const reported = new Set<InventoryPluginProvider>();

  const listOne = async (
    provider: InventoryPluginProvider,
  ): Promise<{ catalog?: AgentPluginCatalog; timedOut: boolean }> => {
    let killed = false;
    const run: ExtensionCommandRunner = (agent, args) =>
      input.run(agent, args).catch((error: unknown) => {
        if (error instanceof CommandFailedError && error.timedOut) killed = true;
        throw error;
      });
    try {
      const result = await boundedWait(discover(provider, run), timeoutMs);
      if (!result.settled || killed) return { timedOut: true };
      return { catalog: result.value, timedOut: false };
    } catch {
      return { timedOut: killed };
    }
  };

  return async () => {
    const results = await Promise.all(
      providers.map(async (provider) => ({ provider, ...(await listOne(provider)) })),
    );
    const plugins: InventoryPlugin[] = [];
    const errors: Array<{ message: string }> = [];
    for (const { provider, catalog, timedOut } of results) {
      if (timedOut) {
        errors.push({ message: inventoryPluginTimeoutMessage(provider, timeoutMs) });
        if (!reported.has(provider)) {
          reported.add(provider);
          log.warn("inventory.plugin-list-timed-out", { provider, timeoutMs });
        }
        continue;
      }
      reported.delete(provider);
      for (const plugin of catalog?.plugins ?? []) {
        plugins.push({
          provider: catalog!.agent as AgentPlatform,
          qualifiedId: plugin.qualifiedId ?? plugin.name,
          name: plugin.name,
          enabled:
            plugin.status === "disabled" ? false : plugin.status === "configured" ? true : null,
        });
      }
    }
    return { plugins, errors };
  };
}
