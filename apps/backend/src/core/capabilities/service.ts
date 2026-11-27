/**
 * The Agent Capabilities manager on this backend
 * (docs/architecture/agent-capabilities-management.md).
 *
 * The command node holds the authority: the library, setups, assignments,
 * operations and receipts in its SQLite store, and the artifact cache. Every
 * machine (this one included) is an executor that reports its inventory and
 * applies plans. A leaf keeps whatever it last applied while its command node
 * is away, and refuses plans from an older authority (the epoch).
 *
 * Every mutation is validated here; arguments are opaque ids, never host
 * paths. Previews write only the operation record; apply needs the exact
 * plan digest the user approved.
 *
 * This class wires the parts together and owns the authority; each group of
 * commands is a collaborator given a `CapabilityServiceContext`
 * (`service-context.ts`): reads (`library-reads.ts`), inspection
 * (`inspection-commands.ts`), changes (`change-commands.ts`), setups
 * (`setup-commands.ts`), updates (`update-commands.ts`), import and export
 * (`import-commands.ts`), verification and launch preflight (`preflight.ts`)
 * and the executor commands (`executor-handlers.ts`).
 */
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CapabilitySetup,
  CapabilityTarget,
  EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityActivityList,
  CapabilityChangeResult,
  CapabilityDriftList,
  CapabilityDriftMerge,
  CapabilityExport,
  CapabilityImportPreview,
  CapabilityInventory,
  CapabilityLibrary,
  CapabilityMachineList,
  CapabilityOperationList,
  CapabilitySessionView,
  CapabilitySetupList,
  CapabilitySourceInspection,
  CapabilityTargetSupportResult,
  CapabilityUpdateList,
  CapabilityVerification,
} from "@orkestrator/protocol/capability-resources-api";
import {
  UNRESTRICTED_CAPABILITY_CEILING,
  type CapabilityPermissionCeiling,
} from "@orkestrator/protocol/capability-resources-resolve";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { nativeAgentDeniedCapabilities } from "@orkestrator/protocol/native-agent";

import { CapabilityAdminPolicyCommands } from "./admin-policy.js";
import { CapabilityArtifactStore } from "./artifact-store.js";
import { CapabilityChangeCommands } from "./change-commands.js";
import { CapabilityDriftWorkflow } from "./drift.js";
import {
  containerStaging,
  environmentDeliveryView,
  type EnvironmentDeliveryContext,
} from "./environment-delivery.js";
import { CapabilityExecutor } from "./executor.js";
import { CapabilityExecutorHandlers } from "./executor-handlers.js";
import {
  abandonCapabilityHandover,
  CapabilityHandoverReceiver,
  completeCapabilityHandover,
  handedOverAuthority,
  sendCapabilityHandover,
  type HandoverInvoke,
} from "./handover.js";
import { CapabilityImportCommands } from "./import-commands.js";
import { CapabilityInspectionCommands } from "./inspection-commands.js";
import { collectCapabilityInventory, type InventorySources } from "./inventory.js";
import { InventoryPluginCache } from "./inventory-cache.js";
import { answerLeafLaunch, LeafLaunchAuthority } from "./launch-authority.js";
import { CapabilityLibraryReads } from "./library-reads.js";
import { remoteTransport, routedTransport } from "./node-transport.js";
import { CapabilityPreflight } from "./preflight.js";
import { CapabilityReconciler, localTransport } from "./reconciler.js";
import { CapabilityRegistryCommands } from "./registry-settings.js";
import { resolveCapabilityTarget, type CapabilityResolveInput } from "./resolution.js";
import { ScopedCapabilityDelivery } from "./scoped-delivery.js";
import { RemoteScopedDelivery } from "./scoped-remote.js";
import { CapabilityError, type PackageFile } from "./security.js";
import { asText } from "./service-args.js";
import type {
  CapabilityChangeNotice,
  CapabilityServiceContext,
  CapabilityServiceDeps,
  InventoryReadOptions,
} from "./service-context.js";
import { CapabilitySetupCommands } from "./setup-commands.js";
import type { CapabilityState } from "./types.js";
import { CapabilityUpdateCommands } from "./update-commands.js";
import type { MachineFact } from "./views.js";

export type { CapabilityServiceDeps, InventoryReadOptions } from "./service-context.js";

