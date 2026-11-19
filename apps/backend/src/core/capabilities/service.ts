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
 */
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

import {
  AGENT_PLATFORMS,
  isAgentPlatform,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  CAPABILITY_LIMITS,
  CAPABILITY_UPDATE_POLICIES,
  MY_SETUP_ID,
  capabilityPackageId,
  isCapabilitySelector,
  isPackageSource,
  isTerminalCapabilityOperationState,
  summarizeCapabilityTargets,
  type CapabilityPackageSelection,
  type CapabilityPlannedTarget,
  type CapabilitySetup,
  type CapabilityTarget,
  type CapabilityUpdatePolicy,
  type ComponentKind,
  type EffectiveAgentResources,
  type PackageSource,
} from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityActivityList,
  CapabilityChangeResult,
  CapabilityDriftList,
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
  canonicalCapabilityJson,
  capabilityInstallApproval,
  capabilityRevisionComponents,
  compatibleProviders,
  resolveEffectiveAgentResources,
  type CapabilityLayer,
  type CapabilityPermissionCeiling,
} from "@orkestrator/protocol/capability-resources-resolve";
import {
  baselineCapabilitySupport,
  capabilityLiveSemantics,
  capabilityLocation,
} from "@orkestrator/protocol/capability-resources-support";
import { exportCapabilityNodeItemCommand } from "@orkestrator/protocol/contract/domains/capabilities";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  nativeAgentDeniedCapabilities,
  nativeAgentUserMcpGrant,
} from "@orkestrator/protocol/native-agent";

import type { CapabilitiesStorage } from "../storage-capabilities.js";
import { CapabilityArtifactStore } from "./artifact-store.js";
import { authoredFiles, parseAuthoredInput } from "./authoring.js";
import { CapabilityExecutor, parseNodePlanTargets, type McpInstaller } from "./executor.js";
import {
  exportSetups,
  parseManifests,
  planImport,
  readProjectManifests,
  setupSlug,
  writeProjectManifests,
} from "./import-export.js";
import { collectCapabilityInventory, type InventorySources } from "./inventory.js";
import { locationDirectory, type CapabilityHomes } from "./native-ownership.js";
import { remoteTransport, routedTransport, type CapabilityLink } from "./node-transport.js";
import {
  applyChangeToState,
  approvalReasonsFor,
  newCorrelationId,
  newOperationId,
  operationSnapshot,
  parseCapabilityChange,
  planDigestOf,
  recordActivity,
  supersedeOperations,
  type CapabilityChange,
  type CapabilityOperationRecord,
} from "./operations.js";
import { desiredStateForNode, installationKey, planNode, sha256, supportFor } from "./planning.js";
import { CapabilityReconciler, localTransport } from "./reconciler.js";
import { effectiveReceiptStatus } from "./runtime-evidence.js";
import {
  CapabilityError,
  readPackageTree,
  treeDigest,
  validatePackageFiles,
  type PackageFile,
} from "./security.js";
import {
  assertDistributableArtifact,
  containsLiteralMcpCredentials,
  inspectFiles,
  inspectGitSource,
  newInspectionId,
  remoteGitHead,
  scanPackageSecrets,
  type GitFetchOptions,
  type InspectedPackage,
} from "./source-inspection.js";
import type { CapabilityState, SourceInspectionRecord } from "./types.js";
import { checkPackageUpdate } from "./update-checker.js";
import {
  availabilityCells,
  desiredByNode,
  machineSummaries,
  packageDetail,
  packageSummary,
  type MachineFact,
} from "./views.js";

const log = createLogger("capabilities");

