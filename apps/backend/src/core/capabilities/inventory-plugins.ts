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
  parseClaudePlugins,
  type AgentPluginCatalog,
  type ExtensionCommandRunner,
} from "../extension-discovery.js";
import type { InventoryPlugin, InventoryPluginListing } from "./inventory.js";
import { InventoryPluginCache } from "./inventory-cache.js";
import {
  parseClaudePluginList,
  type ClaudePluginAdapter,
  type ClaudeInstalledPlugin,
  type ManagedClaudePluginObservation,
} from "./provider-adapters/claude-plugins.js";
import type { ProviderCli } from "./provider-adapters/provider-cli.js";
import { CapabilityError } from "./security.js";
import type { InventoryReadOptions } from "./service-context.js";

const log = createLogger("capabilities");

/** How long one agent's plugin listing may take before the inventory reports it unreadable. */
export const INVENTORY_PLUGIN_LIST_TIMEOUT_MS = 5_000;

/**
 * How old a settled Claude listing may be to serve launch evidence. Long
 * enough for a leaf's two reads of one launch (its command node's fenced
 * observation, then its own recheck after the answer) to share one listing;
 * short enough that a plugin switched outside Orkestrator is seen by the next
 * launch. Full reads use the cache's whole window.
 */
export const LAUNCH_PLUGIN_LISTING_MAX_AGE_MS = 15_000;

/** The providers whose plugins the inventory lists. */
export const INVENTORY_PLUGIN_PROVIDERS = ["claude", "codex", "grok", "opencode", "pi"] as const;

type InventoryPluginProvider = (typeof INVENTORY_PLUGIN_PROVIDERS)[number];

export function inventoryPluginTimeoutMessage(provider: AgentPlatform, timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `${AGENT_PLATFORM_LABELS[provider]} did not list its plugins within ${seconds} s.`;
}

/** Log once until the provider answers again. */
function timeoutReporter(timeoutMs: number) {
  const reported = new Set<InventoryPluginProvider>();
  return (provider: InventoryPluginProvider, timedOut: boolean): void => {
    if (!timedOut) {
      reported.delete(provider);
    } else if (!reported.has(provider)) {
      reported.add(provider);
      log.warn("inventory.plugin-list-timed-out", { provider, timeoutMs });
    }
  };
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
  const reportTimeout = timeoutReporter(timeoutMs);

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
      reportTimeout(provider, timedOut);
      if (timedOut) {
        errors.push({ message: inventoryPluginTimeoutMessage(provider, timeoutMs) });
        continue;
      }
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

/**
 * Managed and unmanaged Claude inventory share one CLI result, and readers
 * share it the way the other providers' listings are shared: one listing in
 * flight, a settled one served for the cache window (a launch accepts only a
 * listing under `LAUNCH_PLUGIN_LISTING_MAX_AGE_MS` old), and none served
 * across a change this machine applied. `refresh` lists again.
 */
export function createClaudeInventoryPluginSource(input: {
  adapter: ClaudePluginAdapter;
  cli: ProviderCli;
  includeUnmanaged: boolean;
  timeoutMs?: number;
  launchMaxAgeMs?: number;
  ttlMs?: number;
  now?: () => number;
}) {
  const timeoutMs = input.timeoutMs ?? INVENTORY_PLUGIN_LIST_TIMEOUT_MS;
  const launchMaxAgeMs = input.launchMaxAgeMs ?? LAUNCH_PLUGIN_LISTING_MAX_AGE_MS;
  const reportTimeout = timeoutReporter(timeoutMs);
  const cache = new InventoryPluginCache(
    async () => {
      const answer = await boundedWait(input.cli(["plugin", "list", "--json"]), timeoutMs).catch(
        () => undefined,
      );
      const timedOut = answer !== undefined && (!answer.settled || answer.value.timedOut === true);
      reportTimeout("claude", timedOut);
      const stdout =
        answer?.settled && !timedOut && answer.value.exitCode === 0
          ? answer.value.stdout
          : undefined;
      const managed = stdout === undefined ? null : parseClaudePluginList(stdout);
      const unmanaged =
        input.includeUnmanaged && stdout !== undefined ? parseClaudePlugins(stdout) : [];
      return { managed, unmanaged, timedOut };
    },
    {
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      ...(input.now ? { now: input.now } : {}),
    },
  );

  return {
    invalidate: () => cache.invalidate(),
    read(
      options: InventoryReadOptions,
    ): Pick<import("./inventory.js").InventorySources, "managedPlugins" | "plugins"> {
      let listing: ReturnType<typeof cache.read> | undefined;
      const read = () =>
        (listing ??= cache.read({
          refresh: options.refresh === true,
          ...(options.launch ? { maxAgeMs: launchMaxAgeMs } : {}),
        }));
      return {
        ...(options.launch && !options.managedPluginComponents?.length
          ? {}
          : {
              managedPlugins: (): Promise<ManagedClaudePluginObservation[]> =>
                input.adapter.observe(
                  options.launch ? new Set(options.managedPluginComponents) : undefined,
                  async (): Promise<ClaudeInstalledPlugin[]> => {
                    // The installed bytes are verified live from these paths.
                    const { managed } = await read();
                    if (!managed) {
                      throw new CapabilityError(
                        "source-unavailable",
                        "Claude's plugin list could not be read.",
                      );
                    }
                    return managed;
                  },
                ),
            }),
        ...(!options.launch && input.includeUnmanaged
          ? {
              plugins: async (): Promise<InventoryPluginListing> => {
                const { unmanaged, timedOut } = await read();
                return {
                  plugins: unmanaged.map((plugin) => ({
                    provider: "claude",
                    qualifiedId: plugin.qualifiedId ?? plugin.name,
                    name: plugin.name,
                    enabled: plugin.status !== "disabled",
                  })),
                  ...(timedOut
                    ? { errors: [{ message: inventoryPluginTimeoutMessage("claude", timeoutMs) }] }
                    : {}),
                };
              },
            }
          : {}),
      };
    },
  };
}
