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
 * - Claude plugins from the approved artifact through Orkestrator's own
 *   Claude marketplace (`provider-adapters/claude-plugins.ts`), run with
 *   this machine's Claude CLI; other providers' plugins are discovered only;
 * - discovery from the existing skill locations, the provider plugin
 *   listings (`discoverAgentPlugins`) and MCP management's catalog.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { McpMutation } from "@orkestrator/protocol/mcp-management";
import {
  capabilityLaunchRequestedEvent,
  capabilityManagementChangedEvent,
} from "@orkestrator/protocol/contract/domains/capabilities";

import { generateGraphSharingKeyPair } from "../graph-template-signing.js";
import { commandExists } from "../shell.js";
import {
  createHostExtensionCommandRunner,
  envWithManagedBinaries,
  resolveAgentBinary,
  resolveManagedBinary,
} from "../commands-agent-support.js";
import type { CommandContext } from "../commands-context.js";
import { discoverAgentPlugins } from "../extension-discovery.js";
import type { McpManagementService } from "../mcp-management/index.js";
import type { McpInstaller } from "./executor.js";
import type { InventoryMcpServer, InventoryPlugin } from "./inventory.js";
import { defaultCapabilityHomes, testCapabilityHomes } from "./native-ownership.js";
import type { CapabilityLink } from "./node-transport.js";
import { ClaudePluginAdapter } from "./provider-adapters/claude-plugins.js";
import { toggleCodexPlugin } from "./provider-adapters/codex-plugins.js";
import { providerCli } from "./provider-adapters/provider-cli.js";
import { CapabilityError } from "./security.js";
import type { ScopedEnvironment } from "./scoped-delivery.js";
import { projectMcpLocationFor } from "./scoped-locations.js";
import { capabilityScopedSources } from "./scoped-sources.js";
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

/**
 * MCP writes through MCP management: never a second editor. Without a scope
 * the backend user's configuration; with an environment scope, that
 * environment's target and the provider's project MCP file in its worktree
 * (`PROJECT_MCP_LOCATIONS`, `project-mcp.ts`), and only that file.
 */
