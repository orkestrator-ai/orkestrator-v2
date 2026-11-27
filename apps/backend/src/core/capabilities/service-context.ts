/**
 * What `CapabilityService` (service.ts) hands its collaborators
 * (docs/architecture/agent-capabilities-management.md): the service's
 * dependencies, the parts it builds once (artifact cache, executor,
 * reconciler, environment delivery, drift, registries, leaf launches) and the
 * few service-level helpers every command uses. Each collaborator
 * (`library-reads.ts`, `change-commands.ts`, `setup-commands.ts`, ...) takes
 * this context; none extends another.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { CapabilitySessionEvidenceRead } from "@orkestrator/protocol/capability-evidence";
import type { EffectiveAgentResources } from "@orkestrator/protocol/capability-resources";
import type { CapabilityInventory } from "@orkestrator/protocol/capability-resources-api";

import type { CapabilitiesStorage } from "../storage/index.js";
import type { CapabilityArtifactStore } from "./artifact-store.js";
import type { CapabilityDriftWorkflow } from "./drift.js";
import type { CapabilityExecutor, McpInstaller } from "./executor.js";
import type { InventorySources } from "./inventory.js";
import type { LeafLaunchAuthority } from "./launch-authority.js";
import type { ManifestSigningKeys } from "./manifest-signing.js";
import type { CapabilityHomes } from "./native-ownership.js";
import type { CapabilityLink } from "./node-transport.js";
import type { ProviderCli } from "./provider-adapters/provider-cli.js";
import type { CapabilityReconciler } from "./reconciler.js";
import type { RegistryFetch } from "./registry.js";
import type { CapabilityRegistryCommands } from "./registry-settings.js";
import type { CapabilityResolveInput } from "./resolution.js";
import type {
  ScopedCapabilityDelivery,
  ScopedEnvironment,
  ScopedTargetSources,
} from "./scoped-delivery.js";
import type { RemoteScopedDelivery } from "./scoped-remote.js";
import type { GitFetchOptions } from "./source-inspection.js";
import type { CapabilityState } from "./types.js";
import type { MachineFact } from "./views.js";

/** How a read of this machine's inventory treats the provider CLIs' plugin listings. */
export interface InventoryReadOptions {
  /**
   * Launch evidence only: skips unmanaged listings and checks only the
   * managed Claude components explicitly requested.
   */
  launch?: boolean;
  /** Managed Claude component IDs needed for a launch-evidence read. */
  managedPluginComponents?: readonly string[];
  /** Pending leaf launch whose proof is being read by its command node. */
  launchRequestId?: string;
  /** Local token shared by the fenced observation and recheck of one leaf launch. */
  pluginListingScope?: object;
  /** List the plugins again rather than use a recent listing. */
  refresh?: boolean;
}

export interface CapabilityServiceDeps {
  storage: {
    capabilities: CapabilitiesStorage;
    getProject?(projectId: string): Promise<{ localPath: string | null } | null>;
  };
  dataDir: string;
  selfId(): Promise<string>;
  selfName(): Promise<string>;
  /** Other machines this node controls. */
  machines(): Promise<Array<{ nodeId: string; name: string; connected: boolean }>>;
  link(nodeId: string): CapabilityLink | null;
  /** False on a leaf: its command node holds the authority. */
  isAuthority(): boolean;
  /** Leaf: emits `node-capability-launch-requested` for the command node to answer. */
  requestLaunch?(payload: { requestId: string; request: unknown }): void;
  /** Leaf: an attached command node was in contact recently enough to answer a launch. */
  controllerReachable?(): Promise<boolean>;
  emit(event: {
    revision: number;
    packageIds: string[];
    setupIds: string[];
    operationIds: string[];
  }): void;
  homes(): CapabilityHomes;
  inventory: Omit<InventorySources, "homes">;
  claudeInventory?: ReturnType<
    typeof import("./inventory-plugins.js").createClaudeInventoryPluginSource
  >;
  mcp?: McpInstaller;
  claudePlugins?: ExecutorClaudePlugins;
  gitRun?: GitFetchOptions["run"];
  /** This installation's graph-sharing keys, for signed manifests (`manifest-signing.ts`). */
  signing?: ManifestSigningKeys;
  /** Registry index and tarball fetches (`registry.ts`); the global fetch when absent. */
  registryFetch?: RegistryFetch;
  /** This machine's worktrees, added accounts and containers (`scoped-delivery.ts`). */
  scoped?: ScopedTargetSources;
  /** Another machine's environments, from the federation read model (`scoped-remote.ts`). */
  remoteEnvironments?(nodeId: string): Promise<ScopedEnvironment[] | null>;
  /**
   * Runtime proof (`runtime-proof.ts`): a running session's own report of
   * what it loaded and invoked, read without touching the session.
   */
  sessionAccountHome?(
    target: import("@orkestrator/protocol/capability-resources").CapabilityTarget,
  ): Promise<string | undefined>;
  sessionEvidence?(input: {
    environmentId: string;
    provider: AgentPlatform;
    sessionKey: string;
  }): Promise<CapabilitySessionEvidenceRead>;
  /** A provider CLI run on this machine, for discovery listings (Grok's `inspect`). */
  providerCli?(provider: "grok"): ProviderCli | null;
  /**
   * Providers with work in flight on this machine (`running-work.ts`): shared
   * provider-home writes they read wait until it ends.
   */
  busyProviders?(): Promise<AgentPlatform[]>;
  now?: () => string;
}

export type ExecutorClaudePlugins = NonNullable<
  ConstructorParameters<typeof CapabilityExecutor>[0]["claudePlugins"]
>;

/** The ids a change touched, for the `capability-management-changed` event. */
export interface CapabilityChangeNotice {
  packageIds: string[];
  setupIds: string[];
  operationIds: string[];
}

export interface CapabilityServiceContext {
  /** The service's dependencies; `isAuthority()` is false once this node handed over. */
  deps: CapabilityServiceDeps;
  artifacts: CapabilityArtifactStore;
  executor: CapabilityExecutor;
  reconciler: CapabilityReconciler;
  scoped: ScopedCapabilityDelivery;
  remoteScoped: RemoteScopedDelivery;
  drift: CapabilityDriftWorkflow;
  registries: CapabilityRegistryCommands;
  leafLaunch: LeafLaunchAuthority;
  now(): string;
  /** Emits the change event with the store's current revision. */
  announce(change: CapabilityChangeNotice): Promise<void>;
  /** Throws on a leaf (or a node that handed its authority over). */
  assertAuthority(): void;
  /** This machine first, then the machines it controls. */
  machineFacts(): Promise<MachineFact[]>;
  observeSelf(options?: InventoryReadOptions): Promise<CapabilityInventory>;
  /** A machine's live inventory: this one directly, another over its node link. */
  observeNode(nodeId: string, options?: InventoryReadOptions): Promise<CapabilityInventory>;
  resolveFor(state: CapabilityState, input: CapabilityResolveInput): EffectiveAgentResources;
}