const INSPECTION_TTL_MS = 60 * 60_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

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
  emit(event: {
    revision: number;
    packageIds: string[];
    setupIds: string[];
    operationIds: string[];
  }): void;
  homes(): CapabilityHomes;
  inventory: Omit<InventorySources, "homes">;
  mcp?: McpInstaller;
  gitRun?: GitFetchOptions["run"];
  now?: () => string;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityError("invalid-request", `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown, name: string, max: number = CAPABILITY_LIMITS.maxIdChars): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new CapabilityError("invalid-request", `${name} is required.`);
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTarget(value: unknown, fallbackNode: string): CapabilityTarget {
  const record = asRecord(value, "target");
  if (!isAgentPlatform(record.provider))
    throw new CapabilityError("invalid-request", "target.provider is required.");
  const optional = (key: string) =>
    typeof record[key] === "string" &&
    (record[key] as string).length <= CAPABILITY_LIMITS.maxIdChars
      ? { [key]: record[key] as string }
      : {};
  return {
    nodeId: typeof record.nodeId === "string" && record.nodeId ? record.nodeId : fallbackNode,
    provider: record.provider,
    ...optional("accountHomeId"),
    ...optional("projectId"),
    ...optional("environmentId"),
    ...optional("environmentIncarnation"),
    ...optional("sessionId"),
  };
}

function parseCeiling(value: unknown): CapabilityPermissionCeiling {
  if (value === undefined) return { denied: [], userMcpServers: null, digest: "unrestricted" };
  const record = asRecord(value, "ceiling");
  const denied = Array.isArray(record.denied)
    ? record.denied
        .filter((entry): entry is string => typeof entry === "string" && entry.length <= 128)
        .slice(0, 64)
    : [];
  const userMcpServers = Array.isArray(record.userMcpServers)
    ? record.userMcpServers
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 32)
    : null;
  return {
    denied,
    userMcpServers,
    digest: sha256(canonicalCapabilityJson({ denied: [...denied].sort(), userMcpServers })),
  };
}

function parseSelections(value: unknown): CapabilityPackageSelection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new CapabilityError("invalid-request", "selections must be a list.");
  return value.slice(0, CAPABILITY_LIMITS.maxSelectionsPerSetup).map((entry: unknown) => {
    const record = asRecord(entry, "selection");
    return {
      packageId: asText(record.packageId, "packageId"),
      version: typeof record.version === "string" ? record.version : "latest",
      ...(Array.isArray(record.components)
        ? { components: record.components.filter((id): id is string => typeof id === "string") }
        : {}),
      ...(record.required === true ? { required: true } : {}),
    };
  });
}

function stringList(
  value: unknown,
  max: number,
  check: (entry: string) => boolean = () => true,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CapabilityError("invalid-request", "Expected a list.");
  return value
    .filter((entry): entry is string => typeof entry === "string" && check(entry))
    .slice(0, max);
}

export class CapabilityService {
  readonly artifacts: CapabilityArtifactStore;
  readonly executor: CapabilityExecutor;
  readonly reconciler: CapabilityReconciler;
  private updateTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly deps: CapabilityServiceDeps) {
    this.artifacts = new CapabilityArtifactStore(deps.dataDir);
    this.executor = new CapabilityExecutor({
      storage: deps.storage,
      artifacts: this.artifacts,
      homes: deps.homes,
      ...(deps.mcp ? { mcp: deps.mcp } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    const local = localTransport({
      selfId: deps.selfId,
      observe: () => this.observeSelf(),
      executor: this.executor,
      artifacts: this.artifacts,
    });
    const transport = routedTransport({
      selfId: deps.selfId,
      local: { ...local },
      remote: remoteTransport({ selfId: deps.selfId, link: deps.link, artifacts: this.artifacts }),
    });
    this.reconciler = new CapabilityReconciler({
      storage: deps.storage,
      artifacts: this.artifacts,
      selfId: deps.selfId,
      machines: deps.machines,
      transport,
      isAuthority: deps.isAuthority,
      emit: (change) => void this.announce(change),
      nodeName: async (nodeId) =>
        (await this.machineFacts()).find((machine) => machine.nodeId === nodeId)?.name ?? nodeId,
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  /** Makes sure this machine has a record, then starts reconciliation and update checks. */
  async init(): Promise<void> {
    const selfId = await this.deps.selfId();
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
    if (!this.updateTimer) {
      this.updateTimer = setInterval(() => {
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

  private async announce(change: {
    packageIds: string[];
    setupIds: string[];
    operationIds: string[];
  }) {
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

  async observeSelf(): Promise<CapabilityInventory> {
    const selfId = await this.deps.selfId();
    const inventory = await collectCapabilityInventory(
      selfId,
      { ...this.deps.inventory, homes: this.deps.homes() },
      () => this.now(),
    );
    const observeMcp = this.deps.mcp?.observe;
    if (!observeMcp) return inventory;
    const executor = await this.deps.storage.capabilities.loadCapabilityExecutorState();
    for (const item of inventory.items) {
      if (item.kind !== "mcp-server") continue;
      const applied = Object.values(executor.applied).find(
        ({ mcp, componentId }) =>
          mcp && componentId && item.provider === mcp.provider && item.name === mcp.name,
      );
      if (!applied?.mcp || !applied.packageId || !applied.componentId) continue;
      const status = await observeMcp(applied.mcp).catch(() => "unavailable");
      if (status === "present" || status === "drifted") {
        item.locationId = `mcp:${applied.mcp.provider}`;
        item.ownership = "managed";
        item.packageId = applied.packageId;
        item.componentId = applied.componentId;
        item.digest = applied.digest;
        item.drifted = status === "drifted";
      }
    }
    return inventory;
  }

  // --- Reads ------------------------------------------------------------------

  async listPackages(args: Record<string, unknown>): Promise<CapabilityLibrary> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const machines = await this.machineFacts();
    const desired = desiredByNode(state, machines);
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const kind = typeof args.kind === "string" ? args.kind : undefined;
    const setupId = typeof args.setupId === "string" ? args.setupId : undefined;
    const limit = Math.min(
      Math.max(optionalNumber(args.limit) ?? 500, 1),
      CAPABILITY_LIMITS.maxPackages,
    );
    const rows = Object.keys(state.packages)
      .map((id) => packageSummary(state, id, availabilityCells(state, id, machines, desired)))
      .filter((row) => row !== null)
      .filter((row) => {
        if (kind && !row.kinds.includes(kind as ComponentKind)) return false;
        if (setupId && !row.assignedSetupIds.includes(setupId)) return false;
        if (!query) return true;
        const pkg = state.packages[row.id]!;
        const haystack = [
          row.displayName,
          row.description ?? "",
          row.sourceLabel,
          ...pkg.componentIds.map(
            (id) =>
              `${state.components[id]?.name ?? ""} ${state.components[id]?.description ?? ""}`,
          ),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    return {
      revision: state.revision,
      packages: rows.slice(0, limit),
      truncated: Math.max(0, rows.length - limit),
      epoch: state.epoch,
    };
  }

  async getPackage(args: Record<string, unknown>) {
    const packageId = asText(args.packageId, "packageId");
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const machines = await this.machineFacts();
    const detail = packageDetail(state, packageId, machines, desiredByNode(state, machines));
    if (!detail) throw new CapabilityError("not-found", "That package is not in the library.");
    return detail;
  }

  async readFile(
    args: Record<string, unknown>,
  ): Promise<{ path: string; content: string; truncated: boolean }> {
    const packageId = asText(args.packageId, "packageId");
    const filePath = asText(args.path, "path", CAPABILITY_LIMITS.maxPathChars);
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const pkg = state.packages[packageId];
    const digest = pkg?.artifactDigest ?? state.inspections[packageId]?.artifactDigest;
    if (!digest) throw new CapabilityError("not-found", "That package is not in the library.");
    const files = await this.artifacts.get(digest);
    if (scanPackageSecrets(files).length || containsLiteralMcpCredentials(files)) {
      throw new CapabilityError(
        "secrets-detected",
        "The cached artifact contains credential material. Inspect a clean revision.",
      );
    }
    const file = files.find((entry) => entry.path === filePath);
    if (!file) throw new CapabilityError("not-found", "That file is not in the package.");
    const text = file.content.subarray(0, CAPABILITY_LIMITS.maxPreviewChars).toString("utf8");
    return {
      path: file.path,
      content: text,
      truncated: file.content.length > CAPABILITY_LIMITS.maxPreviewChars,
    };
  }

  async listSetups(): Promise<CapabilitySetupList> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const setups = Object.values(state.setups).sort((a, b) =>
      a.id === MY_SETUP_ID ? -1 : b.id === MY_SETUP_ID ? 1 : a.name.localeCompare(b.name),
    );
    return { revision: state.revision, setups };
  }

  async getInventory(args: Record<string, unknown>): Promise<CapabilityInventory> {
    const selfId = await this.deps.selfId();
    const nodeId = typeof args.nodeId === "string" && args.nodeId ? args.nodeId : selfId;
    if (nodeId === selfId) return this.observeSelf();
    if (args.refresh === true) return this.observeNode(nodeId);
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const inventory = state.machines[nodeId]?.inventory;
    if (!inventory)
      throw new CapabilityError("not-found", "That machine has not reported its inventory yet.");
    return inventory;
  }

  private async observeNode(nodeId: string): Promise<CapabilityInventory> {
    if (nodeId === (await this.deps.selfId())) return this.observeSelf();
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    return remoteTransport({
      selfId: this.deps.selfId,
      link: this.deps.link,
      artifacts: this.artifacts,
    }).observe(nodeId, state.epoch);
  }

  async getTargetSupport(args: Record<string, unknown>): Promise<CapabilityTargetSupportResult> {
    const selfId = await this.deps.selfId();
    const nodeId = typeof args.nodeId === "string" && args.nodeId ? args.nodeId : selfId;
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const inventory =
      nodeId === selfId
        ? await this.observeSelf().catch(() => undefined)
        : state.machines[nodeId]?.inventory;
    return { nodeId, matrices: AGENT_PLATFORMS.map((provider) => supportFor(inventory, provider)) };
  }

  private assignmentSetups(
    state: CapabilityState,
    scope: string,
    id: string | undefined,
  ): string[] {
    if (!id) return [];
    return state.assignments[`${scope}:${id}`]?.setupIds ?? [];
  }

  /**
   * One target's effective resources: My setup (when the machine is
   * enrolled), then the project, template, graph-node and session
   * assignments, then any explicit selections, all narrowed by `ceiling`.
   */
  resolveFor(
    state: CapabilityState,
    input: {
      target: CapabilityTarget;
      setupIds?: string[];
      selections?: CapabilityPackageSelection[];
      exclusions?: string[];
      templateId?: string;
      graphNode?: string;
      sessionKey?: string;
      ceiling: CapabilityPermissionCeiling;
      launchInventory?: CapabilityInventory;
      forLaunch?: boolean;
    },
  ): EffectiveAgentResources {
    const machine = state.machines[input.target.nodeId];
    const layers: CapabilityLayer[] = [
      { scope: "my-setup", setupIds: [MY_SETUP_ID] },
      {
        scope: "toolkit",
        setupIds: Object.values(state.setups)
          .filter(
            (setup) =>
              setup.id !== MY_SETUP_ID &&
              (!setup.targetSelectors || setup.targetSelectors.length === 0) &&
              setup.machineSelectors.length > 0,
          )
          .map((setup) => setup.id),
      },
      {
        scope: "project",
        setupIds: this.assignmentSetups(state, "project", input.target.projectId),
      },
      {
        scope: "template",
        setupIds: [
          ...this.assignmentSetups(state, "template", input.templateId),
          ...this.assignmentSetups(state, "environment", input.target.environmentId),
        ],
      },
      {
        scope: "graph-node",
        setupIds: this.assignmentSetups(state, "graph-node", input.graphNode),
      },
      {
        scope: "session",
        setupIds: [
          ...this.assignmentSetups(state, "session", input.sessionKey),
          ...(input.setupIds ?? []),
        ],
        selections: input.selections ?? [],
        exclusions: input.exclusions ?? [],
      },
    ];
    return resolveEffectiveAgentResources({
      facts: {
        target: input.target,
        groups: machine?.groups ?? [],
        ...(input.templateId ? { templateId: input.templateId } : {}),
        ...(input.graphNode ? { graphNode: input.graphNode } : {}),
        enrolled: machine?.enrolled ?? state.settings.enrollNewMachines,
      },
      layers,
      setups: new Map(Object.entries(state.setups)),
      packages: new Map(Object.entries(state.packages)),
      components: new Map(Object.entries(state.components)),
      support: supportFor(
        input.launchInventory ?? machine?.inventory,
        input.target.provider,
        input.target.environmentIncarnation !== undefined ? "container" : "host",
      ),
      ...(input.forLaunch
        ? {
            requiredDelivery: (component, digest) => {
              if (
                input.target.environmentIncarnation !== undefined ||
                input.target.accountHomeId !== undefined
              ) {
                return "The required revision cannot be verified in this container or account.";
              }
              const matching = Object.values(state.receipts).some((receipt) => {
                if (
                  receipt.nodeId !== input.target.nodeId ||
                  !receipt.providers.includes(input.target.provider) ||
                  receipt.componentId !== component.id ||
                  receipt.packageDigest !== digest ||
                  receipt.outcomeUnknown ||
                  (receipt.status !== "installed-next-session" && receipt.status !== "ready")
                )
                  return false;
                return (
                  input.launchInventory?.items.some(
                    (item) =>
                      item.ownership === "managed" &&
                      item.componentId === component.id &&
                      item.locationId === receipt.locationId &&
                      !item.drifted &&
                      item.digest === receipt.digest,
                  ) === true
                );
              });
              return matching
                ? undefined
                : `The required revision of ${component.name} is not verified on this machine.`;
            },
          }
        : {}),
      ceiling: input.ceiling,
      admin: {
        forbiddenSources: state.settings.forbiddenSources,
        forbiddenComponents: state.settings.forbiddenComponents,
      },
      hash: sha256,
      now: () => this.now(),
    });
  }

  async getEffectiveResources(args: Record<string, unknown>): Promise<EffectiveAgentResources> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const target = parseTarget(args.target, await this.deps.selfId());
    return this.resolveFor(state, {
      target,
      setupIds: stringList(args.setupIds, 32),
      selections: parseSelections(args.selections),
      exclusions: stringList(args.exclusions, CAPABILITY_LIMITS.maxExclusionsPerSetup),
      ...(typeof args.templateId === "string" ? { templateId: args.templateId } : {}),
      ...(typeof args.graphNode === "string" ? { graphNode: args.graphNode } : {}),
      ceiling: parseCeiling(args.ceiling),
    });
  }

  /**
   * The session chip: the setups a session uses, its effective resources and
   * each component's state on that session's machine and provider, with what
   * a change would mean while it runs.
   */
  async getSessionView(args: Record<string, unknown>): Promise<CapabilitySessionView> {
    const sessionKey = asText(args.sessionKey, "sessionKey");
    const target = parseTarget(args.target, await this.deps.selfId());
    const sessionRunning = args.sessionRunning === true;
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const assigned = this.assignmentSetups(state, "session", sessionKey);
    // The session's own policy, as its projection reports it: it can only narrow.
    const effective = this.resolveFor(state, {
      target,
      sessionKey,
      ceiling: parseCeiling(args.ceiling),
    });
    const matrix = supportFor(state.machines[target.nodeId]?.inventory, target.provider);
    const components: CapabilitySessionView["components"] = [];
    const catalogue = new Map(Object.entries(state.components));
    for (const pkg of effective.resolvedPackages) {
      const record = state.packages[pkg.id];
      const revision =
        record && capabilityRevisionComponents(record, pkg.artifactDigest, catalogue);
      for (const component of revision ?? []) {
        const componentId = component.id;
        if (!pkg.components.includes(componentId)) continue;
        const receipt = Object.values(state.receipts).find(
          (entry) =>
            entry.nodeId === target.nodeId &&
            entry.componentId === componentId &&
            entry.packageDigest === pkg.artifactDigest &&
            entry.providers.includes(target.provider),
        );
        const status = receipt ? effectiveReceiptStatus(receipt).status : "pending";
        components.push({
          componentId,
          name: component.name,
          kind: component.kind,
          status,
          liveSemantics: capabilityLiveSemantics({
            matrix,
            kind: component.kind,
            sessionRunning,
            exclusive: false,
            blocked: false,
          }),
          ...(receipt?.reason ? { reason: receipt.reason } : {}),
        });
      }
    }
    for (const entry of [...effective.blocked, ...effective.unsupported]) {
      const component = state.components[entry.componentId];
      components.push({
        componentId: entry.componentId,
        name: component?.name ?? entry.componentId,
        kind: component?.kind ?? "skill",
        status: effective.blocked.includes(entry) ? "blocked-policy" : "unsupported",
        liveSemantics: effective.blocked.includes(entry)
          ? "blocked-by-policy"
          : "new-session-required",
        reason: entry.reason,
      });
    }
    const labelIds = assigned.length > 0 ? assigned : [MY_SETUP_ID];
    const label = labelIds
      .map((id) => state.setups[id]?.name)
      .filter((name): name is string => Boolean(name))
      .join(" + ");
    const readiness: CapabilitySessionView["readiness"] =
      effective.launchBlockers.length > 0
        ? "blocked"
        : components.some(
              (entry) =>
                entry.status === "failed" ||
                entry.status === "drifted" ||
                entry.status === "needs-auth",
            )
          ? "needs-attention"
          : components.every(
                (entry) =>
                  entry.status === "ready" ||
                  entry.status === "unsupported" ||
                  entry.status === "blocked-policy",
              )
            ? "ready"
            : "next-session";
    const launch = state.launches[sessionKey];
    return {
      sessionKey,
      setupIds: labelIds,
      label: label || "My setup",
      effective,
      // A session keeps the packages it launched with: a change since then waits for a new session.
      readiness:
        launch &&
        readiness === "ready" &&
        canonicalCapabilityJson(launch.packages) !==
          canonicalCapabilityJson(
            effective.resolvedPackages.map((entry) => ({
              id: entry.id,
              artifactDigest: entry.artifactDigest,
            })),
          )
          ? "next-session"
          : readiness,
      components,
      ...(launch ? { launchManifestDigest: launch.manifestDigest } : {}),
    };
  }

  async listMachines(): Promise<CapabilityMachineList> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const machines = await this.machineFacts();
    const summaries = machineSummaries(state, machines, desiredByNode(state, machines));
    const groups = [
      ...new Set(Object.values(state.machines).flatMap((machine) => machine.groups)),
    ].sort();
    return { machines: summaries, groups };
  }

  async listDrift(args: Record<string, unknown>): Promise<CapabilityDriftList> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const nodeId = typeof args.nodeId === "string" ? args.nodeId : undefined;
    return {
      drift: Object.values(state.drift)
        .filter((entry) => !nodeId || entry.nodeId === nodeId)
        .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)),
    };
  }

  async listActivity(args: Record<string, unknown>): Promise<CapabilityActivityList> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const limit = Math.min(
      Math.max(optionalNumber(args.limit) ?? 200, 1),
      CAPABILITY_LIMITS.maxActivity,
    );
    const packageId = typeof args.packageId === "string" ? args.packageId : undefined;
    const entries = Object.values(state.activity)
      .filter((entry) => !packageId || entry.packageIds.includes(packageId))
      .sort((a, b) => b.at.localeCompare(a.at));
    return { entries: entries.slice(0, limit), truncated: Math.max(0, entries.length - limit) };
  }

  async listOperations(args: Record<string, unknown>): Promise<CapabilityOperationList> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const limit = Math.min(
      Math.max(optionalNumber(args.limit) ?? 50, 1),
      CAPABILITY_LIMITS.maxOperations,
    );
    const operations = Object.values(state.operations as Record<string, CapabilityOperationRecord>)
      .filter(
        (operation) => args.active !== true || !isTerminalCapabilityOperationState(operation.state),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      operations: operations.slice(0, limit).map(operationSnapshot),
      truncated: Math.max(0, operations.length - limit),
    };
  }

  async getOperation(args: Record<string, unknown>) {
    const operationId = asText(args.operationId, "operationId");
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const operation = state.operations[operationId] as CapabilityOperationRecord | undefined;
    if (!operation) throw new CapabilityError("not-found", "That operation does not exist.");
    return operationSnapshot(operation);
  }

  async listUpdates(): Promise<CapabilityUpdateList> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    return {
      updates: Object.values(state.updates).sort((a, b) =>
        b.detectedAt.localeCompare(a.detectedAt),
      ),
      ...(state.settings.lastUpdateCheckAt
        ? { lastCheckedAt: state.settings.lastUpdateCheckAt }
        : {}),
    };
  }

  // --- Inspecting and authoring ---------------------------------------------

  private async storeInspection(
    inspected: InspectedPackage,
    requestKey: string | undefined,
    adoption?: SourceInspectionRecord["adoption"],
  ): Promise<CapabilitySourceInspection> {
    if (inspected.secretsFound.length > 0) {
      throw new CapabilityError(
        "secrets-detected",
        `Remove the detected credential (${inspected.secretsFound.join(", ")}) before inspecting this package.`,
      );
    }
    await this.artifacts.put(inspected.files);
    const id = newInspectionId();
    const now = this.now();
    const record: SourceInspectionRecord = {
      id,
      ...(requestKey ? { requestKey } : {}),
      ...(adoption ? { adoption } : {}),
      source: inspected.source,
      packageId: inspected.packageId,
      displayName: inspected.displayName,
      ...(inspected.description ? { description: inspected.description } : {}),
      revision: inspected.revision,
      artifactDigest: inspected.artifactDigest,
      ...(inspected.publisher ? { publisher: inspected.publisher } : {}),
      components: inspected.components,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + INSPECTION_TTL_MS).toISOString(),
    };
    const existing = this.deps.storage.capabilities.mutateCapabilityState((state) => {
      state.inspections[id] = record;
      const artifact = (state.artifacts[inspected.artifactDigest] ??= {
        digest: inspected.artifactDigest,
        bytes: inspected.files.reduce((total, file) => total + file.bytes, 0),
        files: inspected.files.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          executable: file.executable,
          sha256: file.sha256,
        })),
        refs: [],
        createdAt: now,
      });
      artifact.refs = [...new Set([...artifact.refs, `inspection:${id}`])].slice(-64);
      const pkg = state.packages[inspected.packageId];
      return {
        result: pkg ? { revision: pkg.revision, artifactDigest: pkg.artifactDigest } : undefined,
        changed: true,
      };
    });
    const matrices = baselineCapabilitySupport();
    const compatible = compatibleProviders(inspected.components, matrices);
    const unsupported: CapabilitySourceInspection["unsupported"] = [];
    for (const matrix of matrices) {
      for (const component of inspected.components) {
        if (
          component.providerHints.length > 0 &&
          !component.providerHints.includes(matrix.provider)
        )
          continue;
        const support = matrix.kinds[component.kind].install;
        if (support.level === "unsupported") {
          unsupported.push({
            provider: matrix.provider,
            componentId: component.id,
            reason: support.reason ?? "Not supported.",
          });
        }
      }
    }
    const warnings = [...inspected.warnings];
    for (const component of inspected.components) {
      if (component.requirements.os?.length)
        warnings.push(`${component.name} runs only on ${component.requirements.os.join(", ")}.`);
      if (component.requirements.binaries?.length) {
        warnings.push(
          `${component.name} needs ${component.requirements.binaries.join(", ")} installed on each machine.`,
        );
      }
      if (component.requirements.envRefs?.length) {
        warnings.push(
          `${component.name} needs ${component.requirements.envRefs.join(", ")} set on each machine; credentials are never copied.`,
        );
      }
    }
    return {
      inspectionId: id,
      expiresAt: record.expiresAt,
      source: inspected.source,
      packageId: inspected.packageId,
      displayName: inspected.displayName,
      ...(inspected.description ? { description: inspected.description } : {}),
      revision: inspected.revision,
      artifactDigest: inspected.artifactDigest,
      risk: inspected.risk,
      ...(inspected.publisher ? { publisher: inspected.publisher } : {}),
      components: inspected.components,
      files: inspected.files
        .slice(0, 500)
        .map((file) => ({ path: file.path, bytes: file.bytes, executable: file.executable })),
      totalBytes: inspected.files.reduce((total, file) => total + file.bytes, 0),
      compatibleProviders: compatible,
      unsupported,
      approvalReasons: capabilityInstallApproval(inspected.components).reasons,
      warnings: [...new Set(warnings)],
      secretsFound: inspected.secretsFound,
      ...(existing ? { existing } : {}),
    };
  }

  async inspectSource(args: Record<string, unknown>): Promise<CapabilitySourceInspection> {
    this.assertAuthority();
    const requestKey =
      typeof args.requestKey === "string" ? args.requestKey.slice(0, 200) : undefined;
    if (args.localItem !== undefined) {
      const item = asRecord(args.localItem, "localItem");
      return this.adoptExternal({ nodeId: item.nodeId, itemId: item.itemId, requestKey });
    }
    const source = args.source;
    if (!isPackageSource(source))
      throw new CapabilityError("invalid-request", "Not a valid package source.");
    switch (source.kind) {
      case "git":
        return this.storeInspection(
          await inspectGitSource(source, {
            workRoot: this.deps.dataDir,
            ...(this.deps.gitRun ? { run: this.deps.gitRun } : {}),
          }),
          requestKey,
        );
      case "provider-marketplace": {
        if (source.provider !== "claude") {
          throw new CapabilityError(
            "unsupported",
            `${source.provider} plugins are installed through ${source.provider} itself; Orkestrator can list them but not install them.`,
          );
        }
        if (
          !/^[@A-Za-z0-9][@A-Za-z0-9._/-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source.qualifiedId)
        ) {
          throw new CapabilityError(
            "invalid-request",
            "A marketplace plugin is named name@marketplace.",
          );
        }
        const manifest = Buffer.from(
          `${JSON.stringify({ marketplace: source.qualifiedId }, null, 2)}\n`,
        );
        const files: PackageFile[] = [
          {
            path: "marketplace-plugin.json",
            bytes: manifest.length,
            executable: false,
            sha256: "",
            content: manifest,
          },
        ];
        const inspected = inspectMarketplacePlugin(source, files);
        return this.storeInspection(inspected, requestKey);
      }
      case "registry":
        throw new CapabilityError(
          "unsupported",
          "No package registry is configured; add the package from its Git repository instead.",
        );
      case "local":
      case "managed":
        throw new CapabilityError(
          "invalid-request",
          "Choose an installed item or author the package instead.",
        );
    }
  }

  async authorPackage(args: Record<string, unknown>): Promise<CapabilitySourceInspection> {
    this.assertAuthority();
    const input = parseAuthoredInput(args);
    const managedId =
      typeof args.managedId === "string" && /^[a-z0-9-]{1,80}$/.test(args.managedId)
        ? args.managedId
        : `${input.name}-${randomBytes(4).toString("hex")}`;
    const source: PackageSource = { kind: "managed", managedId };
    const files = authoredFiles(input);
    const inspected = inspectFiles(source, files, { fallbackName: input.name });
    return this.storeInspection(
      {
        ...inspected,
        displayName: input.name,
        ...(input.description ? { description: input.description } : {}),
      },
      undefined,
    );
  }

  /**
   * Inspects an installed item on a machine as a package, so it can be
   * adopted. An item on another machine is read through that machine's own
   * executor; no path crosses the link, only the item's opaque id.
   */
  async adoptExternal(args: Record<string, unknown>): Promise<CapabilitySourceInspection> {
    this.assertAuthority();
    const selfId = await this.deps.selfId();
    const nodeId = typeof args.nodeId === "string" && args.nodeId ? args.nodeId : selfId;
    const itemId = asText(args.itemId, "itemId");
    const files = await this.readInventoryItem(nodeId, itemId);
    const source: PackageSource = { kind: "local", sourceMachineId: nodeId, sourceId: itemId };
    const location = capabilityLocation(itemId.split("/")[0] ?? "");
    const name = itemId.split("/").slice(1).join("/").replace(/\.md$/, "");
    const rooted =
      location?.layout === "file"
        ? files.map((file) => ({
            ...file,
            path: `${location.kind === "subagent" ? "agents" : location.kind === "prompt" ? "prompts" : "commands"}/${file.path}`,
          }))
        : files;
    const inspected = inspectFiles(source, rooted, { fallbackName: name });
    return this.storeInspection(
      inspected,
      typeof args.requestKey === "string" ? args.requestKey : undefined,
    );
  }

  private async readInventoryItem(nodeId: string, itemId: string): Promise<PackageFile[]> {
    const selfId = await this.deps.selfId();
    let files: PackageFile[];
    if (nodeId === selfId) {
      files = await this.exportLocalItem(itemId);
    } else {
      const link = this.deps.link(nodeId);
      if (!link?.connected)
        throw new CapabilityError("source-unavailable", "That machine is not connected.");
      const state = await this.deps.storage.capabilities.loadCapabilityState();
      const answer = (await link.invokeCommand(exportCapabilityNodeItemCommand, {
        controllerId: selfId,
        epoch: state.epoch,
        itemId,
      })) as { files?: unknown };
      files = validatePackageFiles(
        (Array.isArray(answer?.files) ? answer.files : []).map((entry: unknown) => {
          const file = entry as { path?: unknown; data?: unknown; executable?: unknown };
          return {
            path: String(file.path ?? ""),
            content: Buffer.from(String(file.data ?? ""), "base64"),
            executable: file.executable === true,
          };
        }),
      );
    }
    return files;
  }

  private async prepareDriftAdoption(driftId: string): Promise<CapabilityChange> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const drift = state.drift[driftId];
    const pkg = drift?.packageId ? state.packages[drift.packageId] : undefined;
    const component = drift?.componentId ? state.components[drift.componentId] : undefined;
    const location = drift ? capabilityLocation(drift.locationId) : undefined;
    if (
      !drift ||
      drift.state !== "open" ||
      drift.kind !== "modified" ||
      !drift.observedDigest ||
      !pkg ||
      pkg.source.kind !== "managed" ||
      pkg.provenance !== "managed" ||
      pkg.componentIds.length !== 1 ||
      !component ||
      !location
    ) {
      throw new CapabilityError(
        "unsupported",
        "Only a modified file component from a single-component authored package can be adopted here.",
      );
    }
    const setup = Object.values(state.setups).find((entry) =>
      entry.packageSelections.some(
        ({ packageId, version }) => packageId === pkg.id && version === "latest",
      ),
    );
    if (!setup || pkg.pinned || pkg.paused) {
      throw new CapabilityError(
        "conflict",
        "The package must be active and selected at its latest revision before adopting changes.",
      );
    }
    const inventory = await this.observeNode(drift.nodeId);
    const item = inventory.items.find(
      (entry) =>
        entry.locationId === drift.locationId &&
        entry.componentId === drift.componentId &&
        entry.packageId === pkg.id &&
        entry.digest === drift.observedDigest,
    );
    if (!item)
      throw new CapabilityError(
        "conflict",
        "The local item changed again. Refresh its inventory before reviewing it.",
      );
    const files = await this.readInventoryItem(drift.nodeId, item.id);
    if (treeDigest(files) !== drift.observedDigest) {
      throw new CapabilityError("conflict", "The local file changed while it was being read.");
    }
    const root = component.pathOrKey;
    const rooted =
      location.layout === "directory"
        ? files.map((file) => ({ ...file, path: root ? `${root}/${file.path}` : file.path }))
        : files.map((file) => ({ ...file, path: root }));
    const inspected = inspectFiles(pkg.source, rooted, { fallbackName: pkg.displayName });
    if (inspected.components.length !== 1 || inspected.components[0]?.id !== component.id) {
      throw new CapabilityError(
        "conflict",
        "The local files change the package's component identity.",
      );
    }
    const result = await this.storeInspection(inspected, undefined, {
      driftId,
      digest: drift.observedDigest,
    });
    return {
      kind: "add-to-setup",
      inspectionId: result.inspectionId,
      expectedArtifactDigest: pkg.artifactDigest,
      setupId: setup.id,
    };
  }

  /** This machine's files of one inventory item; the item id names a known location. */
  async exportLocalItem(itemId: string): Promise<PackageFile[]> {
    const slash = itemId.indexOf("/");
    const locationId = slash > 0 ? itemId.slice(0, slash) : "";
    const entry = slash > 0 ? itemId.slice(slash + 1) : "";
    const location = capabilityLocation(locationId);
    if (!location || !/^[A-Za-z0-9@][A-Za-z0-9@._+-]*$/.test(entry)) {
      throw new CapabilityError("invalid-request", "Not an inventory item.");
    }
    const directory = locationDirectory(locationId, this.deps.homes());
    if (location.layout === "directory")
      return readPackageTree(path.join(directory, entry), { within: directory });
    const files = await readPackageTree(directory, { only: [entry] });
    if (files.length !== 1)
      throw new CapabilityError("not-found", "That item is no longer installed.");
    return files;
  }

  // --- Changes and operations ---------------------------------------------

  /** Plans `change` against a copy of the state for every enrolled machine. */
  private async planChange(state: CapabilityState, change: CapabilityChange) {
    const draft = structuredClone(state);
    const applied = applyChangeToState(draft, change);
    const machines = await this.machineFacts();
    const targets: CapabilityPlannedTarget[] = [];
    for (const machine of machines) {
      if (draft.machines[machine.nodeId]?.enrolled === false) continue;
      if (change.kind === "reconcile" && change.nodeIds && !change.nodeIds.includes(machine.nodeId))
        continue;
      const inventory = draft.machines[machine.nodeId]?.inventory;
      const desired = desiredStateForNode(draft, machine.nodeId, inventory);
      const plan = planNode(draft, desired, { connected: machine.connected || machine.self });
      const relevant = plan.planned.filter(
        (target) =>
          applied.packageIds.length === 0 || applied.packageIds.includes(target.packageId),
      );
      targets.push(
        ...relevant.filter((target) => target.action !== "keep" || change.kind === "reconcile"),
      );
    }
    const bounded = targets.slice(0, CAPABILITY_LIMITS.maxTargetsPerOperation);
    return { draft, applied, targets: bounded, planDigest: planDigestOf(change, bounded) };
  }

  async previewChange(
    args: Record<string, unknown>,
    actor?: string,
  ): Promise<CapabilityChangeResult> {
    this.assertAuthority();
    const raw = asRecord(args.change, "change");
    const change =
      raw.kind === "adopt-drift"
        ? await this.prepareDriftAdoption(asText(raw.driftId, "driftId"))
        : parseCapabilityChange(raw);
    return this.previewParsedChange(
      change,
      typeof args.requestKey === "string" ? args.requestKey.slice(0, 200) : undefined,
      actor,
    );
  }

  private async previewParsedChange(
    change: CapabilityChange,
    requestKey: string | undefined,
    actor?: string,
  ): Promise<CapabilityChangeResult> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const intentDigest = sha256(canonicalCapabilityJson({ preview: change }));
    if (requestKey) {
      const previous = state.requests[`preview:${requestKey}`];
      if (previous) {
        if (previous.intentDigest !== intentDigest) {
          throw new CapabilityError(
            "conflict",
            "That request key was used for a different change.",
          );
        }
        const operation = previous.operationId ? state.operations[previous.operationId] : undefined;
        if (operation)
          return {
            operation: operationSnapshot(operation as CapabilityOperationRecord),
            replayed: true,
          };
      }
    }
    if (change.kind === "add-to-setup" || change.kind === "adopt") {
      const inspection = state.inspections[change.inspectionId];
      if (!inspection)
        throw new CapabilityError("conflict", "The inspection expired; inspect the source again.");
    }
    const { applied, targets, planDigest, draft } = await this.planChange(state, change);
    const reasons = approvalReasonsFor(draft, applied.addedComponentIds);
    if (change.kind === "add-to-setup") {
      const inspection = state.inspections[change.inspectionId];
      if (inspection?.adoption) {
        reasons.push("Adopt the observed local files as the package's new revision.");
        reasons.push(...capabilityInstallApproval(inspection.components).reasons);
      }
    }
    if (change.kind === "update") {
      const update = state.updates[change.updateId];
      const inspection = state.inspections[`update:${change.updateId}`];
      if (inspection?.secretsFound?.length) {
        throw new CapabilityError("secrets-detected", "The new revision contains a credential.");
      }
      if (update) reasons.push(...update.reasons);
    }
    if (
      change.kind === "add-to-setup" ||
      change.kind === "adopt" ||
      change.kind === "update" ||
      change.kind === "rollback"
    ) {
      await this.assertPackageArtifactsSafe(draft, applied.packageIds);
    }
    const id = newOperationId();
    const now = this.now();
    const setupId = "setupId" in change ? change.setupId : undefined;
    const record: CapabilityOperationRecord = {
      id,
      kind: change.kind,
      state: "awaiting-approval",
      planDigest,
      ...(setupId ? { setupId, setupRevision: state.setups[setupId]?.revision ?? 0 } : {}),
      packageIds: applied.packageIds,
      targets,
      requiresApproval: reasons.length > 0,
      approvalReasons: [...new Set(reasons)],
      summary: summarizeCapabilityTargets(targets),
      correlationId: newCorrelationId(),
      createdAt: now,
      updatedAt: now,
      ...(actor ? { createdBy: actor } : {}),
      change,
    };
    this.deps.storage.capabilities.mutateCapabilityState((current) => {
      current.operations[id] = record;
      if (requestKey)
        current.requests[`preview:${requestKey}`] = {
          key: requestKey,
          intentDigest,
          operationId: id,
          at: now,
        };
      return { result: undefined, changed: true };
    });
    void this.announce({
      packageIds: applied.packageIds,
      setupIds: setupId ? [setupId] : [],
      operationIds: [id],
    });
    return { operation: operationSnapshot(record), replayed: false };
  }

  private async assertPackageArtifactsSafe(state: CapabilityState, packageIds: string[]) {
    for (const packageId of packageIds) {
      const pkg = state.packages[packageId];
      if (!pkg) continue;
      const files = await this.artifacts.get(pkg.artifactDigest);
      const secrets = scanPackageSecrets(files);
      if (containsLiteralMcpCredentials(files)) secrets.push("literal MCP credential");
      if (secrets.length > 0) {
        throw new CapabilityError(
          "secrets-detected",
          `Remove the detected credential (${secrets.join(", ")}) before applying this revision.`,
        );
      }
    }
  }

  /**
   * Applies a previewed operation. The plan is recomputed against the
   * current state and must hash to the approved digest; the change, the
   * approval and the operation commit together, then delivery starts.
   */
  async applyChange(
    args: Record<string, unknown>,
    actor?: string,
  ): Promise<CapabilityChangeResult> {
    this.assertAuthority();
    const operationId = asText(args.operationId, "operationId");
    const approvedDigest = asText(args.approvedDigest, "approvedDigest");
    const requestKey =
      typeof args.requestKey === "string" ? args.requestKey.slice(0, 200) : undefined;
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const operation = state.operations[operationId] as CapabilityOperationRecord | undefined;
    if (!operation) throw new CapabilityError("not-found", "That operation does not exist.");
    if (operation.state !== "awaiting-approval" && operation.state !== "planned") {
      if (operation.approvedDigest === approvedDigest)
        return { operation: operationSnapshot(operation), replayed: true };
      throw new CapabilityError("conflict", "That operation was already applied or cancelled.");
    }
    if (approvedDigest !== operation.planDigest) {
      throw new CapabilityError(
        "approval-required",
        "The approval is for a different plan; review the preview again.",
      );
    }
    if (!operation.change)
      throw new CapabilityError("conflict", "That operation has no change to apply.");
    const replanned = await this.planChange(state, operation.change);
    if (replanned.planDigest !== approvedDigest) {
      throw new CapabilityError(
        "approval-required",
        "Something changed since the preview (a package revision, a setup or a machine). Review the new preview.",
      );
    }
    const change = operation.change;
    const adoption =
      change.kind === "add-to-setup" ? state.inspections[change.inspectionId]?.adoption : undefined;
    if (adoption) {
      const drift = state.drift[adoption.driftId];
      const inventory = drift && (await this.observeNode(drift.nodeId));
      if (
        !drift ||
        !inventory ||
        !inventory.items.some(
          (item) =>
            item.locationId === drift.locationId &&
            item.componentId === drift.componentId &&
            item.packageId === drift.packageId &&
            item.digest === adoption.digest,
        )
      ) {
        throw new CapabilityError(
          "conflict",
          "The local files no longer match the adoption preview.",
        );
      }
    }
    if (
      change.kind === "add-to-setup" ||
      change.kind === "adopt" ||
      change.kind === "update" ||
      change.kind === "rollback"
    ) {
      await this.assertPackageArtifactsSafe(replanned.draft, replanned.applied.packageIds);
    }
    const result = this.deps.storage.capabilities.mutateCapabilityState((current) => {
      const record = current.operations[operationId] as CapabilityOperationRecord | undefined;
      if (!record || (record.state !== "awaiting-approval" && record.state !== "planned")) {
        throw new CapabilityError("conflict", "That operation was already applied or cancelled.");
      }
      if (record.setupId && current.setups[record.setupId] && record.setupRevision !== undefined) {
        if (current.setups[record.setupId]!.revision !== record.setupRevision) {
          throw new CapabilityError(
            "conflict",
            "The setup changed since the preview; review it again.",
          );
        }
      }
      const applied = applyChangeToState(current, change, actor);
      if (
        applied.packageIds.some(
          (id) =>
            current.packages[id]?.artifactDigest !== replanned.draft.packages[id]?.artifactDigest,
        )
      ) {
        throw new CapabilityError("conflict", "The selected revision changed after approval.");
      }
      if (change.kind === "adopt") {
        // The installed bytes are the package's: take ownership in place.
        const inspection = state.inspections[change.inspectionId];
        const source = inspection?.source;
        if (source?.kind === "local") {
          const [locationId] = source.sourceId.split("/");
          for (const componentId of current.packages[inspection!.packageId]?.componentIds ?? []) {
            const key = installationKey(source.sourceMachineId, locationId!, componentId);
            current.drift[`drift:${key}`] = {
              id: `drift:${key}`,
              nodeId: source.sourceMachineId,
              provider: capabilityLocation(locationId!)?.readBy[0] ?? "claude",
              locationId: locationId!,
              componentId,
              packageId: inspection!.packageId,
              name: inspection!.displayName,
              kind: "unmanaged",
              detectedAt: this.now(),
              state: "replaced",
            };
          }
        }
      }
      const now = this.now();
      current.approvals[`approval:${operationId}`] = {
        id: `approval:${operationId}`,
        operationId,
        planDigest: approvedDigest,
        approvedAt: now,
        ...(actor ? { approvedBy: actor } : {}),
      };
      record.state = "applying";
      record.approvedDigest = approvedDigest;
      if (actor) record.approvedBy = actor;
      record.updatedAt = now;
      for (const target of record.targets) {
        if (target.action !== "skip" && target.action !== "keep" && target.status !== "offline")
          target.status = "pending";
      }
      const superseded = supersedeOperations(current, operationId);
      if (requestKey) {
        current.requests[`apply:${requestKey}`] = {
          key: requestKey,
          intentDigest: sha256(`${operationId}:${approvedDigest}`),
          operationId,
          at: now,
        };
      }
      recordActivity(current, {
        ...(actor ? { actor } : {}),
        action: change.kind,
        summary: describeChange(current, change, applied.packageIds),
        packageIds: applied.packageIds,
        setupIds: applied.setupId ? [applied.setupId] : [],
        operationId,
        correlationId: record.correlationId,
      });
      return { result: { record: structuredClone(record), superseded, applied }, changed: true };
    });
    if (change.kind === "import") await this.completeImport(change.importId, actor);
    void this.announce({
      packageIds: result.applied.packageIds,
      setupIds: result.applied.setupId ? [result.applied.setupId] : [],
      operationIds: [operationId, ...result.superseded],
    });
    const nodes = [...new Set(result.record.targets.map((target) => target.target.nodeId))];
    for (const nodeId of nodes) void this.reconciler.reconcileNode(nodeId, "apply");
    if (nodes.length === 0) {
      this.deps.storage.capabilities.mutateCapabilityState((current) => {
        const record = current.operations[operationId];
        if (record && record.state === "applying") record.state = "completed";
        return { result: undefined, changed: true };
      });
    }
    return { operation: operationSnapshot(result.record), replayed: false };
  }

  async cancelOperation(args: Record<string, unknown>) {
    this.assertAuthority();
    const operationId = asText(args.operationId, "operationId");
    const record = this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const operation = state.operations[operationId] as CapabilityOperationRecord | undefined;
      if (!operation) throw new CapabilityError("not-found", "That operation does not exist.");
      if (isTerminalCapabilityOperationState(operation.state))
        return { result: operation, changed: false };
      if (operation.state !== "awaiting-approval" && operation.state !== "planned") {
        throw new CapabilityError(
          "conflict",
          "This change was already approved and will continue applying.",
        );
      }
      operation.state = "cancelled";
      operation.updatedAt = this.now();
      return { result: structuredClone(operation), changed: true };
    });
    void this.announce({
      packageIds: record.packageIds,
      setupIds: [],
      operationIds: [operationId],
    });
    return operationSnapshot(record);
  }

  // --- Setups, assignments, machines ------------------------------------------

  async setSetup(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetup> {
    this.assertAuthority();
    const input = asRecord(args.setup, "setup");
    const expected = optionalNumber(args.expectedRevision);
    const id =
      typeof input.id === "string" && input.id
        ? input.id
        : `toolkit-${randomBytes(5).toString("hex")}`;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
      throw new CapabilityError("invalid-request", "Not a valid setup id.");
    const name = asText(input.name, "name", CAPABILITY_LIMITS.maxNameChars).trim();
    const selectors = (key: string) =>
      stringList(input[key], CAPABILITY_LIMITS.maxSelectorsPerSetup, isCapabilitySelector);
    const setup = this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const existing = state.setups[id];
      if (existing && expected !== existing.revision) {
        throw new CapabilityError(
          "conflict",
          "Someone else changed this setup; reload it and try again.",
        );
      }
      if (!existing && expected !== undefined && expected !== 0) {
        throw new CapabilityError("conflict", "That setup no longer exists.");
      }
      if (!existing && Object.keys(state.setups).length >= CAPABILITY_LIMITS.maxSetups) {
        throw new CapabilityError("too-large", "There are too many setups.");
      }
      const parents = stringList(
        input.parentSetupIds,
        CAPABILITY_LIMITS.maxParentSetups,
        (parent) => parent !== id && Boolean(state.setups[parent]),
      );
      const selections =
        input.packageSelections === undefined
          ? (existing?.packageSelections ?? [])
          : parseSelections(input.packageSelections);
      for (const selection of selections) {
        if (!state.packages[selection.packageId])
          throw new CapabilityError("invalid-request", "A selected package is not in the library.");
      }
      const updatePolicy = (CAPABILITY_UPDATE_POLICIES as readonly unknown[]).includes(
        input.updatePolicy,
      )
        ? (input.updatePolicy as CapabilityUpdatePolicy)
        : (existing?.updatePolicy ?? "approve");
      const next: CapabilitySetup = {
        id,
        name: existing?.builtIn ? existing.name : name,
        ...(typeof input.description === "string"
          ? { description: input.description.slice(0, 500) }
          : existing?.description
            ? { description: existing.description }
            : {}),
        ...(existing?.builtIn ? { builtIn: true } : {}),
        revision: (existing?.revision ?? 0) + 1,
        packageSelections: selections,
        providerSelectors:
          input.providerSelectors === undefined
            ? (existing?.providerSelectors ?? [])
            : selectors("providerSelectors"),
        machineSelectors:
          input.machineSelectors === undefined
            ? (existing?.machineSelectors ?? [])
            : selectors("machineSelectors"),
        ...(input.targetSelectors !== undefined
          ? { targetSelectors: selectors("targetSelectors") }
          : existing?.targetSelectors
            ? { targetSelectors: existing.targetSelectors }
            : {}),
        exclusions:
          input.exclusions === undefined
            ? (existing?.exclusions ?? [])
            : stringList(input.exclusions, CAPABILITY_LIMITS.maxExclusionsPerSetup),
        parentSetupIds:
          input.parentSetupIds === undefined ? (existing?.parentSetupIds ?? []) : parents,
        updatePolicy,
        updatedAt: this.now(),
        ...(actor ? { updatedBy: actor } : {}),
      };
      state.setups[id] = next;
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: existing ? "update-setup" : "create-setup",
        summary: `${existing ? "Changed" : "Created"} ${next.name}.`,
        packageIds: [],
        setupIds: [id],
        correlationId: newCorrelationId(),
      });
      return { result: next, changed: true };
    });
    void this.announce({ packageIds: [], setupIds: [id], operationIds: [] });
    void this.reconciler.reconcileAll("setup-changed");
    return setup;
  }

  async deleteSetup(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetupList> {
    this.assertAuthority();
    const setupId = asText(args.setupId, "setupId");
    const expected = optionalNumber(args.expectedRevision);
    this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const setup = state.setups[setupId];
      if (!setup) throw new CapabilityError("not-found", "That setup does not exist.");
      if (setup.builtIn)
        throw new CapabilityError("invalid-request", "My setup cannot be deleted.");
      if (expected !== setup.revision)
        throw new CapabilityError("conflict", "Someone else changed this setup; reload it.");
      delete state.setups[setupId];
      for (const other of Object.values(state.setups)) {
        other.parentSetupIds = other.parentSetupIds.filter((parent) => parent !== setupId);
      }
      for (const assignment of Object.values(state.assignments)) {
        assignment.setupIds = assignment.setupIds.filter((id) => id !== setupId);
      }
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: "delete-setup",
        summary: `Deleted ${setup.name}.`,
        packageIds: [],
        setupIds: [setupId],
        correlationId: newCorrelationId(),
      });
      return { result: undefined, changed: true };
    });
    void this.announce({ packageIds: [], setupIds: [setupId], operationIds: [] });
    void this.reconciler.reconcileAll("setup-deleted");
    return this.listSetups();
  }

  async assignSetup(args: Record<string, unknown>, actor?: string) {
    const rawScope = args.scope;
    if (
      rawScope !== "project" &&
      rawScope !== "environment" &&
      rawScope !== "template" &&
      rawScope !== "graph-node" &&
      rawScope !== "session"
    ) {
      throw new CapabilityError("invalid-request", "Choose what the setups are for.");
    }
    const scope: "project" | "environment" | "template" | "graph-node" | "session" = rawScope;
    if (!this.deps.isAuthority()) this.assertAuthority();
    const scopeId = asText(args.scopeId, "scopeId");
    const expected = optionalNumber(args.expectedRevision);
    const assignment = this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const id = `${scope}:${scopeId}`;
      const existing = state.assignments[id];
      if (existing && expected !== undefined && expected !== existing.revision) {
        throw new CapabilityError("conflict", "The selection changed elsewhere; reload it.");
      }
      const setupIds = stringList(args.setupIds, 16, (setupId) => Boolean(state.setups[setupId]));
      if (setupIds.length === 0) {
        if (!existing) return { result: null, changed: false };
        delete state.assignments[id];
        return { result: null, changed: true };
      }
      const next = {
        id,
        scope,
        scopeId,
        setupIds,
        revision: (existing?.revision ?? 0) + 1,
        updatedAt: this.now(),
      };
      state.assignments[id] = next;
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: "assign",
        summary: `${scope} uses ${setupIds.map((setupId) => state.setups[setupId]?.name ?? setupId).join(" + ")}.`,
        packageIds: [],
        setupIds,
        correlationId: newCorrelationId(),
      });
      return { result: next, changed: true };
    });
    void this.announce({ packageIds: [], setupIds: assignment?.setupIds ?? [], operationIds: [] });
    void this.reconciler.reconcileAll("assignment-changed");
    return assignment ?? { id: `${scope}:${scopeId}`, scope, scopeId, setupIds: [], revision: 0 };
  }

  async manageException(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetup> {
    this.assertAuthority();
    const setupId = asText(args.setupId, "setupId");
    const exception = asText(args.exception, "exception", 900);
    const action = args.action === "remove" ? "remove" : "add";
    const bar = exception.indexOf("|");
    if (bar > 0 && !isCapabilitySelector(exception.slice(0, bar))) {
      throw new CapabilityError(
        "invalid-request",
        "The exception's target is not a valid selector.",
      );
    }
    const expected = optionalNumber(args.expectedRevision);
    const setup = this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const current = state.setups[setupId];
      if (!current) throw new CapabilityError("not-found", "That setup does not exist.");
      if (expected !== undefined && expected !== current.revision) {
        throw new CapabilityError("conflict", "Someone else changed this setup; reload it.");
      }
      const set = new Set(current.exclusions);
      if (action === "add") set.add(exception);
      else set.delete(exception);
      current.exclusions = [...set].slice(0, CAPABILITY_LIMITS.maxExclusionsPerSetup);
      current.revision += 1;
      current.updatedAt = this.now();
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: action === "add" ? "add-exception" : "remove-exception",
        summary: `${action === "add" ? "Added" : "Removed"} an exception in ${current.name}.`,
        packageIds: [],
        setupIds: [setupId],
        correlationId: newCorrelationId(),
      });
      return { result: structuredClone(current), changed: true };
    });
    void this.announce({ packageIds: [], setupIds: [setupId], operationIds: [] });
    void this.reconciler.reconcileAll("exception-changed");
    return setup;
  }

  async setMachineEnrollment(args: Record<string, unknown>, actor?: string) {
    this.assertAuthority();
    const nodeId = asText(args.nodeId, "nodeId");
    const enrolled = args.enrolled === undefined ? undefined : args.enrolled === true;
    const groups =
      args.groups === undefined
        ? undefined
        : stringList(args.groups, 16, (group) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(group));
    this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const machine = (state.machines[nodeId] ??= {
        nodeId,
        enrolled: state.settings.enrollNewMachines,
        groups: [],
      });
      if (enrolled !== undefined) machine.enrolled = enrolled;
      if (groups !== undefined) machine.groups = groups;
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: "machine",
        summary: `${machine.enrolled ? "Enrolled" : "Unenrolled"} ${nodeId}${machine.groups.length ? ` (${machine.groups.join(", ")})` : ""}.`,
        packageIds: [],
        setupIds: [],
        correlationId: newCorrelationId(),
      });
      return { result: undefined, changed: true };
    });
    void this.announce({ packageIds: [], setupIds: [], operationIds: [] });
    if (enrolled !== false) void this.reconciler.reconcileNode(nodeId, "enrolled");
    const list = await this.listMachines();
    const summary = list.machines.find((machine) => machine.nodeId === nodeId);
    if (!summary) throw new CapabilityError("not-found", "That machine is not known.");
    return summary;
  }

  async setPackageState(args: Record<string, unknown>, actor?: string) {
    this.assertAuthority();
    const packageId = asText(args.packageId, "packageId");
    this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const pkg = state.packages[packageId];
      if (!pkg) throw new CapabilityError("not-found", "That package is not in the library.");
      if (typeof args.pinned === "boolean") pkg.pinned = args.pinned;
      if (typeof args.paused === "boolean") pkg.paused = args.paused;
      pkg.updatedAt = this.now();
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: "package-state",
        summary: `${pkg.displayName}: ${pkg.pinned ? "pinned" : "following updates"}, ${pkg.paused ? "paused" : "active"}.`,
        packageIds: [packageId],
        setupIds: [],
        correlationId: newCorrelationId(),
      });
      return { result: undefined, changed: true };
    });
    void this.announce({ packageIds: [packageId], setupIds: [], operationIds: [] });
    void this.reconciler.reconcileAll("package-state");
    const library = await this.listPackages({});
    const row = library.packages.find((entry) => entry.id === packageId);
    if (!row) throw new CapabilityError("not-found", "That package is not in the library.");
    return row;
  }

  async resolveDrift(args: Record<string, unknown>, actor?: string) {
    this.assertAuthority();
    const driftId = asText(args.driftId, "driftId");
    const decision = args.decision;
    if (decision === "adopt") {
      throw new CapabilityError(
        "approval-required",
        "Preview and approve the local revision before adopting it.",
      );
    }
    if (decision !== "keep-local" && decision !== "replace") {
      throw new CapabilityError("invalid-request", "Choose keep or replace.");
    }
    const entry = this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const drift = state.drift[driftId];
      if (!drift)
        throw new CapabilityError("not-found", "That local change is no longer reported.");
      drift.state = decision === "keep-local" ? "kept-local" : "replaced";
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: `drift-${decision}`,
        summary: `${drift.name} on ${drift.nodeId}: ${decision === "keep-local" ? "kept the local version" : "replaced with the configured revision"}.`,
        packageIds: drift.packageId ? [drift.packageId] : [],
        setupIds: [],
        correlationId: newCorrelationId(),
      });
      return { result: structuredClone(drift), changed: true };
    });
    void this.announce({
      packageIds: entry.packageId ? [entry.packageId] : [],
      setupIds: [],
      operationIds: [],
    });
    if (decision === "replace") void this.reconciler.reconcileNode(entry.nodeId, "drift-replace");
    return entry;
  }

  // --- Updates and rollback ---------------------------------------------------

  async refreshUpdates(args: Record<string, unknown>): Promise<CapabilityUpdateList> {
    this.assertAuthority();
    const only = typeof args.packageId === "string" ? args.packageId : undefined;
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const auto: string[] = [];
    for (const pkg of Object.values(state.packages)) {
      if (only && pkg.id !== only) continue;
      if (pkg.source.kind !== "git") continue;
      try {
        const candidate = await checkPackageUpdate(state, pkg, {
          remoteHead: (target) =>
            remoteGitHead(
              target.source as Extract<PackageSource, { kind: "git" }>,
              this.deps.gitRun,
            ),
          inspect: (target) =>
            inspectGitSource(target.source as Extract<PackageSource, { kind: "git" }>, {
              workRoot: this.deps.dataDir,
              ...(this.deps.gitRun ? { run: this.deps.gitRun } : {}),
            }),
          storeArtifact: async (inspected) => {
            await this.artifacts.put(inspected.files);
            this.deps.storage.capabilities.mutateCapabilityState((current) => {
              current.artifacts[inspected.artifactDigest] ??= {
                digest: inspected.artifactDigest,
                bytes: inspected.files.reduce((total, file) => total + file.bytes, 0),
                files: inspected.files.map((file) => ({
                  path: file.path,
                  bytes: file.bytes,
                  executable: file.executable,
                  sha256: file.sha256,
                })),
                refs: [`update:${pkg.id}`],
                createdAt: this.now(),
              };
              return { result: undefined, changed: true };
            });
          },
          now: () => this.now(),
        });
        if (!candidate) continue;
        this.deps.storage.capabilities.mutateCapabilityState((current) => {
          current.updates[candidate.proposal.id] = candidate.proposal;
          current.inspections[candidate.inspection.id] = candidate.inspection;
          recordActivity(current, {
            action: "update-found",
            summary: `${pkg.displayName}: revision ${candidate.proposal.toRevision.slice(0, 12)} is available.`,
            packageIds: [pkg.id],
            setupIds: [],
            correlationId: newCorrelationId(),
          });
          return { result: undefined, changed: true };
        });
        if (candidate.autoApply) auto.push(candidate.proposal.id);
      } catch (error) {
        log.warn("updates.package-check-failed", {
          error: formatLogError(error, { message: false }),
        });
      }
    }
    this.deps.storage.capabilities.mutateCapabilityState((current) => {
      current.settings.lastUpdateCheckAt = this.now();
      return { result: undefined, changed: true };
    });
    for (const updateId of auto) {
      // Trusted and nothing escalates: preview and apply as the system.
      const current = await this.deps.storage.capabilities.loadCapabilityState();
      const update = current.updates[updateId];
      if (!update) continue;
      const preview = await this.previewParsedChange(
        { kind: "update", packageId: update.packageId, updateId },
        undefined,
        "trusted-auto-update",
      );
      await this.applyChange(
        { operationId: preview.operation.id, approvedDigest: preview.operation.planDigest },
        "trusted-auto-update",
      ).catch(() => undefined);
    }
    void this.announce({ packageIds: [], setupIds: [], operationIds: [] });
    return this.listUpdates();
  }

  async previewUpdate(
    args: Record<string, unknown>,
    actor?: string,
  ): Promise<CapabilityChangeResult> {
    this.assertAuthority();
    const updateId = asText(args.updateId, "updateId");
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const update = state.updates[updateId];
    if (!update) throw new CapabilityError("not-found", "That update is no longer available.");
    if (state.packages[update.packageId]?.pinned) {
      throw new CapabilityError("conflict", "The package is pinned; unpin it to take updates.");
    }
    return this.previewParsedChange(
      { kind: "update", packageId: update.packageId, updateId },
      `update:${updateId}`,
      actor,
    );
  }

  async approveUpdate(
    args: Record<string, unknown>,
    actor?: string,
  ): Promise<CapabilityChangeResult> {
    this.assertAuthority();
    const updateId = asText(args.updateId, "updateId");
    if (args.dismiss === true) {
      const record = this.deps.storage.capabilities.mutateCapabilityState((state) => {
        const update = state.updates[updateId];
        if (!update) throw new CapabilityError("not-found", "That update is no longer available.");
        update.state = "dismissed";
        delete state.inspections[`update:${updateId}`];
        return { result: structuredClone(update), changed: true };
      });
      void this.announce({ packageIds: [record.packageId], setupIds: [], operationIds: [] });
      const now = this.now();
      return {
        operation: {
          id: `dismissed:${updateId}`,
          kind: "update",
          state: "cancelled",
          planDigest: "",
          packageIds: [record.packageId],
          targets: [],
          requiresApproval: false,
          approvalReasons: [],
          summary: { total: 0, byStatus: {} },
          correlationId: newCorrelationId(),
          createdAt: now,
          updatedAt: now,
          ...(actor ? { createdBy: actor } : {}),
        },
        replayed: false,
      };
    }
    const preview = await this.previewUpdate({ updateId }, actor);
    const approvedDigest = asText(args.approvedDigest, "approvedDigest");
    return this.applyChange({ operationId: preview.operation.id, approvedDigest }, actor);
  }

  async setUpdatePolicy(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetup> {
    this.assertAuthority();
    const setupId = asText(args.setupId, "setupId");
    const policy = args.policy;
    if (!(CAPABILITY_UPDATE_POLICIES as readonly unknown[]).includes(policy)) {
      throw new CapabilityError("invalid-request", "Choose approve, trusted-auto or pinned.");
    }
    const trusted =
      args.trustedSources === undefined
        ? undefined
        : stringList(args.trustedSources, 64, (entry) => entry.length >= 6);
    const expected = optionalNumber(args.expectedRevision);
    const setup = this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const current = state.setups[setupId];
      if (!current) throw new CapabilityError("not-found", "That setup does not exist.");
      if (expected !== undefined && expected !== current.revision) {
        throw new CapabilityError("conflict", "Someone else changed this setup; reload it.");
      }
      current.updatePolicy = policy as CapabilityUpdatePolicy;
      current.revision += 1;
      current.updatedAt = this.now();
      if (trusted) state.settings.trustedSources = trusted;
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: "update-policy",
        summary: `${current.name}: updates ${policy === "approve" ? "need approval" : policy === "pinned" ? "are off (pinned)" : "from trusted sources apply automatically unless they add risk"}.`,
        packageIds: [],
        setupIds: [setupId],
        correlationId: newCorrelationId(),
      });
      return { result: structuredClone(current), changed: true };
    });
    void this.announce({ packageIds: [], setupIds: [setupId], operationIds: [] });
    return setup;
  }

  async rollbackPackage(
    args: Record<string, unknown>,
    actor?: string,
  ): Promise<CapabilityChangeResult> {
    this.assertAuthority();
    const packageId = asText(args.packageId, "packageId");
    const toRevision = asText(args.toRevision, "toRevision");
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const pkg = state.packages[packageId];
    const previous = pkg?.previousRevisions?.find(
      (entry) => entry.revision === toRevision || entry.artifactDigest === toRevision,
    );
    if (!pkg || !previous)
      throw new CapabilityError("not-found", "That revision is not kept for rollback.");
    const files = await this.artifacts.get(previous.artifactDigest);
    const inspected = inspectFiles(pkg.source, files, { revision: previous.revision });
    const id = `rollback:${packageId}:${previous.artifactDigest}`;
    this.deps.storage.capabilities.mutateCapabilityState((current) => {
      current.inspections[id] = {
        id,
        source: pkg.source,
        packageId,
        displayName: pkg.displayName,
        revision: previous.revision,
        artifactDigest: previous.artifactDigest,
        components: inspected.components,
        createdAt: this.now(),
        expiresAt: new Date(Date.parse(this.now()) + INSPECTION_TTL_MS).toISOString(),
      };
      return { result: undefined, changed: true };
    });
    return this.previewParsedChange(
      { kind: "rollback", packageId, toRevision },
      typeof args.requestKey === "string" ? args.requestKey : undefined,
      actor,
    );
  }

  // --- Import, export, verification -----------------------------------------

  async exportSetup(args: Record<string, unknown>): Promise<CapabilityExport> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const setupIds = stringList(args.setupIds, 64);
    const exported = exportSetups(state, setupIds.length > 0 ? setupIds : [MY_SETUP_ID]);
    let written = false;
    if (args.write === true) {
      this.assertAuthority();
      const projectId = asText(args.projectId, "projectId");
      const project = await this.deps.storage.getProject?.(projectId);
      if (!project?.localPath)
        throw new CapabilityError(
          "not-found",
          "The project has no local checkout on this machine.",
        );
      await writeProjectManifests(project.localPath, exported);
      written = true;
    }
    return {
      intentFile: "orkestrator.capabilities.yaml",
      intent: exported.intentText,
      lockFile: "orkestrator.capabilities.lock.json",
      lock: exported.lockText,
      ...(written ? { written } : {}),
    };
  }

  async previewImport(args: Record<string, unknown>): Promise<CapabilityImportPreview> {
    this.assertAuthority();
    let intentText: string;
    let lockText: string;
    const projectId = typeof args.projectId === "string" ? args.projectId : undefined;
    if (typeof args.intent === "string" && typeof args.lock === "string") {
      intentText = args.intent;
      lockText = args.lock;
    } else if (projectId) {
      const project = await this.deps.storage.getProject?.(projectId);
      if (!project?.localPath)
        throw new CapabilityError(
          "not-found",
          "The project has no local checkout on this machine.",
        );
      ({ intent: intentText, lock: lockText } = await readProjectManifests(project.localPath));
    } else {
      throw new CapabilityError(
        "invalid-request",
        "Provide the manifest and lockfile, or a project.",
      );
    }
    const parsed = parseManifests(intentText, lockText);
    const previewId = `imp_${randomBytes(8).toString("hex")}`;
    if (!parsed.intent || !parsed.lock) {
      return {
        previewId,
        issues: parsed.issues,
        setups: [],
        packages: [],
        approvalReasons: [],
        valid: false,
      };
    }
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const plan = planImport(state, parsed.intent, parsed.lock);
    const approvalReasons: string[] = [];
    const issues = [...parsed.issues];
    if (issues.length === 0 && plan.packages.every((entry) => entry.action !== "conflict")) {
      for (const entry of parsed.lock.packages) {
        try {
          const inspected = await this.inspectLockedArtifact(entry);
          approvalReasons.push(...capabilityInstallApproval(inspected.components).reasons);
          await this.artifacts.put(inspected.files);
        } catch (error) {
          if (!(error instanceof CapabilityError)) throw error;
          issues.push({ path: "packages", message: error.message });
        }
      }
    }
    const valid =
      issues.length === 0 && plan.packages.every((entry) => entry.action !== "conflict");
    if (valid) {
      this.deps.storage.capabilities.mutateCapabilityState((current) => {
        current.imports[previewId] = {
          id: previewId,
          digest: this.importBasis(state, parsed.lock!, projectId),
          verified: true,
          intent: parsed.intent,
          lock: parsed.lock,
          ...(projectId ? { projectId } : {}),
          createdAt: this.now(),
        };
        return { result: undefined, changed: true };
      });
    }
    return { previewId, issues, ...plan, approvalReasons: [...new Set(approvalReasons)], valid };
  }

  private importBasis(
    state: CapabilityState,
    lock: NonNullable<ReturnType<typeof parseManifests>["lock"]>,
    projectId?: string,
  ) {
    return sha256(
      canonicalCapabilityJson({
        packages: lock.packages.map((entry) => state.packages[entry.id] ?? null),
        setups: state.setups,
        assignment: projectId ? (state.assignments[`project:${projectId}`] ?? null) : null,
      }),
    );
  }

  private async inspectLockedArtifact(
    entry: NonNullable<ReturnType<typeof parseManifests>["lock"]>["packages"][number],
    cachedOnly = false,
  ): Promise<InspectedPackage> {
    let inspected: InspectedPackage;
    if (entry.source.kind === "provider-marketplace") {
      throw new CapabilityError(
        "unsupported",
        "Marketplace plugin imports require verified immutable content.",
      );
    }
    if (await this.artifacts.has(entry.artifactDigest)) {
      inspected = inspectFiles(entry.source, await this.artifacts.get(entry.artifactDigest), {
        revision: entry.revision,
      });
    } else if (!cachedOnly && entry.source.kind === "git") {
      inspected = await inspectGitSource(
        { ...entry.source, channel: entry.revision },
        { workRoot: this.deps.dataDir, ...(this.deps.gitRun ? { run: this.deps.gitRun } : {}) },
      );
      // The immutable fetch ref is distinct from the package's update channel.
      inspected.source = entry.source;
    } else {
      throw new CapabilityError(
        "source-unavailable",
        "A locked artifact is unavailable on this machine.",
      );
    }
    if (inspected.secretsFound.length > 0) {
      throw new CapabilityError("secrets-detected", "A locked artifact contains a credential.");
    }
    if (
      inspected.artifactDigest !== entry.artifactDigest ||
      inspected.revision !== entry.revision
    ) {
      throw new CapabilityError(
        "unsafe-content",
        "A locked artifact does not match the approved revision and digest.",
      );
    }
    const componentInventory = (components: typeof entry.components) =>
      components.map(({ id, kind, pathOrKey }) => JSON.stringify([id, kind, pathOrKey])).sort();
    if (
      canonicalCapabilityJson(componentInventory(inspected.components)) !==
      canonicalCapabilityJson(componentInventory(entry.components))
    ) {
      throw new CapabilityError(
        "unsafe-content",
        "The lockfile component inventory differs from the inspected artifact.",
      );
    }
    return inspected;
  }

  async importSetup(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetupList> {
    this.assertAuthority();
    const previewId = asText(args.previewId, "previewId");
    await this.completeImport(previewId, actor);
    void this.reconciler.reconcileAll("import");
    return this.listSetups();
  }

  /**
   * Fetches every locked package not already in the library at its exact
   * revision, checks the digest against the lockfile, then creates or
   * updates the setups. A digest mismatch fails the whole import; nothing is
   * half-created.
   */
  private async completeImport(previewId: string, actor?: string): Promise<void> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const record = state.imports[previewId];
    if (!record?.verified)
      throw new CapabilityError(
        "conflict",
        "The import preview expired or is invalid; preview it again.",
      );
    const intent = record.intent as NonNullable<ReturnType<typeof parseManifests>["intent"]>;
    const lock = record.lock as NonNullable<ReturnType<typeof parseManifests>["lock"]>;
    const fetched: InspectedPackage[] = [];
    for (const entry of lock.packages) {
      if (state.packages[entry.id]?.artifactDigest !== entry.artifactDigest) {
        fetched.push(await this.inspectLockedArtifact(entry, true));
      }
    }
    this.deps.storage.capabilities.mutateCapabilityState((current) => {
      if (
        current.imports[previewId]?.digest !== record.digest ||
        this.importBasis(current, lock, record.projectId) !== record.digest ||
        planImport(current, intent, lock).packages.some((entry) => entry.action === "conflict")
      ) {
        throw new CapabilityError(
          "conflict",
          "The library changed after this preview; review the import again.",
        );
      }
      const now = this.now();
      for (const inspected of fetched) {
        for (const component of inspected.components) current.components[component.id] = component;
        current.packages[inspected.packageId] = {
          id: inspected.packageId,
          source: inspected.source,
          displayName: inspected.displayName,
          ...(inspected.description ? { description: inspected.description } : {}),
          revision: inspected.revision,
          artifactDigest: inspected.artifactDigest,
          componentIds: inspected.components.map((component) => component.id),
          provenance: record.projectId ? "project" : "managed",
          risk: inspected.risk,
          ...(inspected.publisher ? { publisher: inspected.publisher } : {}),
          previousRevisions: [],
          createdAt: now,
          updatedAt: now,
        };
        current.artifacts[inspected.artifactDigest] ??= {
          digest: inspected.artifactDigest,
          bytes: inspected.files.reduce((total, file) => total + file.bytes, 0),
          files: inspected.files.map((file) => ({
            path: file.path,
            bytes: file.bytes,
            executable: file.executable,
            sha256: file.sha256,
          })),
          refs: [`package:${inspected.packageId}@${inspected.revision}`],
          createdAt: now,
        };
      }
      const bySlug = record.projectId
        ? new Map(
            Object.keys(intent.setups).map((slug) => [
              slug,
              `project-toolkit-${sha256(`${record.projectId}\0${slug}`).slice(-32)}`,
            ]),
          )
        : new Map(
            Object.values(current.setups)
              .filter((setup) => !setup.id.startsWith("project-toolkit-"))
              .map((setup) => [setupSlug(setup), setup.id]),
          );
      for (const [slug, setupIntent] of Object.entries(intent.setups)) {
        const id =
          bySlug.get(slug) ?? (slug === MY_SETUP_ID ? MY_SETUP_ID : `toolkit-${slug}`.slice(0, 64));
        const existing = current.setups[id];
        const selections: CapabilityPackageSelection[] = setupIntent.packages.map((entry) => ({
          packageId: capabilityPackageId(entry.source),
          version: entry.revision ?? "latest",
          ...(entry.components ? { components: entry.components } : {}),
          ...(entry.required ? { required: true } : {}),
        }));
        current.setups[id] = {
          id,
          name:
            existing?.name ??
            slug.replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase()),
          ...(setupIntent.description ? { description: setupIntent.description } : {}),
          ...(existing?.builtIn ? { builtIn: true } : {}),
          revision: (existing?.revision ?? 0) + 1,
          packageSelections: selections,
          providerSelectors: (setupIntent.providers ?? []).map(
            (provider: AgentPlatform) => `provider:${provider}`,
          ),
          machineSelectors: (setupIntent.machines ?? []).map((machine: string) =>
            machine === "*" ? "*" : `group:${machine}`,
          ),
          ...(record.projectId ? { targetSelectors: [`project:${record.projectId}`] } : {}),
          exclusions: setupIntent.exclusions ?? [],
          parentSetupIds: (setupIntent.parents ?? [])
            .map((parent: string) => bySlug.get(parent) ?? `toolkit-${parent}`)
            .filter((parent: string) => parent !== id),
          updatePolicy: setupIntent.updatePolicy ?? "approve",
          updatedAt: now,
          ...(actor ? { updatedBy: actor } : {}),
        };
        if (record.projectId) {
          const assignmentId = `project:${record.projectId}`;
          const assignment = current.assignments[assignmentId];
          current.assignments[assignmentId] = {
            id: assignmentId,
            scope: "project",
            scopeId: record.projectId,
            setupIds: [...new Set([...(assignment?.setupIds ?? []), id])].slice(0, 16),
            revision: (assignment?.revision ?? 0) + 1,
            updatedAt: now,
          };
        }
      }
      delete current.imports[previewId];
      recordActivity(current, {
        ...(actor ? { actor } : {}),
        action: "import",
        summary: `Imported ${Object.keys(intent.setups).length} setup(s) and ${fetched.length} package(s).`,
        packageIds: fetched.map((entry) => entry.packageId),
        setupIds: [],
        correlationId: newCorrelationId(),
      });
      return { result: undefined, changed: true };
    });
  }

  /**
   * Non-destructive checks with the user's consent: re-reads the machine's
   * inventory and confirms each component's bytes at its location. It never
   * starts an MCP server, runs a script or touches a session.
   */
  async verify(args: Record<string, unknown>): Promise<CapabilityVerification> {
    if (args.consent !== true) {
      throw new CapabilityError(
        "approval-required",
        "Testing reads the machine's configuration; confirm to continue.",
      );
    }
    const target = parseTarget(args.target, await this.deps.selfId());
    const componentIds = stringList(args.componentIds, 200);
    const inventory = await this.observeNode(target.nodeId);
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const checks: CapabilityVerification["checks"] = [];
    for (const componentId of componentIds) {
      const receipts = Object.values(state.receipts).filter(
        (receipt) =>
          receipt.nodeId === target.nodeId &&
          receipt.componentId === componentId &&
          receipt.providers.includes(target.provider),
      );
      if (receipts.length === 0) {
        checks.push({
          componentId,
          level: "requested",
          status: "pending",
          detail: "Not installed for this agent on this machine yet.",
        });
        continue;
      }
      for (const receipt of receipts) {
        const item = inventory?.items.find(
          (entry) => entry.componentId === componentId && entry.locationId === receipt.locationId,
        );
        const effective = effectiveReceiptStatus(receipt);
        const matches = item && !item.drifted && item.digest === receipt.digest;
        const fileKind =
          !receipt.locationId.startsWith("mcp:") && !receipt.locationId.startsWith("plugin:");
        checks.push({
          componentId,
          level: effective.verification,
          status:
            !matches &&
            (effective.status === "ready" || effective.status === "installed-next-session")
              ? "drifted"
              : effective.status,
          detail: fileKind
            ? item
              ? !matches
                ? "The files are present but have local changes."
                : effective.verification === "unverified"
                  ? "The files are present. This agent reports no live inventory, so loading cannot be confirmed until it is used."
                  : "The files are present and match the installed revision."
              : "The files are missing from the machine."
            : matches
              ? "The managed definition matches the recorded revision."
              : "The managed definition could not be verified.",
        });
      }
    }
    return { target, checks, verifiedAt: this.now() };
  }

  /**
   * Launch preflight for a native agent session: resolves the frozen
   * effective manifest. A required component that is missing, unsupported or
   * blocked stops the launch with the reason; optional ones are warnings.
   */
  async preflightLaunch(input: {
    target: CapabilityTarget;
    sessionKey: string;
    ceiling: CapabilityPermissionCeiling;
    templateId?: string;
    graphNode?: string;
  }): Promise<EffectiveAgentResources> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const hasRequired = Object.values(state.setups).some((setup) =>
      setup.packageSelections.some(({ required }) => required === true),
    );
    const launchInventory = hasRequired
      ? await this.observeNode(input.target.nodeId).catch(() => undefined)
      : undefined;
    return this.resolveFor(state, {
      target: input.target,
      forLaunch: true,
      ...(launchInventory ? { launchInventory } : {}),
      sessionKey: input.sessionKey,
      ...(input.templateId ? { templateId: input.templateId } : {}),
      ...(input.graphNode ? { graphNode: input.graphNode } : {}),
      ceiling: input.ceiling,
    });
  }

  /**
   * The native-session and graph launch hook. Resolves resources under the
   * launch policy, blocks unverified required delivery, and records the
   * selected revision digest for diagnostics. Provider homes stay shared.
   */
  async preflightSession(input: {
    environmentId: string;
    projectId?: string;
    environmentIncarnation?: string;
    accountHomeId?: string;
    templateId?: string;
    graphNode?: string;
    provider: AgentPlatform;
    sessionKey: string;
    policy?: Parameters<typeof nativeAgentDeniedCapabilities>[0];
  }): Promise<EffectiveAgentResources | null> {
    let effective: EffectiveAgentResources;
    try {
      const denied = nativeAgentDeniedCapabilities(input.policy);
      const grant = nativeAgentUserMcpGrant(input.policy);
      const ceiling: CapabilityPermissionCeiling = {
        denied,
        userMcpServers: grant ?? null,
        digest: sha256(
          canonicalCapabilityJson({ denied: [...denied].sort(), grant: grant ?? null }),
        ),
      };
      effective = await this.preflightLaunch({
        target: {
          nodeId: await this.deps.selfId(),
          provider: input.provider,
          environmentId: input.environmentId,
          ...(input.environmentIncarnation
            ? { environmentIncarnation: input.environmentIncarnation }
            : {}),
          ...(input.accountHomeId ? { accountHomeId: input.accountHomeId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          sessionId: input.sessionKey,
        },
        sessionKey: input.sessionKey,
        ...(input.templateId ? { templateId: input.templateId } : {}),
        ...(input.graphNode ? { graphNode: input.graphNode } : {}),
        ceiling,
      });
    } catch (error) {
      log.warn("service.preflight-failed", { error: formatLogError(error, { message: false }) });
      return null;
    }
    if (effective.launchBlockers.length > 0) {
      const first = effective.launchBlockers[0]!;
      throw new CapabilityError(
        "approval-required",
        `This session's setups require a capability it cannot have: ${first.reason} Change the session's setups in Capabilities, or mark the component optional.`,
      );
    }
    try {
      this.deps.storage.capabilities.mutateCapabilityState((state) => {
        state.launches[input.sessionKey] = {
          sessionKey: input.sessionKey,
          target: effective.target,
          manifestDigest: effective.manifestDigest,
          permissionPolicyDigest: effective.permissionPolicyDigest,
          packages: effective.resolvedPackages.map((entry) => ({
            id: entry.id,
            artifactDigest: entry.artifactDigest,
          })),
          launchedAt: this.now(),
        };
        return { result: undefined, changed: true };
      });
    } catch (error) {
      log.warn("service.preflight-failed", { error: formatLogError(error, { message: false }) });
    }
    return effective;
  }

  // --- Executor (this machine, called by its command node) --------------------

  async executorObserve(args: Record<string, unknown>): Promise<CapabilityInventory> {
    this.executor.admitEpoch(asText(args.controllerId, "controllerId"), Number(args.epoch));
    return this.observeSelf();
  }

  async executorStage(
    args: Record<string, unknown>,
  ): Promise<{ complete: boolean; missing: number[] }> {
    this.executor.admitEpoch(asText(args.controllerId, "controllerId"), Number(args.epoch));
    const data = typeof args.data === "string" ? args.data : "";
    return this.artifacts.stageChunk(
      asText(args.digest, "digest"),
      Number(args.index),
      Number(args.count),
      data,
    );
  }

  async executorApply(args: Record<string, unknown>): Promise<{ results: unknown[] }> {
    this.executor.admitEpoch(asText(args.controllerId, "controllerId"), Number(args.epoch));
    const targets = parseNodePlanTargets(args.targets);
    return { results: await this.executor.apply(targets) };
  }

  async executorExportItem(
    args: Record<string, unknown>,
  ): Promise<{ files: Array<{ path: string; executable: boolean; data: string }> }> {
    this.executor.admitEpoch(asText(args.controllerId, "controllerId"), Number(args.epoch));
    const files = await this.exportLocalItem(asText(args.itemId, "itemId"));
    assertDistributableArtifact(files);
    return {
      files: files.map((file) => ({
        path: file.path,
        executable: file.executable,
        data: file.content.toString("base64"),
      })),
    };
  }
}

/** A Claude marketplace plugin: its contents resolve inside Claude at install time. */
function inspectMarketplacePlugin(
  source: Extract<PackageSource, { kind: "provider-marketplace" }>,
  files: PackageFile[],
): InspectedPackage {
  const withHashes = files.map((file) => ({
    ...file,
    sha256: createHash("sha256").update(file.content).digest("hex"),
  }));
  const packageId = capabilityPackageId(source);
  const name =
    source.qualifiedId.slice(0, source.qualifiedId.lastIndexOf("@")) || source.qualifiedId;
  const artifactDigest = treeDigest(withHashes);
  return {
    source,
    packageId,
    displayName: name,
    description: `Claude plugin from the ${source.qualifiedId.slice(source.qualifiedId.lastIndexOf("@") + 1)} marketplace.`,
    revision: "marketplace",
    artifactDigest,
    components: [
      {
        id: `${packageId}#native-plugin:claude:${name}`,
        packageId,
        kind: "native-plugin",
        pathOrKey: source.qualifiedId,
        name,
        dependencies: [],
        providerHints: ["claude"],
        requirements: {},
        // Unknown until Claude resolves it: treat it as able to run programs.
        risk: "executable",
      },
    ],
    files: withHashes,
    risk: "executable",
    warnings: [
      "Claude resolves this plugin's contents from its marketplace at install time, so Orkestrator cannot show its hooks or commands beforehand.",
    ],
    secretsFound: [],
  };
}

function describeChange(
  state: CapabilityState,
  change: CapabilityChange,
  packageIds: string[],
): string {
  const names = packageIds.map((id) => state.packages[id]?.displayName ?? id).join(", ");
  switch (change.kind) {
    case "add-to-setup":
      return `Added ${names} to ${state.setups[change.setupId]?.name ?? change.setupId}.`;
    case "remove-from-setup":
      return `Removed ${names} from ${state.setups[change.setupId]?.name ?? change.setupId}.`;
    case "update":
      return `Updated ${names}.`;
    case "rollback":
      return `Rolled ${names} back to ${change.toRevision.slice(0, 12)}.`;
    case "adopt":
      return `Adopted ${names}.`;
    case "import":
      return "Imported setups.";
    case "reconcile":
      return "Reconciled machines.";
  }
}