export function mcpManagementInstaller(
  service: () => McpManagementService | undefined,
  scope?: { environmentId: string },
): McpInstaller {
  const backendTarget = async (provider: AgentPlatform) => {
    const mcp = service();
    if (!mcp) return { error: "MCP management is not available on this machine." } as const;
    const list = await mcp.listTargets(scope ? { environmentId: scope.environmentId } : {});
    const target = list.targets.find((entry) =>
      scope
        ? entry.provider === provider &&
          entry.context.kind === "environment" &&
          entry.context.environmentId === scope.environmentId
        : entry.provider === provider && entry.context.kind === "backend",
    );
    if (!target)
      return { error: `No ${provider} MCP configuration is managed on this machine.` } as const;
    if (target.readOnlyReason) return { error: target.readOnlyReason } as const;
    const snapshot = await mcp.snapshot({ targetId: target.targetId });
    return { mcp, target, snapshot } as const;
  };
  /** Where a new server goes: the backend's default source, or the provider's project file. */
  const writeSource = (
    provider: AgentPlatform,
    found: { target: { defaultSourceId: string | null } },
  ): string | null | undefined =>
    scope ? projectMcpLocationFor(provider)?.sourceId : found.target.defaultSourceId;
  return {
    async configured(provider, definition) {
      const found = await backendTarget(provider);
      if ("error" in found || found.snapshot.freshness !== "fresh") return false;
      const entryId = found.snapshot.effective[definition.name];
      return (
        !!entryId &&
        found.mcp.matchesCapabilityConfiguration(found.target.targetId, entryId, definition)
      );
    },
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
      const sourceId = identity?.sourceId ?? writeSource(provider, found);
      const source = snapshot.sources.find((entry) => entry.sourceId === sourceId);
      if (!sourceId || !source || !source.writable) {
        return {
          status: "unsupported",
          reason:
            source?.readOnlyReason ??
            (scope
              ? `${provider} has no writable project MCP file Orkestrator manages in this worktree.`
              : "No writable MCP configuration for this provider."),
        };
      }
      // A project file the provider is set to ignore here would install nothing it loads.
      if (scope && source.trust === "excluded") {
        return {
          status: "unsupported",
          reason: source.trustReason ?? "This provider does not load project MCP servers here.",
        };
      }
      const trustNote =
        scope && source.trust === "unknown" && source.trustReason ? source.trustReason : undefined;
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
          ...(trustNote ? { reason: trustNote } : {}),
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

/** An isolated agent-test profile writes into its own data directory, never the host's homes. */
export function capabilityHomes(context: CommandContext) {
  return context.runtimeFlavor === "agent-test"
    ? testCapabilityHomes(path.join(context.storage.getDataDir(), "capability-test-home"))
    : defaultCapabilityHomes();
}

/** A provider CLI run from this machine's home; the isolated profile's sees only its own home. */
function capabilityProviderCli(context: CommandContext, provider: "claude" | "codex") {
  const isolated = context.runtimeFlavor === "agent-test";
  const homes = () => capabilityHomes(context);
  return providerCli({
    label: provider === "claude" ? "Claude Code" : "Codex",
    binary: () => resolveAgentBinary(context, provider),
    cwd: () => homes().home,
    env: () => ({
      ...envWithManagedBinaries(context),
      ...(isolated
        ? {
            HOME: homes().home,
            CLAUDE_CONFIG_DIR: homes().claudeConfigDir,
            CODEX_HOME: homes().codexHome,
          }
        : {}),
    }),
  });
}

/**
 * `set_capability_plugin_enabled` on this machine. Only Codex has a
 * persisted per-plugin switch Orkestrator edits (`codex-plugins.ts`).
 */
export async function setCapabilityPluginEnabled(
  context: CommandContext,
  args: Record<string, unknown>,
): Promise<{ provider: string; qualifiedId: string; enabled: boolean; changed: boolean }> {
  const { provider, qualifiedId, enabled } = args;
  if (typeof qualifiedId !== "string" || typeof enabled !== "boolean") {
    throw new CapabilityError("invalid-request", "qualifiedId and enabled are required.");
  }
  if (provider !== "codex") {
    throw new CapabilityError(
      "unsupported",
      provider === "claude"
        ? "Claude plugins Orkestrator installs follow their setups; remove one from the setup to switch it off. Plugins you installed yourself are switched in Claude."
        : "Only Codex plugins have a persisted switch Orkestrator can edit.",
    );
  }
  const result = await toggleCodexPlugin(
    { codexHome: capabilityHomes(context).codexHome, cli: capabilityProviderCli(context, "codex") },
    qualifiedId,
    enabled,
  );
  return {
    provider,
    qualifiedId: result.pluginId,
    enabled: result.enabled,
    changed: result.changed,
  };
}

export interface CapabilityNodeAccess {
  selfId(): Promise<string>;
  selfName(): Promise<string>;
  machines(): Promise<Array<{ nodeId: string; name: string; connected: boolean }>>;
  link(nodeId: string): CapabilityLink | null;
  isLeaf(): boolean;
  /** Leaf: an attached command node was in contact recently enough to answer a launch. */
  controllerReachable?(): Promise<boolean>;
  /** Another machine's environments (federation read model), for its worktrees' project setups. */
  remoteEnvironments?(nodeId: string): Promise<ScopedEnvironment[] | null>;
}

/** Builds the service for this backend. */
export function createCapabilityService(
  context: CommandContext,
  nodes: CapabilityNodeAccess,
): CapabilityService {
  const isolated = context.runtimeFlavor === "agent-test";
  const runner = createHostExtensionCommandRunner(context);
  const homes = () => capabilityHomes(context);
  const claudePlugins = new ClaudePluginAdapter({
    homes,
    cli: capabilityProviderCli(context, "claude"),
  });
  return new CapabilityService({
    storage: {
      capabilities: context.storage.capabilities,
      getProject: async (projectId) => {
        const project = await context.storage.getProject(projectId).catch(() => null);
        return project ? { localPath: project.localPath } : null;
      },
    },
    dataDir: context.storage.getDataDir(),
    // Signed team manifests reuse the graph-sharing key pair and trusted keys (item 405).
    signing: {
      installationKey: (create) =>
        create
          ? context.storage.graphTemplates.ensureGraphSharingInstallationKey(() =>
              generateGraphSharingKeyPair(new Date()),
            )
          : (context.storage.graphTemplates.getGraphSharingKeys()?.installation ?? null),
      trusted: () => context.storage.graphTemplates.getGraphSharingKeys()?.trusted ?? [],
    },
    selfId: nodes.selfId,
    selfName: nodes.selfName,
    machines: nodes.machines,
    link: nodes.link,
    isAuthority: () => !nodes.isLeaf(),
    emit: (event) => context.emit(capabilityManagementChangedEvent, event),
    // A leaf asks its command node to resolve a launch on its own event stream.
    requestLaunch: (payload) => context.emit(capabilityLaunchRequestedEvent, payload),
    ...(nodes.controllerReachable ? { controllerReachable: nodes.controllerReachable } : {}),
    ...(nodes.remoteEnvironments ? { remoteEnvironments: nodes.remoteEnvironments } : {}),
    homes,
    inventory: {
      managedPlugins: () => claudePlugins.observe(),
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
    scoped: {
      ...capabilityScopedSources(context),
      // A project setup's MCP servers, into each worktree's project MCP file.
      projectMcp: (environmentId) =>
        mcpManagementInstaller(() => context.mcpManagement, { environmentId }),
    },
    claudePlugins,
  });
}
