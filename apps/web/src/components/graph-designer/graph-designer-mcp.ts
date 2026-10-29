import { useEffect, useState } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { McpManagementSnapshot, McpTargetList } from "@orkestrator/protocol/mcp-management";
import { isNativeAgentMcpServerName } from "@orkestrator/protocol/native-agent";
import { getMcpManagementSnapshot, listMcpManagementTargets } from "@/lib/backend/mcp-management";

/**
 * The user MCP servers a graph node can be granted (item 404): the servers in
 * the user's own configuration files, as the Settings "MCP servers" section
 * reads them. Names only: a template selects a server the user configured and
 * never carries its definition. Project files are left out, because a grant
 * comes from the user, not from the repository the template runs against.
 */

export interface ConfiguredMcpServer {
  name: string;
  /** The providers whose user configuration has a server of this name. */
  providers: AgentPlatform[];
}

export type ConfiguredMcpServers =
  | { state: "loading" }
  | { state: "ready"; servers: ConfiguredMcpServer[] }
  | { state: "unavailable" };

/** Most servers the picker lists. */
export const GRAPH_DESIGNER_MCP_SERVERS_MAX = 64;

export interface ConfiguredMcpServerSource {
  listTargets: () => Promise<McpTargetList | undefined>;
  snapshot: (targetId: string) => Promise<McpManagementSnapshot | undefined>;
}

const BACKEND_SOURCE: ConfiguredMcpServerSource = {
  listTargets: () => listMcpManagementTargets(),
  snapshot: (targetId) => getMcpManagementSnapshot(targetId),
};

/**
 * Every server name in the backend's user-scope MCP files, across providers.
 * A provider whose snapshot fails is skipped; failing to list the targets at
 * all throws, so the picker can say it could not read them.
 */
export async function loadConfiguredUserMcpServers(
  source: ConfiguredMcpServerSource = BACKEND_SOURCE,
): Promise<ConfiguredMcpServer[]> {
  const list = await source.listTargets();
  const targets = (list?.targets ?? []).filter((target) => target.context.kind === "backend");
  const snapshots = await Promise.allSettled(
    targets.map((target) => source.snapshot(target.targetId)),
  );
  const byName = new Map<string, Set<AgentPlatform>>();
  snapshots.forEach((result, index) => {
    if (result.status !== "fulfilled" || !result.value) return;
    const provider = targets[index]!.provider;
    const userSources = new Set(
      result.value.sources
        .filter((entry) => entry.scope === "backend-user")
        .map((entry) => entry.sourceId),
    );
    for (const definition of result.value.definitions) {
      if (!userSources.has(definition.sourceId)) continue;
      if (definition.status === "protected" || !isNativeAgentMcpServerName(definition.name)) {
        continue;
      }
      const providers = byName.get(definition.name) ?? new Set<AgentPlatform>();
      providers.add(provider);
      byName.set(definition.name, providers);
    }
  });
  return [...byName]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, GRAPH_DESIGNER_MCP_SERVERS_MAX)
    .map(([name, providers]) => ({ name, providers: [...providers].sort() }));
}

/** The configured user servers, loaded once per mount of the capabilities form. */
export function useConfiguredUserMcpServers(
  source?: ConfiguredMcpServerSource,
): ConfiguredMcpServers {
  const [servers, setServers] = useState<ConfiguredMcpServers>({ state: "loading" });
  useEffect(() => {
    let live = true;
    loadConfiguredUserMcpServers(source).then(
      (loaded) => {
        if (live) setServers({ state: "ready", servers: loaded });
      },
      () => {
        if (live) setServers({ state: "unavailable" });
      },
    );
    return () => {
      live = false;
    };
  }, [source]);
  return servers;
}
