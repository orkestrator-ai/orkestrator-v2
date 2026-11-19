/**
 * Agent Capabilities on this backend: builds `CapabilityService` from the
 * backend's context (docs/architecture/agent-capabilities-management.md).
 *
 * The provider adapters it composes:
 *
 * - file components (skills, commands, prompts, subagents) through the
 *   executor's location writer, for all six providers, with the shared
 *   location table deciding which providers each copy reaches;
 * - MCP servers through this machine's `McpManagementService`, the same
 *   revisions, locks and validation the MCP servers settings use;
 * - Claude marketplace plugins through `claude plugin install|uninstall`;
 * - discovery from the existing skill locations, the provider plugin
 *   listings (`discoverAgentPlugins`) and MCP management's catalog.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { McpMutation } from "@orkestrator/protocol/mcp-management";
import { capabilityManagementChangedEvent } from "@orkestrator/protocol/contract/domains/capabilities";

import { commandExists } from "../shell.js";
import {
  createHostExtensionCommandRunner,
  resolveManagedBinary,
} from "../commands-agent-support.js";
import type { CommandContext } from "../commands-context.js";
import { discoverAgentPlugins } from "../extension-discovery.js";
import type { McpManagementService } from "../mcp-management/index.js";
import type { McpInstaller } from "./executor.js";
import type { InventoryMcpServer, InventoryPlugin } from "./inventory.js";
import { defaultCapabilityHomes, testCapabilityHomes } from "./native-ownership.js";
import type { CapabilityLink } from "./node-transport.js";
import { CapabilityService } from "./service.js";

export { CapabilityService } from "./service.js";
export { CapabilityError } from "./security.js";

const PROVIDER_BINARIES: Record<AgentPlatform, string | null> = {
  claude: "claude",
  codex: "codex",
  cursor: null,
  grok: "grok",
  opencode: "opencode2",
  pi: "pi",
};

function mcpRequestId(key: string): string {
  return `cap-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

/** MCP writes through MCP management: never a second editor. */
export function mcpManagementInstaller(
  service: () => McpManagementService | undefined,
): McpInstaller {
  const backendTarget = async (provider: AgentPlatform) => {
    const mcp = service();
    if (!mcp) return { error: "MCP management is not available on this machine." } as const;
    const list = await mcp.listTargets({});
    const target = list.targets.find(
      (entry) => entry.provider === provider && entry.context.kind === "backend",
    );
    if (!target)
      return { error: `No ${provider} MCP configuration is managed on this machine.` } as const;
    if (target.readOnlyReason) return { error: target.readOnlyReason } as const;
    const snapshot = await mcp.snapshot({ targetId: target.targetId });
    return { mcp, target, snapshot } as const;
  };
  return {
    async install({ provider, name, definition, requestId }) {
      const found = await backendTarget(provider);
      if ("error" in found) return { status: "unsupported", reason: found.error };
      const { mcp, target, snapshot } = found;
      const existing = snapshot.definitions.find((entry) => entry.name === name);
      if (existing) {
        return {
          status: "drifted",
          reason: `${name} is already configured for ${provider}; adopt or remove it in MCP servers settings. It was left untouched.`,
        };
      }
      const sourceId = target.defaultSourceId;
      const source = snapshot.sources.find((entry) => entry.sourceId === sourceId);
      if (!sourceId || !source || !source.writable) {
        return {
          status: "unsupported",
          reason: source?.readOnlyReason ?? "No writable MCP configuration for this provider.",
        };
      }
      const mutation: McpMutation = {
        requestId: mcpRequestId(requestId),
        targetId: target.targetId,
        applyIntent: "save",
        operation: {
          kind: "add",
          sourceId,
          expectedRevision: source.revision,
          definition: {
            name,
            transport: definition.transport,
            ...(definition.command ? { command: definition.command } : {}),
            ...(definition.args ? { args: definition.args } : {}),
            ...(definition.url ? { url: definition.url } : {}),
            enabled: true,
          },
        },
      };
      try {
        await mcp.mutate({ mutation });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "MCP management refused the change.";
        return { status: "failed", reason: message.slice(0, 400) };
      }
      return { status: "installed-next-session" };
    },
    async remove({ provider, name, requestId }) {
      const found = await backendTarget(provider);
      if ("error" in found) return { status: "unsupported", reason: found.error };
      const { mcp, target, snapshot } = found;
      const existing = snapshot.definitions.find(
        (entry) => entry.name === name && entry.sourceId === target.defaultSourceId,
      );
      if (!existing) return { status: "ready" };
      const source = snapshot.sources.find((entry) => entry.sourceId === existing.sourceId);
      if (!source?.revision)
        return { status: "failed", reason: "The MCP configuration could not be read." };
      try {
        await mcp.mutate({
          mutation: {
            requestId: mcpRequestId(`${requestId}:remove`),
            targetId: target.targetId,
            applyIntent: "save",
            operation: {
              kind: "remove",
              entryId: existing.entryId,
              expectedRevision: source.revision,
            },
          },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "MCP management refused the change.";
        return { status: "failed", reason: message.slice(0, 400) };
      }
      return { status: "ready" };
    },
  };
}

export interface CapabilityNodeAccess {
  selfId(): Promise<string>;
  selfName(): Promise<string>;
  machines(): Promise<Array<{ nodeId: string; name: string; connected: boolean }>>;
  link(nodeId: string): CapabilityLink | null;
  isLeaf(): boolean;
}

/** Builds the service for this backend. */
export function createCapabilityService(
  context: CommandContext,
  nodes: CapabilityNodeAccess,
): CapabilityService {
  const isolated = context.runtimeFlavor === "agent-test";
  const runner = createHostExtensionCommandRunner(context);
  return new CapabilityService({
    storage: {
      capabilities: context.storage.capabilities,
      getProject: async (projectId) => {
        const project = await context.storage.getProject(projectId).catch(() => null);
        return project ? { localPath: project.localPath } : null;
      },
    },
    dataDir: context.storage.getDataDir(),
    selfId: nodes.selfId,
    selfName: nodes.selfName,
    machines: nodes.machines,
    link: nodes.link,
    isAuthority: () => !nodes.isLeaf(),
    emit: (event) => context.emit(capabilityManagementChangedEvent, event),
    // An isolated agent-test profile writes into its own data directory, never the host's homes.
    homes: () =>
      isolated
        ? testCapabilityHomes(path.join(context.storage.getDataDir(), "capability-test-home"))
        : defaultCapabilityHomes(),
    inventory: {
      providers: async () =>
        Promise.all(
          AGENT_PLATFORMS.map(async (provider) => {
            const binary = PROVIDER_BINARIES[provider];
            // Cursor runs from its bundled SDK bridge; there is no CLI to find.
            if (!binary) return { provider, available: true };
            const managed = Boolean(resolveManagedBinary(context, binary));
            return { provider, available: managed || (!isolated && (await commandExists(binary))) };
          }),
        ),
      // An isolated agent-test profile must not read the host's provider homes.
      ...(isolated
        ? {}
        : {
            plugins: async (): Promise<InventoryPlugin[]> => {
              const lists = await Promise.allSettled(
                (["claude", "codex", "grok", "opencode", "pi"] as const).map((provider) =>
                  discoverAgentPlugins(provider, runner),
                ),
              );
              return lists.flatMap((result) =>
                result.status === "fulfilled"
                  ? result.value.plugins.map((plugin) => ({
                      provider: result.value.agent,
                      qualifiedId: plugin.qualifiedId ?? plugin.name,
                      name: plugin.name,
                      enabled:
                        plugin.status === "disabled"
                          ? false
                          : plugin.status === "configured"
                            ? true
                            : null,
                    }))
                  : [],
              );
            },
            mcpServers: async (): Promise<InventoryMcpServer[]> => {
              const mcp = context.mcpManagement;
              if (!mcp) return [];
              const list = await mcp.listTargets({});
              const servers: InventoryMcpServer[] = [];
              for (const target of list.targets.filter(
                (entry) => entry.context.kind === "backend",
              )) {
                const snapshot = await mcp
                  .snapshot({ targetId: target.targetId })
                  .catch(() => null);
                for (const definition of snapshot?.definitions ?? []) {
                  const source = snapshot?.sources.find(
                    (entry) => entry.sourceId === definition.sourceId,
                  );
                  servers.push({
                    provider: target.provider,
                    name: definition.name,
                    enabled: definition.enabled,
                    sourceLabel: source?.label ?? "MCP configuration",
                  });
                }
              }
              return servers;
            },
          }),
    },
    mcp: mcpManagementInstaller(() => context.mcpManagement),
    ...(isolated ? {} : { pluginCli: (provider, args) => runner(provider, args) }),
  });
}
