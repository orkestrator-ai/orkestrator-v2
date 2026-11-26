/**
 * What is installed on this machine, managed or not
 * (docs/architecture/agent-capabilities-management.md, "Discovery").
 *
 * The inventory lists every component in the locations Orkestrator can
 * manage (with ownership and drift), the native plugins each provider
 * reports (fully qualified ids, so two marketplaces' `review` stay two
 * rows), and the MCP servers in each provider's configuration. It is
 * bounded and carries only home-relative labels and opaque ids.
 */
import os from "node:os";

import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CapabilityInventory,
  CapabilityObservedItem,
} from "@orkestrator/protocol/capability-resources-api";
import { CAPABILITY_LOCATIONS } from "@orkestrator/protocol/capability-resources-support";

import { listLocation, type CapabilityHomes } from "./native-ownership.js";
import type { ManagedClaudePluginObservation } from "./provider-adapters/claude-plugins.js";

const MAX_ITEMS = 3_000;

export interface InventoryPlugin {
  provider: AgentPlatform;
  qualifiedId: string;
  name: string;
  enabled: boolean | null;
}

export interface InventoryMcpServer {
  provider: AgentPlatform;
  name: string;
  enabled: boolean | null;
  sourceLabel: string;
}

/**
 * The native plugins the provider CLIs list. An agent whose listing could not
 * be read is named in `errors`; those errors carry no `provider`, because
 * unmanaged plugins are never evidence for a managed installation, so they
 * must not hold back what the reconciler confirms for that provider.
 */
export interface InventoryPluginListing {
  plugins: InventoryPlugin[];
  errors?: Array<{ message: string }>;
}

export interface InventorySources {
  homes: CapabilityHomes;
  /** Which providers are installed on this machine. */
  providers(): Promise<Array<{ provider: AgentPlatform; available: boolean; version?: string }>>;
  /** Runs provider CLIs: slow, so the service caches it (`inventory-cache.ts`). */
  plugins?(): Promise<InventoryPluginListing>;
  /** Plugins in Orkestrator's own Claude marketplace, with the bytes Claude reads. */
  managedPlugins?(): Promise<ManagedClaudePluginObservation[]>;
  mcpServers?(): Promise<InventoryMcpServer[]>;
}

/** This machine's inventory. Every source's failure is reported, never fatal. */
export async function collectCapabilityInventory(
  nodeId: string,
  sources: InventorySources,
  now: () => string = () => new Date().toISOString(),
): Promise<CapabilityInventory> {
  const errors: CapabilityInventory["errors"] = [];
  const items: CapabilityObservedItem[] = [];
  for (const location of CAPABILITY_LOCATIONS) {
    try {
      for (const item of await listLocation(location, sources.homes)) {
        const drifted = item.managed !== null && item.digest !== item.managed.digest;
        items.push({
          id: `${location.id}/${item.entry}`,
          provider: location.owner === "shared" ? location.readBy[0]! : location.owner,
          kind: location.kind,
          name: item.name,
          locationId: location.id,
          locationLabel: location.label,
          ownership: item.managed ? "managed" : "external",
          ...(item.managed
            ? {
                packageId: item.managed.packageId,
                componentId: item.managed.componentId,
                expectedDigest: item.managed.digest,
              }
            : {}),
          ...(item.digest ? { digest: item.digest } : {}),
          ...(drifted ? { drifted: true } : {}),
          visibleTo: [...location.readBy],
        });
      }
    } catch {
      errors.push({ message: `Could not read ${location.label}.` });
    }
  }
  // The same name in two locations a provider reads: the later one is shadowed.
  const seen = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "skill") continue;
    for (const provider of item.visibleTo) {
      const key = `${provider}:${item.name}`;
      if (seen.has(key) && seen.get(key) !== item.id) item.shadowed = true;
      else seen.set(key, item.id);
    }
  }

  // Managed plugins are keyed like any managed installation: `plugin:<provider>` and the component.
  const managedPluginIds = new Set<string>();
  if (sources.managedPlugins) {
    try {
      for (const plugin of await sources.managedPlugins()) {
        managedPluginIds.add(`${plugin.provider}:${plugin.qualifiedId}`);
        if (!plugin.installed) continue;
        items.push({
          id: `${plugin.provider}:plugin:${plugin.qualifiedId}`,
          provider: plugin.provider,
          kind: "native-plugin",
          name: plugin.name,
          locationId: `plugin:${plugin.provider}`,
          locationLabel: "Orkestrator's Claude plugin marketplace",
          ownership: "managed",
          packageId: plugin.packageId,
          componentId: plugin.componentId,
          expectedDigest: plugin.expectedDigest,
          ...(plugin.digest ? { digest: plugin.digest } : {}),
          ...(plugin.drifted ? { drifted: true } : {}),
          qualifiedId: plugin.qualifiedId,
          enabled: plugin.enabled,
          visibleTo: [plugin.provider],
        });
      }
    } catch {
      errors.push({ provider: "claude", message: "Could not read Orkestrator's Claude plugins." });
    }
  }
  if (sources.plugins) {
    try {
      const listing = await sources.plugins();
      errors.push(...(listing.errors ?? []).map((error) => ({ message: error.message })));
      for (const plugin of listing.plugins) {
        if (managedPluginIds.has(`${plugin.provider}:${plugin.qualifiedId}`)) continue;
        items.push({
          id: `${plugin.provider}:plugin:${plugin.qualifiedId}`,
          provider: plugin.provider,
          kind: "native-plugin",
          name: plugin.name,
          locationId: "plugin",
          locationLabel: `${plugin.provider} plugins`,
          ownership: "plugin",
          qualifiedId: plugin.qualifiedId,
          enabled: plugin.enabled,
          visibleTo: [plugin.provider],
        });
      }
    } catch {
      errors.push({ message: "Could not list native plugins." });
    }
  }
  if (sources.mcpServers) {
    try {
      for (const server of await sources.mcpServers()) {
        items.push({
          id: `${server.provider}:mcp:${server.name}`,
          provider: server.provider,
          kind: "mcp-server",
          name: server.name,
          locationId: "mcp",
          locationLabel: server.sourceLabel,
          ownership: "external",
          enabled: server.enabled,
          visibleTo: [server.provider],
        });
      }
    } catch {
      errors.push({ message: "Could not list MCP servers." });
    }
  }

  let providers: CapabilityInventory["providers"];
  try {
    providers = await sources.providers();
  } catch {
    providers = AGENT_PLATFORMS.map((provider) => ({ provider, available: false }));
    errors.push({ message: "Could not check which agents are installed." });
  }
  const truncated = Math.max(0, items.length - MAX_ITEMS);
  return {
    nodeId,
    observedAt: now(),
    os: `${os.platform()}-${os.arch()}`,
    providers,
    items: items.slice(0, MAX_ITEMS),
    truncated,
    errors,
  };
}

/** MCP ownership and runtime eligibility answer different questions. */
export function isLaunchInventoryEvidence(item: CapabilityObservedItem): boolean {
  if (item.kind !== "mcp-server") return item.ownership === "managed";
  return (
    item.enabled !== false &&
    (item.ownership === "managed" ||
      (item.ownership === "external" &&
        item.enabled === true &&
        !!item.componentId &&
        !!item.digest))
  );
}