const log = createLogger("capabilities");

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export class CapabilityService {
  readonly artifacts: CapabilityArtifactStore;
  readonly executor: CapabilityExecutor;
  readonly reconciler: CapabilityReconciler;
  readonly scoped: ScopedCapabilityDelivery;
  /** Project setups in worktrees on other machines (`scoped-remote.ts`). */
  readonly remoteScoped: RemoteScopedDelivery;
  /** Local changes: keep, replace, adopt and merge; adopting installed items (`drift.ts`). */
  readonly drift: CapabilityDriftWorkflow;
  /** Package registries and the signed-manifest policy (`registry-settings.ts`). */
  readonly registries: CapabilityRegistryCommands;
  /** Administrator policy: forbidden sources and components (`admin-policy.ts`). */
  readonly adminPolicy: CapabilityAdminPolicyCommands;
  /** Command-node handover, receiving side (`handover.ts`). */
  readonly handoverReceiver: CapabilityHandoverReceiver;
  /** Leaf launch preflight answered by the command node (`launch-authority.ts`). */
  readonly leafLaunch: LeafLaunchAuthority;
  private readonly reads: CapabilityLibraryReads;
  private readonly inspection: CapabilityInspectionCommands;
  private readonly imports: CapabilityImportCommands;
  private readonly changes: CapabilityChangeCommands;
  private readonly setups: CapabilitySetupCommands;
  private readonly updates: CapabilityUpdateCommands;
  private readonly preflight: CapabilityPreflight;
  private readonly executorHandlers: CapabilityExecutorHandlers;
  /** The provider CLIs' plugin listings, shared and briefly kept (`inventory-cache.ts`). */
  private readonly pluginListing: InventoryPluginCache | undefined;
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  /** This node handed (or is handing) its authority to another command node. */
  private handedOver = false;

  constructor(private readonly deps: CapabilityServiceDeps) {
    // A node that handed its state over is no longer the authority, even before it becomes a leaf.
    const nodeAuthority = deps.isAuthority;
    this.deps = { ...deps, isAuthority: () => nodeAuthority() && !this.handedOver };
    this.artifacts = new CapabilityArtifactStore(deps.dataDir);
    const listPlugins = deps.inventory.plugins;
    this.pluginListing = listPlugins ? new InventoryPluginCache(() => listPlugins()) : undefined;
    this.drift = new CapabilityDriftWorkflow({
      storage: deps.storage,
      artifacts: this.artifacts,
      homes: () => this.deps.homes(),
      selfId: () => this.deps.selfId(),
      link: (nodeId) => this.deps.link(nodeId),
      now: () => this.now(),
      assertAuthority: () => this.assertAuthority(),
      observeNode: (nodeId) => this.observeNode(nodeId),
      storeInspection: (inspected, requestKey, adoption) =>
        this.inspection.store(inspected, requestKey, adoption),
      previewChange: (change, actor) => this.changes.previewParsed(change, undefined, actor),
      announce: (change) => void this.announce(change),
      reconcileNode: (nodeId, reason) => void this.reconciler.reconcileNode(nodeId, reason),
    });
    this.registries = new CapabilityRegistryCommands({
      storage: deps.storage.capabilities,
      ...(deps.signing ? { signing: deps.signing } : {}),
      ...(deps.registryFetch ? { fetch: deps.registryFetch } : {}),
      ...(deps.gitRun ? { gitRun: deps.gitRun } : {}),
      dataDir: deps.dataDir,
      now: () => this.now(),
      assertAuthority: () => this.assertAuthority(),
      announce: () => void this.announce({ packageIds: [], setupIds: [], operationIds: [] }),
    });
    this.adminPolicy = new CapabilityAdminPolicyCommands({
      storage: deps.storage.capabilities,
      now: () => this.now(),
      assertAuthority: () => this.assertAuthority(),
      announce: (packageIds) => void this.announce({ packageIds, setupIds: [], operationIds: [] }),
      reconcileAll: (reason) => void this.reconciler.reconcileAll(reason),
    });
    this.executor = new CapabilityExecutor({
      storage: deps.storage,
      artifacts: this.artifacts,
      homes: deps.homes,
      ...(deps.busyProviders ? { busyProviders: deps.busyProviders } : {}),
      ...(deps.mcp ? { mcp: deps.mcp } : {}),
      ...(deps.claudePlugins ? { claudePlugins: deps.claudePlugins } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      // A write to this machine's homes changes what its inventory reports.
      afterWrite: () => this.invalidateInventory(),
    });
    const local = localTransport({
      selfId: deps.selfId,
      observe: () => this.observeSelf(),
      executor: this.executor,
      artifacts: this.artifacts,
    });
    const remote = remoteTransport({
      selfId: deps.selfId,
      link: deps.link,
      artifacts: this.artifacts,
    });
    const transport = routedTransport({ selfId: deps.selfId, local: { ...local }, remote });
    this.scoped = new ScopedCapabilityDelivery({
      ...deps.scoped,
      storage: deps.storage,
      artifacts: this.artifacts,
      selfId: deps.selfId,
      homes: () => this.deps.homes(),
      resolve: (state, target) =>
        this.resolveFor(state, { target, ceiling: UNRESTRICTED_CAPABILITY_CEILING }),
      changed: () => void this.announce({ packageIds: [], setupIds: [], operationIds: [] }),
      now: () => this.now(),
    });
    this.remoteScoped = new RemoteScopedDelivery({
      ...deps.scoped,
      storage: deps.storage,
      artifacts: this.artifacts,
      homes: () => this.deps.homes(),
      selfId: deps.selfId,
      resolve: (state, target) =>
        this.resolveFor(state, { target, ceiling: UNRESTRICTED_CAPABILITY_CEILING }),
      link: deps.link,
      ...(deps.remoteEnvironments ? { remoteEnvironments: deps.remoteEnvironments } : {}),
      stage: (nodeId, epoch, digest) => remote.stage(nodeId, epoch, digest),
      noteNames: (names) => this.scoped.noteRemoteNames(names),
      changed: () => void this.announce({ packageIds: [], setupIds: [], operationIds: [] }),
      now: () => this.now(),
    });
    this.reconciler = new CapabilityReconciler({
      storage: deps.storage,
      artifacts: this.artifacts,
      selfId: deps.selfId,
      afterSelfPass: () => this.scoped.runAll(),
      afterNodePass: (nodeId) => this.remoteScoped.deliverNode(nodeId),
      machines: deps.machines,
      transport,
      isAuthority: () => this.deps.isAuthority(),
      emit: (change) => void this.announce(change),
      nodeName: async (nodeId) =>
        (await this.machineFacts()).find((machine) => machine.nodeId === nodeId)?.name ?? nodeId,
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.handoverReceiver = new CapabilityHandoverReceiver({
      storage: deps.storage,
      artifacts: this.artifacts,
      dataDir: deps.dataDir,
      selfId: deps.selfId,
      admitEpoch: (controllerId, epoch) => this.executor.admitEpoch(controllerId, epoch),
      now: () => this.now(),
    });
    this.leafLaunch = new LeafLaunchAuthority({
      storage: deps.storage,
      observeSelf: (managedPluginComponents, pluginListingScope) =>
        this.observeSelf({ launch: true, managedPluginComponents, pluginListingScope }),
      managedPluginComponents: async () => {
        const index = await deps.claudePlugins?.readIndex();
        return Object.values(index?.plugins ?? {}).map((plugin) => plugin.componentId);
      },
      admitEpoch: (controllerId, epoch) => this.executor.admitEpoch(controllerId, epoch),
      controllerReachable: async () => (await this.deps.controllerReachable?.()) ?? false,
      ...(deps.requestLaunch ? { request: deps.requestLaunch } : {}),
      scopedReport: async (target, relativeWorktree) => {
        const [report, account] = await Promise.all([
          this.remoteScoped.leafReport(target, relativeWorktree),
          this.scoped.leafAccountReport(target),
        ]);
        return account ? { ...report, account } : report;
      },
      stageWorktree: (request, targets, controllerId, epoch) =>
        request.relativeWorktree
          ? this.scoped.stageIsolatedWorktree(
              request.target,
              request.relativeWorktree,
              targets,
              () => this.executor.assertEpoch(controllerId, epoch),
            )
          : Promise.resolve([]),
      now: () => this.now(),
    });
    const context: CapabilityServiceContext = {
      deps: this.deps,
      artifacts: this.artifacts,
      executor: this.executor,
      reconciler: this.reconciler,
      scoped: this.scoped,
      remoteScoped: this.remoteScoped,
      drift: this.drift,
      registries: this.registries,
      leafLaunch: this.leafLaunch,
      now: () => this.now(),
      announce: (change) => this.announce(change),
      assertAuthority: () => this.assertAuthority(),
      machineFacts: () => this.machineFacts(),
      observeSelf: (options) => this.observeSelf(options),
      observeNode: (nodeId, options) => this.observeNode(nodeId, options),
      resolveFor: (state, input) => this.resolveFor(state, input),
    };
    this.reads = new CapabilityLibraryReads(context);
    this.inspection = new CapabilityInspectionCommands(context);
    this.imports = new CapabilityImportCommands(context, this.reads);
    this.changes = new CapabilityChangeCommands(context, this.imports);
    this.setups = new CapabilitySetupCommands(context, this.reads);
    this.updates = new CapabilityUpdateCommands(context, this.reads, this.changes);
    this.preflight = new CapabilityPreflight(context);
    this.executorHandlers = new CapabilityExecutorHandlers(context, this.preflight);
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  /** Makes sure this machine has a record, then starts reconciliation and update checks. */
  async init(): Promise<void> {
    const selfId = await this.deps.selfId();
    await this.refreshAuthority();
    this.deps.storage.capabilities.mutateCapabilityState((state) => {
      if (state.machines[selfId]) return { result: undefined, changed: false };
      state.machines[selfId] = { nodeId: selfId, enrolled: true, groups: [] };
      state.controllerId = selfId;
      return { result: undefined, changed: true };
    });
  }

  start(): void {
    if (this.disposed) return;
    this.reconciler.start();
    const pruneStaged = () =>
      void this.artifacts
        .pruneStaged()
        .catch((error: unknown) =>
          log.warn("updates.check-failed", { error: formatLogError(error, { message: false }) }),
        );
    const prunePrivate = () =>
      void this.preflight.prunePrivatePlugins().catch((error: unknown) =>
        log.warn("service.launch-record-failed", {
          error: formatLogError(error, { message: false }),
        }),
      );
    if (!this.updateTimer) {
      pruneStaged();
      prunePrivate();
      this.updateTimer = setInterval(() => {
        pruneStaged();
        prunePrivate();
        void this.refreshUpdates({}).catch((error: unknown) =>
          log.warn("updates.check-failed", { error: formatLogError(error, { message: false }) }),
        );
      }, UPDATE_CHECK_INTERVAL_MS);
      this.updateTimer.unref?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.reconciler.dispose();
    if (this.updateTimer) clearInterval(this.updateTimer);
    this.updateTimer = null;
  }

  /** A machine connected or reconnected: deliver the latest desired state. */
  noteNodeConnected(nodeId: string): void {
    void this.reconciler.reconcileNode(nodeId, "connected");
  }

  private async announce(change: CapabilityChangeNotice) {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    this.deps.emit({ revision: state.revision, ...change });
  }

  private assertAuthority(): void {
    if (!this.deps.isAuthority()) {
      throw new CapabilityError(
        "conflict",
        "This machine follows a command node; manage capabilities from the command node.",
      );
    }
  }

  private async machineFacts(): Promise<MachineFact[]> {
    const selfId = await this.deps.selfId();
    const selfName = await this.deps.selfName().catch(() => "This computer");
    const others = await this.deps.machines().catch(() => []);
    return [
      { nodeId: selfId, name: selfName, connected: true, self: true },
      ...others
        .filter((machine) => machine.nodeId !== selfId)
        .map((machine) => ({ ...machine, self: false })),
    ];
  }

  /**
   * Something on this machine changed what its inventory reports (a
   * capability write, an MCP change, a plugin switch): the next read lists
   * the provider plugins again rather than serve a listing from before it.
   */
  invalidateInventory(): void {
    this.pluginListing?.invalidate();
    this.deps.claudeInventory?.invalidate();
  }

  /**
   * This machine's inventory. Files, MCP configuration and managed plugin
   * bytes are read live. Discovery uses the shared provider cache. Launch
   * reads request a fresh listing only for selected managed Claude plugins.
   */
  async observeSelf(options: InventoryReadOptions = {}): Promise<CapabilityInventory> {
    const selfId = await this.deps.selfId();
    const sources: InventorySources = { ...this.deps.inventory, homes: this.deps.homes() };
    const claude = this.deps.claudeInventory?.read(options);
    sources.managedPlugins =
      claude?.managedPlugins ??
      (!options.launch || options.managedPluginComponents?.length
        ? sources.managedPlugins
        : undefined);
    const pluginListing = options.launch
      ? undefined
      : this.pluginListing
          ?.read({ refresh: options.refresh })
          .catch(() => ({ plugins: [], errors: [{ message: "Could not list native plugins." }] }));
    const listClaude = claude?.plugins;
    sources.plugins =
      pluginListing || listClaude
        ? async () => {
            const [otherListing, claudeListing] = await Promise.all([
              pluginListing,
              listClaude?.().catch(() => ({
                plugins: [],
                errors: [{ message: "Claude's plugin list could not be read." }],
              })),
            ]);
            return {
              plugins: [...(otherListing?.plugins ?? []), ...(claudeListing?.plugins ?? [])],
              errors: [...(otherListing?.errors ?? []), ...(claudeListing?.errors ?? [])],
            };
          }
        : undefined;
    const inventory = await collectCapabilityInventory(selfId, sources, () => this.now());
    if (this.deps.busyProviders) {
      // An unreadable activity record holds every provider: err towards not changing running work.
      inventory.busyProviders = await this.deps.busyProviders().catch(() => [...AGENT_PLATFORMS]);
    }
    const mcpInstaller = this.deps.mcp;
    if (!mcpInstaller) return inventory;
    const executor = await this.deps.storage.capabilities.loadCapabilityExecutorState();
    for (const [key, applied] of Object.entries(executor.applied)) {
      if (!applied.packageId || !applied.componentId) continue;
      const scope = key.slice(selfId.length + 1);
      if (!key.startsWith(`${selfId}|`) || !scope.startsWith("mcp:")) continue;
      const { mcp, externalMcp, componentId, packageId, digest } = applied;
      if (externalMcp) {
        const { provider, definition } = externalMcp;
        if (await mcpInstaller.configured?.(provider, definition).catch(() => false)) {
          inventory.items.push({
            id: key,
            provider,
            kind: "mcp-server",
            name: definition.name,
            locationId: `mcp:${provider}`,
            locationLabel: "MCP configuration",
            ownership: "external",
            packageId,
            componentId,
            digest,
            enabled: true,
            visibleTo: [provider],
          });
        }
        continue;
      }
      if (!mcp) continue;
      const item = inventory.items.find(
        (entry) =>
          entry.kind === "mcp-server" && entry.provider === mcp.provider && entry.name === mcp.name,
      );
      if (!item) continue;
      const status =
        (await mcpInstaller.observe?.(mcp).catch(() => "unavailable")) ?? "unavailable";
      if (
        status === "unavailable" &&
        !inventory.errors.some((error) => error.provider === item.provider)
      ) {
        inventory.errors.push({
          provider: item.provider,
          message: "Could not verify managed MCP definitions.",
        });
      }
      if (status === "present" || status === "drifted") {
        item.locationId = `mcp:${mcp.provider}`;
        item.ownership = "managed";
        item.packageId = applied.packageId;
        item.componentId = applied.componentId;
        item.digest = applied.digest;
        item.drifted = status === "drifted";
        if (mcpInstaller.effective)
          item.enabled = await mcpInstaller.effective(mcp).catch(() => false);
      }
    }
    return inventory;
  }

  private async observeNode(
    nodeId: string,
    options: InventoryReadOptions = {},
  ): Promise<CapabilityInventory> {
    if (nodeId === (await this.deps.selfId())) return this.observeSelf(options);
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    return remoteTransport({
      selfId: this.deps.selfId,
      link: this.deps.link,
      artifacts: this.artifacts,
    }).observe(nodeId, state.epoch, options);
  }

  // --- Reads (`library-reads.ts`) ----------------------------------------------

  listPackages(args: Record<string, unknown>): Promise<CapabilityLibrary> {
    return this.reads.listPackages(args);
  }

  getPackage(args: Record<string, unknown>) {
    return this.reads.getPackage(args);
  }

  readFile(
    args: Record<string, unknown>,
  ): Promise<{ path: string; content: string; truncated: boolean }> {
    return this.reads.readFile(args);
  }

  listSetups(): Promise<CapabilitySetupList> {
    return this.reads.listSetups();
  }

  getInventory(args: Record<string, unknown>): Promise<CapabilityInventory> {
    return this.reads.getInventory(args);
  }

  getTargetSupport(args: Record<string, unknown>): Promise<CapabilityTargetSupportResult> {
    return this.reads.getTargetSupport(args);
  }

  /**
   * One target's effective resources: My setup (when the machine is
   * enrolled), then the project, template, graph-node and session
   * assignments, then any explicit selections, all narrowed by `ceiling`
   * (`resolution.ts`).
   */
  resolveFor(state: CapabilityState, input: CapabilityResolveInput): EffectiveAgentResources {
    return resolveCapabilityTarget(state, input, () => this.now());
  }

  getEffectiveResources(args: Record<string, unknown>): Promise<EffectiveAgentResources> {
    return this.reads.getEffectiveResources(args);
  }

  /** The session chip: a session's setups, effective resources and each component's state. */
  getSessionView(args: Record<string, unknown>): Promise<CapabilitySessionView> {
    return this.reads.getSessionView(args);
  }

  listMachines(): Promise<CapabilityMachineList> {
    return this.reads.listMachines();
  }

  listDrift(args: Record<string, unknown>): Promise<CapabilityDriftList> {
    return this.reads.listDrift(args);
  }

  listActivity(args: Record<string, unknown>): Promise<CapabilityActivityList> {
    return this.reads.listActivity(args);
  }

  listOperations(args: Record<string, unknown>): Promise<CapabilityOperationList> {
    return this.reads.listOperations(args);
  }

  getOperation(args: Record<string, unknown>) {
    return this.reads.getOperation(args);
  }

  listUpdates(): Promise<CapabilityUpdateList> {
    return this.reads.listUpdates();
  }

  // --- Inspecting and authoring (`inspection-commands.ts`, `drift.ts`) ----------

  inspectSource(args: Record<string, unknown>): Promise<CapabilitySourceInspection> {
    return this.inspection.inspectSource(args);
  }

  authorPackage(args: Record<string, unknown>): Promise<CapabilitySourceInspection> {
    return this.inspection.authorPackage(args);
  }

  /** Inspects an installed item on a machine as a package, so it can be adopted (`drift.ts`). */
  adoptExternal(args: Record<string, unknown>): Promise<CapabilitySourceInspection> {
    return this.drift.adoptExternal(args);
  }

  /** This machine's files of one inventory item; the item id names a known location. */
  exportLocalItem(itemId: string): Promise<PackageFile[]> {
    return this.drift.exportLocalItem(itemId);
  }

  /** Three-way merges a package's local changes with its configured revision (`drift.ts`). */
  mergeDrift(args: Record<string, unknown>, actor?: string): Promise<CapabilityDriftMerge> {
    return this.drift.merge(args, actor);
  }

  // --- Changes and operations (`change-commands.ts`) ----------------------------

  previewChange(args: Record<string, unknown>, actor?: string): Promise<CapabilityChangeResult> {
    return this.changes.previewChange(args, actor);
  }

  /**
   * Applies a previewed operation. The plan is recomputed against the
   * current state and must hash to the approved digest; the change, the
   * approval and the operation commit together, then delivery starts.
   */
  applyChange(args: Record<string, unknown>, actor?: string): Promise<CapabilityChangeResult> {
    return this.changes.applyChange(args, actor);
  }

  cancelOperation(args: Record<string, unknown>) {
    return this.changes.cancelOperation(args);
  }

  // --- Setups, assignments, machines (`setup-commands.ts`) ----------------------

  setSetup(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetup> {
    return this.setups.setSetup(args, actor);
  }

  deleteSetup(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetupList> {
    return this.setups.deleteSetup(args, actor);
  }

  /** One scope's own assignment (what its checkboxes show), not what it inherits. */
  getAssignment(args: Record<string, unknown>): Promise<{
    scope: string;
    scopeId: string;
    setupIds: string[];
    revision: number;
  }> {
    return this.setups.getAssignment(args);
  }

  assignSetup(args: Record<string, unknown>, actor?: string) {
    return this.setups.assignSetup(args, actor);
  }

  manageException(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetup> {
    return this.setups.manageException(args, actor);
  }

  setMachineEnrollment(args: Record<string, unknown>, actor?: string) {
    return this.setups.setMachineEnrollment(args, actor);
  }

  setPackageState(args: Record<string, unknown>, actor?: string) {
    return this.setups.setPackageState(args, actor);
  }

  resolveDrift(args: Record<string, unknown>, actor?: string) {
    return this.drift.resolveDrift(args, actor);
  }

  // --- Updates and rollback (`update-commands.ts`) ------------------------------

  refreshUpdates(args: Record<string, unknown>): Promise<CapabilityUpdateList> {
    return this.updates.refreshUpdates(args);
  }

  previewUpdate(args: Record<string, unknown>, actor?: string): Promise<CapabilityChangeResult> {
    return this.updates.previewUpdate(args, actor);
  }

  approveUpdate(args: Record<string, unknown>, actor?: string): Promise<CapabilityChangeResult> {
    return this.updates.approveUpdate(args, actor);
  }

  setUpdatePolicy(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetup> {
    return this.updates.setUpdatePolicy(args, actor);
  }

  rollbackPackage(args: Record<string, unknown>, actor?: string): Promise<CapabilityChangeResult> {
    return this.updates.rollbackPackage(args, actor);
  }

  // --- Import and export (`import-commands.ts`) ---------------------------------

  exportSetup(args: Record<string, unknown>): Promise<CapabilityExport> {
    return this.imports.exportSetup(args);
  }

  previewImport(args: Record<string, unknown>): Promise<CapabilityImportPreview> {
    return this.imports.previewImport(args);
  }

  importSetup(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetupList> {
    return this.imports.importSetup(args, actor);
  }

  // --- Verification and launch preflight (`preflight.ts`) -----------------------

  /** Non-destructive checks, with the user's consent, of each component's bytes on a machine. */
  verify(args: Record<string, unknown>): Promise<CapabilityVerification> {
    return this.preflight.verify(args);
  }

  async forgetEnvironmentLaunches(environmentId: string): Promise<void> {
    const nodeId = await this.deps.selfId();
    this.deps.storage.capabilities.forgetCapabilityLaunches(
      ({ target }) => target.nodeId === nodeId && target.environmentId === environmentId,
    );
    await this.preflight.prunePrivatePlugins();
  }

  /** Launch preflight for a native agent session: resolves the frozen effective manifest. */
  preflightLaunch(input: {
    target: CapabilityTarget;
    sessionKey: string;
    ceiling: CapabilityPermissionCeiling;
    templateId?: string;
    graphNode?: string;
    relativeWorktree?: string;
  }): Promise<EffectiveAgentResources> {
    return this.preflight.preflightLaunch(input);
  }

  /** The native-session and graph launch hook: preflight under the launch policy, then record it. */
  preflightSession(input: {
    readOnly?: boolean;
    environmentId: string;
    projectId?: string;
    environmentIncarnation?: string;
    accountHomeId?: string;
    templateId?: string;
    graphNode?: string;
    relativeWorktree?: string;
    provider: AgentPlatform;
    sessionKey: string;
    policy?: Parameters<typeof nativeAgentDeniedCapabilities>[0] & { id?: string };
  }): Promise<EffectiveAgentResources | null> {
    return this.preflight.preflightSession(input);
  }

  /**
   * The plugin directories a session's turns pass to its provider: the
   * components its launch delivered to it alone (`session-delivery.ts`).
   * Throws when a recorded plugin can no longer be produced, so a turn never
   * runs without what the session launched with.
   */
  sessionPlugins(
    sessionKey: string,
    environmentId: string,
    provider: AgentPlatform,
  ): Promise<string[]> {
    return this.preflight.sessionPlugins(sessionKey, environmentId, provider);
  }

  // --- Environment copies (`scoped-delivery.ts`, `container-staging.ts`) ---------

  private environmentDeliveryContext(): EnvironmentDeliveryContext {
    return {
      storage: this.deps.storage,
      artifacts: this.artifacts,
      selfId: () => this.deps.selfId(),
      resolve: (state, target) =>
        this.resolveFor(state, { target, ceiling: UNRESTRICTED_CAPABILITY_CEILING }),
      sources: this.deps.scoped ?? {},
      now: () => this.now(),
    };
  }

  /** Container creation: the manifest to stage into the new inputs revision, and its hook. */
  prepareContainerStaging(input: Parameters<typeof containerStaging>[1]) {
    return containerStaging(this.environmentDeliveryContext(), input);
  }

  /** The environment card: its worktree copies, or its container's staged and current manifests. */
  async getEnvironmentDelivery(args: Record<string, unknown>) {
    const environmentId = asText(args.environmentId, "environmentId");
    const environments = (await this.deps.scoped?.environments?.().catch(() => [])) ?? [];
    const environment = environments.find((entry) => entry.id === environmentId);
    if (!environment) {
      return { environmentId, kind: "none" as const, stale: false, items: [] };
    }
    return environmentDeliveryView(this.environmentDeliveryContext(), environment);
  }

  // --- Executor (this machine, called by its command node; `executor-handlers.ts`)

  executorObserve(args: Record<string, unknown>): Promise<CapabilityInventory> {
    return this.executorHandlers.observe(args);
  }

  executorStage(args: Record<string, unknown>): Promise<{ complete: boolean; missing: number[] }> {
    return this.executorHandlers.stage(args);
  }

  executorApply(args: Record<string, unknown>): Promise<{ results: unknown[] }> {
    return this.executorHandlers.apply(args);
  }

  /** `get_capability_node_environment_observation`: this machine's worktrees, for its command node. */
  executorObserveEnvironments(args: Record<string, unknown>) {
    return this.executorHandlers.observeEnvironments(args);
  }

  /** `apply_capability_node_environment_plan`: a project setup into one worktree here. */
  executorApplyEnvironmentPlan(args: Record<string, unknown>) {
    return this.executorHandlers.applyEnvironmentPlan(args);
  }

  executorExportItem(
    args: Record<string, unknown>,
  ): Promise<{ files: Array<{ path: string; executable: boolean; data: string }> }> {
    return this.executorHandlers.exportItem(args);
  }

  // --- Authority: command-node handover and leaf launches (handover.ts, launch-authority.ts)

  private async refreshAuthority(): Promise<void> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    this.handedOver = handedOverAuthority(state);
  }

  /** `stage_capability_node_handover`: the old command node sending its state here. */
  executorStageHandover(args: Record<string, unknown>) {
    return this.handoverReceiver.stage(args);
  }

  /** `answer_capability_node_launch`: the command node answering this leaf's launch. */
  executorLaunchAnswer(args: Record<string, unknown>) {
    return this.leafLaunch.receiveAnswer(args);
  }

  /** Command node: a leaf asked to resolve a launch (`node-capability-launch-requested`). */
  answerLeafLaunch(nodeId: string, payload: unknown): Promise<{ answered: boolean }> {
    const transport = remoteTransport({
      selfId: this.deps.selfId,
      link: this.deps.link,
      artifacts: this.artifacts,
    });
    return answerLeafLaunch(
      {
        storage: this.deps.storage,
        selfId: this.deps.selfId,
        isAuthority: () => this.deps.isAuthority(),
        link: this.deps.link,
        resolve: (state, input) => this.resolveFor(state, input),
        artifacts: this.artifacts,
        observeNode: transport.observe,
        stageArtifact: transport.stage,
        now: () => this.now(),
      },
      nodeId,
      payload,
    ).catch((error: unknown) => {
      log.warn("launch.answer-failed", { error: formatLogError(error, { message: false }) });
      return { answered: false };
    });
  }

  /** The hooks `NodeService` runs around a command-node handover. */
  handoverHooks() {
    const sender = {
      storage: this.deps.storage,
      artifacts: this.artifacts,
      selfId: this.deps.selfId,
      quiesce: () => this.reconciler.idle(),
      authorityChanged: () => void this.refreshAuthority(),
      now: () => this.now(),
    };
    const sent = new Map<string, boolean>();
    return {
      send: async (input: { handoverId: string; targetId: string; invoke: HandoverInvoke }) => {
        // Stop acting at once; the marker written next makes it durable.
        this.handedOver = true;
        const result = await sendCapabilityHandover(sender, input).catch(async (error) => {
          await this.refreshAuthority();
          throw error;
        });
        sent.set(input.handoverId, result.sent);
        await this.refreshAuthority();
      },
      sent: async (input: { handoverId: string; targetId: string }) => {
        completeCapabilityHandover(sender, { ...input, sent: sent.get(input.handoverId) ?? true });
        sent.delete(input.handoverId);
        await this.refreshAuthority();
      },
      abandoned: async (handoverId: string) => {
        abandonCapabilityHandover(sender, handoverId);
        sent.delete(handoverId);
        await this.refreshAuthority();
      },
      receive: async (input: { controllerId: string; handoverId: string }) => {
        await this.handoverReceiver.install(input);
        await this.refreshAuthority();
      },
      received: () => {
        // The old controllers are detached now: act as the authority at once.
        void this.refreshAuthority().then(() => this.reconciler.reconcileAll("handover"));
      },
    };
  }
}
