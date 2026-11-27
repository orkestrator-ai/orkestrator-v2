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
  claudePluginItems,
  discoverAgentPlugins,
  parseClaudeJsonOutput,
  type AgentPluginCatalog,
  type ExtensionCommandRunner,
} from "../extension-discovery.js";
import type { InventoryPlugin, InventoryPluginListing } from "./inventory.js";
import { InventoryPluginCache } from "./inventory-cache.js";
import {
  claudeInstalledPlugins,
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
 * Full inventory shares one CLI result for both Claude projections. Launch
 * evidence starts a fresh listing, reusable by the two checks of one leaf
 * launch while the plugin configuration is unchanged.
 */
export function createClaudeInventoryPluginSource(input: {
  adapter: ClaudePluginAdapter;
  cli: ProviderCli;
  includeUnmanaged: boolean;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
}) {
  const timeoutMs = input.timeoutMs ?? INVENTORY_PLUGIN_LIST_TIMEOUT_MS;
  const reportTimeout = timeoutReporter(timeoutMs);
  const load = async () => {
    const answer = await boundedWait(input.cli(["plugin", "list", "--json"]), timeoutMs).catch(
      () => undefined,
    );
    const timedOut = answer !== undefined && (!answer.settled || answer.value.timedOut === true);
    reportTimeout("claude", timedOut);
    const answered = answer?.settled && !timedOut && answer.value.exitCode === 0;
    const parsed = answered ? parseClaudeJsonOutput(answer.value.stdout) : undefined;
    if (answered && parsed === undefined) {
      throw new CapabilityError("source-unavailable", "Claude's plugin list could not be read.");
    }
    return { parsed, timedOut };
  };
  const cache = new InventoryPluginCache(load, { ttlMs: input.ttlMs, now: input.now });
  const launches = new WeakMap<
    object,
    { generation: number; revision: string; listing: ReturnType<typeof load> }
  >();

  async function readLaunch(scope: object): ReturnType<typeof load> {
    const revision = await input.adapter.pluginListingRevision();
    const generation = cache.generation;
    let entry = launches.get(scope);
    if (!entry || entry.generation !== generation || entry.revision !== revision) {
      const listing = load();
      if (revision === undefined) return listing;
      entry = { generation, revision, listing };
      launches.set(scope, entry);
    }
    const result = await entry.listing;
    if (
      (await input.adapter.pluginListingRevision()) !== revision ||
      cache.generation !== generation
    ) {
      throw new CapabilityError("source-unavailable", "Claude's plugin configuration changed.");
    }
    return result;
  }

  return {
    invalidate: () => cache.invalidate(),
    read(
      options: InventoryReadOptions,
    ): Pick<import("./inventory.js").InventorySources, "managedPlugins" | "plugins"> {
      let listing: ReturnType<typeof cache.read> | undefined;
      const read = () =>
        (listing ??= options.launch
          ? readLaunch(options.pluginListingScope ?? {})
          : cache.read({ refresh: options.refresh }));
      return {
        ...(options.launch && !options.managedPluginComponents?.length
          ? {}
          : {
              managedPlugins: (): Promise<ManagedClaudePluginObservation[]> =>
                input.adapter.observe(
                  options.launch ? new Set(options.managedPluginComponents) : undefined,
                  async (): Promise<ClaudeInstalledPlugin[]> => {
                    // The installed bytes are verified live from these paths.
                    const { parsed } = await read();
                    const managed = claudeInstalledPlugins(parsed);
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
                const { parsed, timedOut } = await read();
                return {
                  plugins: claudePluginItems(parsed).map((plugin) => ({
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
