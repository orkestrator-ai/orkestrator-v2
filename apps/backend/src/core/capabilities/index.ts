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
 * - marketplace plugin discovery without managed native writes;
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
    async observe(ownership) {
      const found = await backendTarget(ownership.provider);
      if ("error" in found || found.snapshot.freshness !== "fresh") return "unavailable";
      const existing = found.snapshot.definitions.find(
        (entry) => entry.name === ownership.name && entry.sourceId === ownership.sourceId,
      );
      if (!existing) return "missing";
      const identity = await found.mcp.capabilityEntryIdentity(
        found.target.targetId,
        existing.entryId,
      );
      return identity?.fingerprint === ownership.fingerprint ? "present" : "drifted";
    },
    async install({ provider, name, definition, requestId, previous, force }) {
      const found = await backendTarget(provider);
      if ("error" in found) return { status: "unsupported", reason: found.error };
      const { mcp, target, snapshot } = found;
      if (snapshot.freshness !== "fresh")
        return { status: "failed", reason: "The MCP configuration could not be read completely." };
      const existing = snapshot.definitions.find((entry) => entry.name === name);
      const identity = existing
        ? await mcp.capabilityEntryIdentity(target.targetId, existing.entryId)
        : null;
      if (
        existing &&
        (!identity ||
          !previous ||
          identity.sourceId !== previous.sourceId ||
          (!force && identity.fingerprint !== previous.fingerprint))
      ) {
        return {
          status: "drifted",
          reason: "A local MCP definition already uses this name and was left untouched.",
        };
      }
      const sourceId = identity?.sourceId ?? target.defaultSourceId;
      const source = snapshot.sources.find((entry) => entry.sourceId === sourceId);
      if (!sourceId || !source || !source.writable) {
        return {
          status: "unsupported",
          reason: source?.readOnlyReason ?? "No writable MCP configuration for this provider.",
        };
      }
      const mutation: McpMutation = {
        requestId: mcpRequestId(`${requestId}:${source.revision}:${force === true}`),
        targetId: target.targetId,
        applyIntent: "save",
        operation:
          existing && identity
            ? {
                kind: "update",
                entryId: existing.entryId,
                expectedRevision: identity.revision,
                patch: {
                  ...(existing.transport !== definition.transport
                    ? {
                        transport: {
                          to: definition.transport,
                          discard: ["command", "args", "cwd", "env", "url", "headers"],
                        },
                      }
                    : {}),
                  ...(definition.command
                    ? { command: { kind: "set", value: definition.command } }
                    : {}),
                  ...(definition.transport === "stdio"
                    ? { args: (definition.args ?? []).map((value) => ({ kind: "set", value })) }
                    : {}),
                  ...(definition.url ? { url: { kind: "set", value: definition.url } } : {}),
                },
              }
            : {
                kind: "add",
                sourceId,
                expectedRevision: source.revision,
                definition: { name, ...definition, enabled: true },
              },
      };
      try {
        const saved = await mcp.mutate({ mutation });
        const identity =
          saved.entryId && (await mcp.capabilityEntryIdentity(target.targetId, saved.entryId));
        if (!identity || identity.revision !== saved.savedRevision) {
          return {
            status: "drifted",
            reason: "The saved MCP definition changed before ownership could be recorded.",
          };
        }
        return {
          status: "installed-next-session",
          ownership: {
            sourceId: identity.sourceId,
            fingerprint: identity.fingerprint,
            provider,
            name,
          },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "MCP management refused the change.";
        return { status: "failed", reason: message.slice(0, 400) };
      }
    },
    async remove({ provider, name, requestId, previous }) {
      const found = await backendTarget(provider);
      if ("error" in found) return { status: "unsupported", reason: found.error };
      const { mcp, target, snapshot } = found;
      if (snapshot.freshness !== "fresh")
        return { status: "failed", reason: "The MCP configuration could not be read completely." };
      const existing = snapshot.definitions.find(
        (entry) => entry.name === name && entry.sourceId === previous.sourceId,
      );
      if (!existing) return { status: "ready" };
      const identity = await mcp.capabilityEntryIdentity(target.targetId, existing.entryId);
      if (
        !identity ||
        identity.sourceId !== previous.sourceId ||
        identity.fingerprint !== previous.fingerprint
      ) {
        return {
          status: "drifted",
          reason: "The locally changed MCP definition was left untouched.",
        };
      }
      try {
        await mcp.mutate({
          mutation: {
            requestId: mcpRequestId(`${requestId}:remove:${identity.revision}`),
            targetId: target.targetId,
            applyIntent: "save",
            operation: {
              kind: "remove",
              entryId: existing.entryId,
              expectedRevision: identity.revision,
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
  });
}
