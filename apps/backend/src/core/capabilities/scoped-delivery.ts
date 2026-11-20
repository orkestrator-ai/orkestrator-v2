/**
 * Scoped deliveries on this machine
 * (docs/architecture/agent-capabilities-management.md, "Shared locations and
 * isolation" and "Runtime connection points").
 *
 * The machine-wide reconciler writes into the provider homes every session
 * reads. Two kinds of target need their own copies instead:
 *
 * - **Project setups** (project and environment assignments, including
 *   imports from `orkestrator.capabilities.yaml`) are written into each local
 *   worktree of that project, in the directories providers read from the
 *   checkout (`scoped-locations.ts`). Receipts are keyed by environment, the
 *   paths are listed in the repository's `info/exclude` and a path the
 *   repository tracks, or anything already there that Orkestrator did not
 *   write, is a collision that is reported and left alone (`project-git.ts`).
 * - **Added Claude and Codex accounts** link their skill and command
 *   directories to the host's (`agent-accounts/homes.ts`), so the host copy
 *   serves them. A CLI that saved a directory by atomic rename leaves a
 *   private copy instead; that account then gets its own copy of the
 *   machine-wide installations, with its own receipts. Only package files
 *   are written; nothing is read from or copied into the account's login.
 *
 * Both reuse the executor's ownership rules (markers, location indexes,
 * atomic writes, drift kept until the user decides). The pass runs after the
 * machine's own reconcile pass and before a launch from a local worktree.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { parseGraphBranchWorktreePath } from "@orkestrator/protocol/graphs/run";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type {
  CapabilityComponent,
  CapabilityTarget,
  CapabilityTargetStatus,
  EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import { capabilityRevisionComponents } from "@orkestrator/protocol/capability-resources-resolve";
import {
  capabilityLocation,
  type CapabilityLocation,
} from "@orkestrator/protocol/capability-resources-support";

import type { CapabilityArtifactStore } from "./artifact-store.js";
import {
  CapabilityExecutor,
  componentFiles,
  type McpInstaller,
  type NodePlanResult,
  type NodePlanTarget,
} from "./executor.js";
import {
  installedComponentFiles,
  installName,
  installedDigest,
  readLocationIndex,
  readMarker,
  type CapabilityHomes,
} from "./native-ownership.js";
import { desiredStateForNode, type NodeDesiredState } from "./planning.js";
import {
  defaultGitRunner,
  gitCommonDir,
  linkedAncestor,
  syncGraphWorktreeExclude,
  type GitRunner,
} from "./project-git.js";
import {
  observeProjectMcpEntries,
  projectMcpExcludeFiles,
  projectMcpInstaller,
} from "./project-mcp.js";
import { OutcomeUnknownError } from "./reconciler.js";
import {
  alsoVisibleAt,
  PROJECT_CAPABILITY_LOCATIONS,
  planScopedLocations,
  projectCapabilityLocation,
  projectMcpLocation,
  projectMcpLocationFor,
  type ProjectMcpLocation,
} from "./scoped-locations.js";
import {
  CAPABILITY_MARKER_FILE,
  confinedPath,
  recoverDirectoryReplacement,
  treeDigest,
} from "./security.js";
import type { CapabilitiesStorage } from "../storage-capabilities.js";
import {
  dropEmptyIndexes,
  managedLocationEntries,
  worktreeEntryPath,
  projectLocator,
  syncWorktreeExclude,
  worktreeCollisions,
  type WorktreeEntry,
} from "./worktree-writer.js";
import { updateOperationTargets } from "./operations.js";
import type { CapabilityLaunchDelivery, CapabilityState, InstallationReceipt } from "./types.js";

const log = createLogger("capabilities");

/** A local or container environment, as far as delivery needs it. */
export interface ScopedEnvironment {
  id: string;
  name?: string;
  projectId: string;
  environmentType: string;
  worktreePath?: string | null;
  containerId?: string | null;
}

/** An added (non-default) Claude or Codex account on this machine. */
export interface ScopedAccount {
  provider: "claude" | "codex";
  accountId: string;
  home: string;
}

/** What this machine knows about its worktrees, accounts and containers. */
export interface ScopedTargetSources {
  /** Live admission for a worktree or an added account home. */
  writeHeld?(scope: { environmentId?: string; account?: ScopedAccount }): Promise<boolean>;
  /** This machine's environments; absent where the backend has none. */
  environments?(): Promise<ScopedEnvironment[]>;
  /** This machine's added accounts. */
  accounts?(): Promise<ScopedAccount[]>;
  /** The capability record of the container an environment runs now (`container-staging.ts`). */
  containerDelivery?(environmentId: string): Promise<ContainerDeliveryEvidence | null>;
  /** MCP management for one environment's project MCP files (`project-mcp.ts`). */
  projectMcp?(environmentId: string): McpInstaller | undefined;
  git?: GitRunner;
}

export interface ScopedDeliveryDeps extends ScopedTargetSources {
  storage: { capabilities: CapabilitiesStorage };
  artifacts: CapabilityArtifactStore;
  selfId(): Promise<string>;
  homes(): CapabilityHomes;
  /** The service's own resolution for one target, under no permission ceiling. */
  resolve(state: CapabilityState, target: CapabilityTarget): EffectiveAgentResources;
  now?: () => string;
  /** Tells clients something changed (receipts, drift). */
  changed?(): void;
}

/** One copy a scoped target should have. */
export interface ScopedInstallation {
  key: string;
  nodeId: string;
  locationId: string;
  componentId: string;
  packageId: string;
  digest: string;
  providers: AgentPlatform[];
  alsoVisibleTo: AgentPlatform[];
  references: string[];
}

export interface ScopedUndeliverable {
  provider: AgentPlatform;
  componentId: string;
  packageId: string;
  status: CapabilityTargetStatus;
  reason: string;
}

export function projectReceiptKey(
  nodeId: string,
  environmentId: string,
  locationId: string,
  componentId: string,
): string {
  return `${nodeId}|env:${environmentId}|${locationId}|${componentId}`;
}

export function accountReceiptKey(
  nodeId: string,
  provider: AgentPlatform,
  accountId: string,
  locationId: string,
  componentId: string,
): string {
  return `${nodeId}|account:${provider}:${accountId}|${locationId}|${componentId}`;
}

/** A component of the revision a receipt or installation names. */
export function revisionComponent(
  state: CapabilityState,
  packageId: string,
  componentId: string,
  digest: string,
): CapabilityComponent | undefined {
  const pkg = state.packages[packageId];
  if (!pkg) return undefined;
  return capabilityRevisionComponents(pkg, digest, new Map(Object.entries(state.components)))?.find(
    (component) => component.id === componentId,
  );
}

const FILE_KINDS = new Set(["skill", "command", "prompt", "subagent"]);
const DELIVERED = new Set<CapabilityTargetStatus>(["installed-next-session", "ready"]);

/** `project:<id>` / `environment:<id>` for each scoped setup that selects the package. */
function scopedReferences(
  state: CapabilityState,
  environment: ScopedEnvironment,
  packageId: string,
): string[] {
  const references: string[] = [];
  for (const [scope, id] of [
    ["project", environment.projectId],
    ["environment", environment.id],
  ] as const) {
    const assignment = state.assignments[`${scope}:${id}`];
    if (
      assignment?.setupIds.some((setupId) =>
        state.setups[setupId]?.packageSelections.some(
          (selection) => selection.packageId === packageId,
        ),
      )
    ) {
      references.push(`${scope}:${id}`);
    }
  }
  return references;
}

/**
 * What one local worktree should have: the packages its project and
 * environment setups select, for every provider that can run there, minus
 * what the machine-wide copies already give that provider at that revision.
 */
export function desiredProjectState(
  state: CapabilityState,
  nodeId: string,
  environment: ScopedEnvironment,
  host: NodeDesiredState,
  resolve: ScopedDeliveryDeps["resolve"],
): { installations: ScopedInstallation[]; undeliverable: ScopedUndeliverable[] } {
  const assigned =
    (state.assignments[`project:${environment.projectId}`]?.setupIds.length ?? 0) +
    (state.assignments[`environment:${environment.id}`]?.setupIds.length ?? 0);
  if (assigned === 0) return { installations: [], undeliverable: [] };
  const wanted = new Map<
    string,
    {
      component: CapabilityComponent;
      packageId: string;
      digest: string;
      providers: Set<AgentPlatform>;
    }
  >();
  const undeliverable: ScopedUndeliverable[] = [];
  const mcpWanted: Array<{
    location: ProjectMcpLocation;
    component: CapabilityComponent;
    packageId: string;
    digest: string;
    provider: AgentPlatform;
  }> = [];
  for (const provider of AGENT_PLATFORMS) {
    const resolved = resolve(state, {
      nodeId,
      provider,
      projectId: environment.projectId,
      environmentId: environment.id,
    });
    for (const pkg of resolved.resolvedPackages) {
      if (scopedReferences(state, environment, pkg.id).length === 0) continue;
      for (const componentId of pkg.components) {
        const component = revisionComponent(state, pkg.id, componentId, pkg.artifactDigest);
        if (!component) continue;
        if (component.providerHints.length > 0 && !component.providerHints.includes(provider))
          continue;
        const served = host.installations.some(
          (entry) =>
            entry.componentId === componentId &&
            entry.digest === pkg.artifactDigest &&
            entry.providers.includes(provider),
        );
        if (served) continue;
        if (component.kind === "mcp-server") {
          // Into the provider's project MCP file, through MCP management (`project-mcp.ts`).
          const location = projectMcpLocationFor(provider);
          if (!location) {
            undeliverable.push({
              provider,
              componentId,
              packageId: pkg.id,
              status: "unsupported",
              reason: `${provider} reads no project MCP file, so a project setup cannot give it MCP servers; add them to My setup instead.`,
            });
            continue;
          }
          mcpWanted.push({
            location,
            component,
            packageId: pkg.id,
            digest: pkg.artifactDigest,
            provider,
          });
          continue;
        }
        if (!FILE_KINDS.has(component.kind)) {
          undeliverable.push({
            provider,
            componentId,
            packageId: pkg.id,
            status: "unsupported",
            reason:
              "Only skills, commands, prompts, subagents and MCP servers are delivered into a worktree.",
          });
          continue;
        }
        const revisionKey = `${componentId}|${pkg.artifactDigest}`;
        const entry = wanted.get(revisionKey) ?? {
          component,
          packageId: pkg.id,
          digest: pkg.artifactDigest,
          providers: new Set<AgentPlatform>(),
        };
        entry.providers.add(provider);
        wanted.set(revisionKey, entry);
      }
    }
  }
  const byKey = new Map<string, ScopedInstallation>();
  const conflicts = new Set<string>();
  for (const [, entry] of [...wanted.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const providers = AGENT_PLATFORMS.filter((provider) => entry.providers.has(provider));
    const plan = planScopedLocations(PROJECT_CAPABILITY_LOCATIONS, entry.component.kind, providers);
    for (const { location, providers: served } of plan.locations) {
      const key = projectReceiptKey(nodeId, environment.id, location.id, entry.component.id);
      const previous = byKey.get(key);
      if (previous && previous.digest !== entry.digest) conflicts.add(key);
      byKey.set(key, {
        key,
        nodeId,
        locationId: location.id,
        componentId: entry.component.id,
        packageId: entry.packageId,
        digest: entry.digest,
        providers: served,
        alsoVisibleTo: alsoVisibleAt(location, served),
        references: scopedReferences(state, environment, entry.packageId),
      });
    }
    for (const provider of plan.uncovered) {
      undeliverable.push({
        provider,
        componentId: entry.component.id,
        packageId: entry.packageId,
        status: "unsupported",
        reason: `${provider} reads no project directory Orkestrator can write a ${entry.component.kind} to.`,
      });
    }
  }
  for (const entry of mcpWanted) {
    const key = projectReceiptKey(nodeId, environment.id, entry.location.id, entry.component.id);
    const previous = byKey.get(key);
    if (previous && previous.digest !== entry.digest) conflicts.add(key);
    byKey.set(key, {
      key,
      nodeId,
      locationId: entry.location.id,
      componentId: entry.component.id,
      packageId: entry.packageId,
      digest: entry.digest,
      providers: [entry.provider],
      alsoVisibleTo: entry.location.alsoVisibleTo.filter((provider) => provider !== entry.provider),
      references: scopedReferences(state, environment, entry.packageId),
    });
  }
  for (const key of conflicts) {
    const entry = byKey.get(key)!;
    byKey.delete(key);
    for (const provider of entry.providers) {
      undeliverable.push({
        provider,
        componentId: entry.componentId,
        packageId: entry.packageId,
        status: "unsupported",
        reason: "Different revisions share the same project directory.",
      });
    }
  }
  return {
    installations: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
    undeliverable,
  };
}

// --- Added accounts ------------------------------------------------------------

/** How an account directory holds one shared entry. */
export type AccountEntryState = "linked" | "private" | "missing" | "foreign-link";

/** The entries an account's CLI reads instead of the host's, with the location they mirror. */
export const ACCOUNT_LOCATIONS: Readonly<
  Record<"claude" | "codex", ReadonlyArray<{ entry: string; locationId: string }>>
> = {
  claude: [
    { entry: "skills", locationId: "claude-user-skills" },
    { entry: "commands", locationId: "claude-user-commands" },
    { entry: "agents", locationId: "claude-user-agents" },
  ],
  codex: [
    { entry: "skills", locationId: "codex-user-skills" },
    { entry: "prompts", locationId: "codex-user-prompts" },
  ],
};

function accountHostDirectory(provider: "claude" | "codex", homes: CapabilityHomes): string {
  return provider === "claude" ? homes.claudeConfigDir : homes.codexHome;
}

/**
 * Per location, whether the account reads the host's directory (a link to
 * it), its own private copy, or nothing yet (`prepareAgentAccountHome` links
 * a missing entry at the next launch). A link anywhere else is never written
 * through.
 */
export async function accountHomeEvidence(
  provider: "claude" | "codex",
  accountHome: string,
  homes: CapabilityHomes,
): Promise<Record<string, AccountEntryState>> {
  const result: Record<string, AccountEntryState> = {};
  const host = accountHostDirectory(provider, homes);
  for (const { entry, locationId } of ACCOUNT_LOCATIONS[provider]) {
    const link = path.join(accountHome, entry);
    const stat = await fs.lstat(link).catch(() => null);
    if (!stat) {
      result[locationId] = "missing";
    } else if (stat.isSymbolicLink()) {
      const [resolved, expected] = await Promise.all([
        fs.realpath(link).catch(() => null),
        fs.realpath(path.join(host, entry)).catch(() => null),
      ]);
      result[locationId] =
        resolved && expected && resolved === expected ? "linked" : "foreign-link";
    } else {
      result[locationId] = stat.isDirectory() ? "private" : "foreign-link";
    }
  }
  return result;
}

/** The machine-wide installations a private account directory needs its own copy of. */
export function desiredAccountState(
  account: ScopedAccount,
  host: NodeDesiredState,
  evidence: Readonly<Record<string, AccountEntryState>>,
): ScopedInstallation[] {
  return host.installations
    .filter(
      (entry) =>
        evidence[entry.locationId] === "private" && entry.providers.includes(account.provider),
    )
    .map((entry) => ({
      key: accountReceiptKey(
        entry.nodeId,
        account.provider,
        account.accountId,
        entry.locationId,
        entry.componentId,
      ),
      nodeId: entry.nodeId,
      locationId: entry.locationId,
      componentId: entry.componentId,
      packageId: entry.packageId,
      digest: entry.digest,
      providers: [account.provider],
      // Only this account's CLI reads its own configuration directory.
      alsoVisibleTo: [],
      references: [...entry.references, `account:${account.provider}:${account.accountId}`],
    }));
}

// --- The pass ------------------------------------------------------------------

type Located = { location: CapabilityLocation; directory: string };

/**
 * How a pass reads and writes its scope's copies: on this machine through
 * its own executor (the default), or on another machine over the node link
 * (`scoped-remote.ts`), whose answer can be lost.
 */
export interface ScopedPassIO {
  /** The digest on disk of each receipt's copy; a receipt absent from the map was not readable. */
  observe(
    state: CapabilityState,
    receipts: readonly InstallationReceipt[],
  ): Promise<Map<string, string | null>>;
  /** Throws {@link OutcomeUnknownError} when the writes may or may not have happened. */
  apply(targets: NodePlanTarget[]): Promise<NodePlanResult[]>;
  /** Mark receipts before writing, so a lost answer is settled by observation. */
  durable?: boolean;
}

export interface ScopedPassInput {
  writeHeld?: () => Promise<boolean>;
  nodeId: string;
  scope: { environmentId?: string; accountHomeId?: string };
  desired: ScopedInstallation[];
  /** This machine's directories for the scope; required without `io`. */
  locate?(locationId: string): Located | undefined;
  /** A local worktree scope's checkout, for its project MCP files. */
  worktree?: string;
  io?: ScopedPassIO;
  /** A reason the installation must not be written (a tracked path, a link), checked first. */
  collisions?: ReadonlyMap<string, string>;
  /** False when the receipts' directory is no longer this scope's own (an account re-linked). */
  removeFiles: boolean;
}

function inScope(receipt: InstallationReceipt, nodeId: string, scope: ScopedPassInput["scope"]) {
  return (
    receipt.nodeId === nodeId &&
    receipt.environmentId === scope.environmentId &&
    receipt.accountHomeId === scope.accountHomeId &&
    (scope.environmentId !== undefined || scope.accountHomeId !== undefined)
  );
}

function entryName(component: CapabilityComponent, layout: "directory" | "file"): string {
  const name = installName(component.name, component.pathOrKey, layout);
  return layout === "file" ? `${name}.md` : name;
}

/** The digest on disk of each receipt's copy (null: missing or unreadable). */
export async function observeScopedReceipts(
  state: CapabilityState,
  receipts: readonly InstallationReceipt[],
  locate: (locationId: string) => Located | undefined,
  options: { worktree?: string; recover?: boolean } = {},
): Promise<Map<string, string | null>> {
  const { worktree, recover = false } = options;
  const observed = new Map<string, string | null>();
  for (const receipt of receipts) {
    if (receipt.status === "failed" || !receipt.digest) continue;
    const located = locate(receipt.locationId);
    const component = revisionComponent(
      state,
      receipt.packageId,
      receipt.componentId,
      receipt.packageDigest,
    );
    // Not this scope's to read any more (an account linked again), or a revision no longer known.
    if (!located || !component) continue;
    const project = worktree && projectCapabilityLocation(receipt.locationId);
    if (worktree && project && (await linkedAncestor(worktree, project.relative))) continue;
    const entry = entryName(component, located.location.layout);
    const destination = path.join(located.directory, entry);
    if (recover && located.location.layout === "directory") {
      recoverDirectoryReplacement(destination);
    }
    const stat = await fs.lstat(destination).catch(() => null);
    if (!stat || (located.location.layout === "directory" ? !stat.isDirectory() : !stat.isFile())) {
      observed.set(receipt.id, null);
      continue;
    }
    const marker =
      located.location.layout === "directory"
        ? await readMarker(path.join(located.directory, entry, CAPABILITY_MARKER_FILE))
        : (await readLocationIndex(located.directory)).files[entry];
    observed.set(
      receipt.id,
      marker?.packageId === receipt.packageId && marker.componentId === receipt.componentId
        ? await installedDigest(located.location, located.directory, entry, {
            recover: false,
            recordedDigest: marker.digest,
          })
        : null,
    );
  }
  return observed;
}

/**
 * Observe, record drift, plan and apply one scope's copies with a located
 * executor, then record receipts. Receipts of other scopes are untouched.
 */
export async function runScopedPass(
  deps: Pick<ScopedDeliveryDeps, "storage" | "artifacts" | "homes" | "now">,
  input: ScopedPassInput,
): Promise<{ changed: boolean; unknown?: boolean; held?: boolean }> {
  const now = () => (deps.now ?? (() => new Date().toISOString()))();
  const io = input.io ?? localScopedIO(deps, input);
  let state = await deps.storage.capabilities.loadCapabilityState();
  let existing = Object.values(state.receipts).filter((receipt) =>
    inScope(receipt, input.nodeId, input.scope),
  );
  const observed = await io.observe(state, existing);
  // A write whose answer was lost is settled from what is on disk, never re-sent blindly.
  const settledUnknown = await settleUnknownOutcomes(deps, state, existing, observed);
  if (settledUnknown) {
    state = await deps.storage.capabilities.loadCapabilityState();
    existing = Object.values(state.receipts).filter((receipt) =>
      inScope(receipt, input.nodeId, input.scope),
    );
  }
  const desiredByKey = new Map(input.desired.map((entry) => [entry.key, entry]));
  const driftKeys = new Set<string>();
  const forceKeys = new Set<string>();
  const newDrift: Array<{ receipt: InstallationReceipt; observed: string | null }> = [];
  const healed: string[] = [];
  for (const receipt of existing) {
    if (!observed.has(receipt.id)) continue;
    const seen = observed.get(receipt.id) ?? null;
    const drift = state.drift[`drift:${receipt.id}`];
    if (drift?.state === "replaced") {
      forceKeys.add(receipt.id);
      continue;
    }
    if (seen !== receipt.digest) {
      driftKeys.add(receipt.id);
      if (!drift || drift.state === "adopted") newDrift.push({ receipt, observed: seen });
    } else if (drift?.state === "open" || drift?.state === "kept-local") {
      healed.push(receipt.id);
    }
  }

  const targets: NodePlanTarget[] = [];
  const collided = new Map<string, string>();
  for (const installation of input.desired) {
    const collision = input.collisions?.get(installation.key);
    if (collision) {
      collided.set(installation.key, collision);
      continue;
    }
    if (driftKeys.has(installation.key) && !forceKeys.has(installation.key)) continue;
    const component = revisionComponent(
      state,
      installation.packageId,
      installation.componentId,
      installation.digest,
    );
    if (!component) continue;
    const receipt = state.receipts[installation.key];
    const upToDate =
      receipt !== undefined &&
      receipt.packageDigest === installation.digest &&
      DELIVERED.has(receipt.status) &&
      !forceKeys.has(installation.key);
    if (upToDate) continue;
    targets.push({
      key: installation.key,
      action: receipt && receipt.status !== "failed" ? "update" : "install",
      kind: component.kind,
      packageId: installation.packageId,
      componentId: installation.componentId,
      componentName: component.name,
      pathOrKey: component.pathOrKey,
      locationId: installation.locationId,
      ...(component.kind === "mcp-server" ? { provider: installation.providers[0]! } : {}),
      artifactDigest: installation.digest,
      ...(forceKeys.has(installation.key) ? { force: true } : {}),
    });
  }
  const forget: string[] = [];
  for (const receipt of existing) {
    if (desiredByKey.has(receipt.id) || input.collisions?.has(receipt.id)) continue;
    if (!input.removeFiles || receipt.status === "failed" || !observed.has(receipt.id)) {
      forget.push(receipt.id);
      continue;
    }
    if (driftKeys.has(receipt.id) && !forceKeys.has(receipt.id)) continue;
    const component = revisionComponent(
      state,
      receipt.packageId,
      receipt.componentId,
      receipt.packageDigest,
    );
    targets.push({
      key: receipt.id,
      action: "remove",
      kind: component?.kind ?? "skill",
      packageId: receipt.packageId,
      componentId: receipt.componentId,
      componentName: component?.name ?? receipt.componentId.split(":").pop() ?? "component",
      pathOrKey: component?.pathOrKey ?? "",
      locationId: receipt.locationId,
      ...(component?.kind === "mcp-server" ? { provider: receipt.providers[0]! } : {}),
      ...(forceKeys.has(receipt.id) ? { force: true } : {}),
    });
  }

  let results: NodePlanResult[] = [];
  let unknown = false;
  if (targets.length > 0) {
    if (io.durable) markPendingWrites(deps, targets);
    try {
      results = await io.apply(targets);
    } catch (error) {
      if (!(error instanceof OutcomeUnknownError)) throw error;
      unknown = true;
    }
  }
  if (
    !unknown &&
    !settledUnknown &&
    results.length === 0 &&
    newDrift.length === 0 &&
    healed.length === 0 &&
    forget.length === 0 &&
    [...collided].every(([key, reason]) => state.receipts[key]?.reason === reason)
  ) {
    return { changed: false };
  }

  const byKey = new Map(targets.map((target) => [target.key, target]));
  deps.storage.capabilities.mutateCapabilityState((current) => {
    const at = now();
    const receiptFor = (
      installation: ScopedInstallation,
      fields: Pick<InstallationReceipt, "status" | "verification" | "digest"> & { reason?: string },
    ): InstallationReceipt => ({
      id: installation.key,
      nodeId: installation.nodeId,
      locationId: installation.locationId,
      componentId: installation.componentId,
      packageId: installation.packageId,
      digest: fields.digest,
      packageDigest: installation.digest,
      references: installation.references,
      providers: installation.providers,
      alsoVisibleTo: installation.alsoVisibleTo,
      status: fields.status,
      verification: fields.verification,
      ...(fields.reason ? { reason: fields.reason } : {}),
      operationId: "scoped",
      appliedAt: at,
      ...(input.scope.environmentId ? { environmentId: input.scope.environmentId } : {}),
      ...(input.scope.accountHomeId ? { accountHomeId: input.scope.accountHomeId } : {}),
    });
    for (const id of forget) delete current.receipts[id];
    for (const id of healed) {
      delete current.drift[`drift:${id}`];
      const receipt = current.receipts[id];
      if (receipt?.status === "drifted") receipt.status = "installed-next-session";
    }
    for (const { receipt, observed: seen } of newDrift) {
      const live = current.receipts[receipt.id];
      if (!live) continue;
      live.status = "drifted";
      current.drift[`drift:${receipt.id}`] = {
        id: `drift:${receipt.id}`,
        nodeId: receipt.nodeId,
        provider: receipt.providers[0] ?? "claude",
        locationId: receipt.locationId,
        componentId: receipt.componentId,
        packageId: receipt.packageId,
        name: current.components[receipt.componentId]?.name ?? receipt.componentId,
        kind: seen ? "modified" : "removed",
        expectedDigest: receipt.digest,
        ...(seen ? { observedDigest: seen } : {}),
        detectedAt: at,
        state: "open",
      };
    }
    for (const [key, reason] of collided) {
      const installation = desiredByKey.get(key)!;
      const previous = current.receipts[key];
      if (previous?.digest) {
        previous.reason = reason;
        continue;
      }
      current.receipts[key] = receiptFor(installation, {
        status: "failed",
        verification: "requested",
        digest: "",
        reason,
      });
    }
    if (unknown) {
      for (const target of targets) {
        const live = current.receipts[target.key];
        const installation = desiredByKey.get(target.key);
        if (live) {
          live.outcomeUnknown = true;
          live.pendingWrite = {
            action: target.action,
            ...(target.artifactDigest ? { packageDigest: target.artifactDigest } : {}),
          };
        } else if (installation && target.action !== "remove") {
          current.receipts[target.key] = {
            ...receiptFor(installation, {
              status: "outcome-unknown",
              verification: "requested",
              digest: "",
              reason: "Checking what the machine applied.",
            }),
            outcomeUnknown: true,
            pendingWrite: { action: target.action, packageDigest: installation.digest },
          };
        }
      }
    }
    for (const result of results) {
      const target = byKey.get(result.key);
      if (!target) continue;
      if (result.status === "queued-until-idle") {
        const receipt = current.receipts[result.key];
        if (receipt) {
          delete receipt.outcomeUnknown;
          delete receipt.pendingWrite;
        }
        continue;
      }
      if (target.action === "remove") {
        if (result.status === "ready") {
          delete current.receipts[result.key];
          delete current.drift[`drift:${result.key}`];
        } else if (current.receipts[result.key]) {
          delete current.receipts[result.key]!.outcomeUnknown;
          delete current.receipts[result.key]!.pendingWrite;
        }
        continue;
      }
      const installation = desiredByKey.get(result.key);
      if (!installation) continue;
      const hadCopy = current.receipts[result.key]?.status === "installed-next-session";
      if (result.status === "drifted" && !hadCopy && !forceKeys.has(result.key)) {
        // Something Orkestrator did not write is already there: a collision, kept as it is.
        current.receipts[result.key] = receiptFor(installation, {
          status: "failed",
          verification: "requested",
          digest: "",
          reason: result.reason ?? "An item Orkestrator does not manage is already there.",
        });
        continue;
      }
      current.receipts[result.key] = receiptFor(installation, {
        status: result.status,
        verification: result.verification,
        digest: result.digest ?? "",
        ...(result.reason ? { reason: result.reason } : {}),
      });
      if (forceKeys.has(result.key) && result.status !== "failed" && result.status !== "drifted")
        delete current.drift[`drift:${result.key}`];
    }
    const outcomes = new Map<string, { status: CapabilityTargetStatus; reason?: string }>();
    for (const result of results) outcomes.set(result.key, result);
    for (const [key, reason] of collided) outcomes.set(key, { status: "failed", reason });
    for (const key of forget) outcomes.set(key, { status: "ready" });
    if (unknown) {
      for (const target of targets) outcomes.set(target.key, { status: "outcome-unknown" });
    }
    updateOperationTargets(current, outcomes, (target) => {
      const desired = desiredByKey.get(target.key);
      return target.action === "remove" ? !desired : desired?.digest === target.toDigest;
    });
    return { result: undefined, changed: true };
  });
  return {
    changed: true,
    ...(unknown ? { unknown: true } : {}),
    ...(results.some((result) => result.status === "queued-until-idle") ? { held: true } : {}),
  };
}

/** A receipt with bytes on disk to compare, or an unanswered write to settle. */
export function observable(receipt: InstallationReceipt): boolean {
  return receipt.outcomeUnknown === true || (receipt.status !== "failed" && !!receipt.digest);
}

/** This machine's own executor over the scope's located directories. */
function localScopedIO(
  deps: Pick<ScopedDeliveryDeps, "storage" | "artifacts" | "homes" | "now" | "projectMcp" | "git">,
  input: ScopedPassInput,
): ScopedPassIO {
  const locate = input.locate;
  if (!locate) throw new Error("A local scoped pass needs its locations.");
  const environmentId = input.scope.environmentId;
  const base = environmentId && input.worktree ? deps.projectMcp?.(environmentId) : undefined;
  const mcp =
    base && environmentId && input.worktree
      ? projectMcpInstaller(base, {
          storage: deps.storage,
          nodeId: input.nodeId,
          environmentId,
          worktree: input.worktree,
        })
      : undefined;
  return {
    observe: async (state, receipts) => {
      const allowed = receipts.filter((receipt) => !input.collisions?.has(receipt.id));
      const observed = await observeScopedReceipts(state, allowed, locate, {
        worktree: input.worktree,
        recover: true,
      });
      const mcpKeys = allowed
        .filter((receipt) => projectMcpLocation(receipt.locationId) && observable(receipt))
        .map((receipt) => receipt.id);
      for (const [key, digest] of await observeProjectMcpEntries(deps.storage, mcp, mcpKeys))
        observed.set(key, digest);
      return observed;
    },
    apply: async (targets) => {
      const executor = new CapabilityExecutor({
        storage: deps.storage,
        artifacts: deps.artifacts,
        homes: deps.homes,
        locate,
        ...(input.writeHeld ? { writeHeld: input.writeHeld } : {}),
        ...(mcp ? { mcp } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
      const collisions = input.worktree
        ? await worktreeCollisions(
            deps.git ?? defaultGitRunner,
            input.worktree,
            targets.map((target) => ({
              ...target,
              locationId: target.locationId ?? "",
            })),
          )
        : new Map<string, string>();
      const runnable = targets.filter((target) => !collisions.has(target.key));
      const results = [
        ...(await executor.apply(runnable)),
        ...Array.from(collisions, ([key, reason]): NodePlanResult => ({
          key,
          status: "failed",
          verification: "requested",
          reason,
        })),
      ];
      await dropEmptyIndexes(runnable, results, locate);
      return results;
    },
  };
}

/** Before a write whose answer can be lost: what was about to happen, per receipt. */
function markPendingWrites(
  deps: Pick<ScopedDeliveryDeps, "storage">,
  targets: readonly NodePlanTarget[],
): void {
  deps.storage.capabilities.mutateCapabilityState((current) => {
    let changed = false;
    for (const target of targets) {
      const receipt = current.receipts[target.key];
      if (!receipt) continue;
      receipt.outcomeUnknown = true;
      receipt.pendingWrite = {
        action: target.action,
        ...(target.artifactDigest ? { packageDigest: target.artifactDigest } : {}),
      };
      changed = true;
    }
    return { result: undefined, changed };
  });
}

/** The digest a scoped receipt's pending write leaves on disk, from the package artifact. */
async function expectedScopedDigest(
  artifacts: CapabilityArtifactStore,
  state: CapabilityState,
  receipt: InstallationReceipt,
): Promise<string | undefined> {
  const digest = receipt.pendingWrite?.packageDigest ?? receipt.packageDigest;
  // A project MCP server is observed by the package digest its executor recorded.
  if (projectMcpLocation(receipt.locationId)) return digest || undefined;
  const location =
    projectCapabilityLocation(receipt.locationId) ?? capabilityLocation(receipt.locationId);
  const component = revisionComponent(state, receipt.packageId, receipt.componentId, digest);
  if (!location || !component || !digest) return undefined;
  const files = componentFiles(await artifacts.get(digest), component);
  if (files.length === 0) return undefined;
  if (location.layout === "directory") return treeDigest(files);
  return treeDigest(installedComponentFiles(files, location.layout, entryName(component, "file")));
}

/**
 * Settles receipts whose last write went unanswered, from the observation:
 * the planned bytes are there (confirmed), the previous bytes are still
 * there (the write did not land; planned again), a removal left nothing
 * (gone), or anything else (forgotten, so the pass plans it afresh and the
 * executor's ownership rules decide).
 */
async function settleUnknownOutcomes(
  deps: Pick<ScopedDeliveryDeps, "storage" | "artifacts">,
  state: CapabilityState,
  receipts: readonly InstallationReceipt[],
  observed: ReadonlyMap<string, string | null>,
): Promise<boolean> {
  const outcomes = new Map<
    string,
    { kind: "confirm"; digest: string } | { kind: "restore" } | { kind: "forget" }
  >();
  for (const receipt of receipts) {
    if (!receipt.outcomeUnknown || !observed.has(receipt.id)) continue;
    const seen = observed.get(receipt.id) ?? null;
    if (receipt.pendingWrite?.action === "remove") {
      outcomes.set(receipt.id, seen === null ? { kind: "forget" } : { kind: "restore" });
      continue;
    }
    const expected = await expectedScopedDigest(deps.artifacts, state, receipt).catch(
      () => undefined,
    );
    if (expected && seen === expected)
      outcomes.set(receipt.id, { kind: "confirm", digest: expected });
    else if (receipt.digest && seen === receipt.digest)
      outcomes.set(receipt.id, { kind: "restore" });
    else outcomes.set(receipt.id, { kind: "forget" });
  }
  if (outcomes.size === 0) return false;
  deps.storage.capabilities.mutateCapabilityState((current) => {
    for (const [id, outcome] of outcomes) {
      const receipt = current.receipts[id];
      if (!receipt) continue;
      if (outcome.kind === "forget") {
        delete current.receipts[id];
        continue;
      }
      if (outcome.kind === "confirm") {
        receipt.digest = outcome.digest;
        receipt.packageDigest = receipt.pendingWrite?.packageDigest ?? receipt.packageDigest;
        receipt.verification = "present";
      }
      receipt.status = "installed-next-session";
      delete receipt.reason;
      delete receipt.outcomeUnknown;
      delete receipt.pendingWrite;
    }
    return { result: undefined, changed: true };
  });
  return true;
}

// --- Evidence for launch preflight ----------------------------------------------

/** What a launch can check for a target outside the machine-wide homes. */
export interface ScopedEvidence {
  isolated?: Array<CapabilityLaunchDelivery & { packageDigest: string }>;
  project?: { environmentId: string; observed: ReadonlyMap<string, string | null> };
  account?: {
    accountHomeId: string;
    provider: AgentPlatform;
    entries: Readonly<Record<string, AccountEntryState>>;
    observed: ReadonlyMap<string, string | null>;
  };
  container?: ContainerDeliveryEvidence | null;
}

/** A container's staged capability record, as read back from its inputs revision. */
export interface ContainerDeliveryEvidence {
  containerId: string;
  inputsRevision: string;
  /** The digest recorded on the container's label. */
  labelDigest: string | null;
  record: import("./container-staging.js").ContainerCapabilityRecord | null;
}

export type ScopedRequirement =
  | {
      kind: "verified";
      /** The target's own copies that hold the required revision (location ids are scoped). */
      deliveries: Array<{ locationId: string; digest: string }>;
      /**
       * True when the target reads no machine-wide copy of the component (a
       * container, a private account directory). A worktree also reads the
       * host's copies, and Claude ranks a personal skill above a project one,
       * so those must still hold their recorded bytes.
       */
      exclusive: boolean;
    }
  | { kind: "refused"; reason: string }
  /** The machine-wide copy is what this target loads: check the host receipts. */
  | { kind: "host" };

/** The environment card's words for a container nothing was staged into (`container-staging.ts`). */
export const CONTAINER_UNSTAGED_SUMMARY = "Capabilities not staged: command node unreachable";

/** Why a required component cannot be verified in such a container. */
export function containerUnstagedReason(componentName: string): string {
  return `${CONTAINER_UNSTAGED_SUMMARY} when this container was created, so ${componentName} is not in it; rebuild the container once the command node is reachable.`;
}

/** A container's staged copy, as a launch delivery's location id. */
export function containerDeliveryLocation(locationId: string): string {
  return `container:${locationId}`;
}

/**
 * Whether a required component at `digest` is delivered for a container,
 * an added account or a worktree, from that target's own evidence.
 */
export function scopedRequiredDelivery(input: {
  state: CapabilityState;
  target: CapabilityTarget;
  evidence?: ScopedEvidence;
  component: Pick<CapabilityComponent, "id" | "name">;
  digest: string;
}): ScopedRequirement {
  const { state, target, evidence, component, digest } = input;
  if (target.environmentIncarnation !== undefined) {
    const container = evidence?.container;
    if (!container?.record) {
      return {
        kind: "refused",
        reason: `No capability manifest was staged into this container, so ${component.name} cannot be verified; rebuild the container to stage the current setup.`,
      };
    }
    if (
      container.containerId !== target.environmentIncarnation ||
      container.labelDigest !== container.record.digest
    ) {
      return {
        kind: "refused",
        reason: `The staged capability manifest does not belong to this container; rebuild it to stage ${component.name}.`,
      };
    }
    if (container.record.unstaged) {
      return { kind: "refused", reason: containerUnstagedReason(component.name) };
    }
    const item = container.record.items.find(
      (entry) =>
        entry.componentId === component.id &&
        entry.status === "staged" &&
        entry.providers.includes(target.provider),
    );
    if (item?.packageDigest === digest) {
      return {
        kind: "verified",
        exclusive: true,
        deliveries: container.record.items
          .filter(
            (entry) =>
              entry.componentId === component.id &&
              entry.status === "staged" &&
              entry.packageDigest === digest &&
              entry.providers.includes(target.provider),
          )
          .map((entry) => ({
            locationId: containerDeliveryLocation(entry.locationId),
            digest: entry.digest ?? entry.packageDigest,
          })),
      };
    }
    return {
      kind: "refused",
      reason: item
        ? `This container was staged with an older revision of ${component.name}; rebuild it to stage the current one.`
        : `${component.name} was not staged into this container; rebuild it to stage the current setup.`,
    };
  }
  const isolated = evidence?.isolated?.filter(
    (entry) => entry.componentId === component.id && entry.packageDigest === digest,
  );
  if (isolated?.length) {
    return {
      kind: "verified",
      exclusive: false,
      deliveries: isolated.map(({ locationId, digest }) => ({ locationId, digest })),
    };
  }
  const scopedMatch = (
    receipt: InstallationReceipt,
    observed: ReadonlyMap<string, string | null>,
  ) =>
    receipt.componentId === component.id &&
    receipt.packageDigest === digest &&
    receipt.providers.includes(target.provider) &&
    DELIVERED.has(receipt.status) &&
    !receipt.outcomeUnknown &&
    !!receipt.digest &&
    observed.get(receipt.id) === receipt.digest;
  if (
    target.environmentId !== undefined &&
    evidence?.project?.environmentId === target.environmentId
  ) {
    const project = evidence.project;
    const verified = Object.values(state.receipts).filter(
      (receipt) =>
        receipt.nodeId === target.nodeId &&
        receipt.environmentId === target.environmentId &&
        scopedMatch(receipt, project.observed),
    );
    if (verified.length > 0) {
      return {
        kind: "verified",
        exclusive: false,
        deliveries: verified.map((receipt) => ({
          locationId: receipt.locationId,
          digest: receipt.digest,
        })),
      };
    }
  }
  if (target.accountHomeId !== undefined) {
    const account = evidence?.account;
    if (!account || account.accountHomeId !== target.accountHomeId) {
      return {
        kind: "refused",
        reason: `The account's configuration directory could not be checked for ${component.name}.`,
      };
    }
    const hostLocations = Object.values(state.receipts)
      .filter(
        (receipt) =>
          receipt.nodeId === target.nodeId &&
          receipt.environmentId === undefined &&
          receipt.accountHomeId === undefined &&
          receipt.componentId === component.id &&
          receipt.packageDigest === digest &&
          receipt.providers.includes(target.provider),
      )
      .map((receipt) => receipt.locationId);
    // A host copy outside the account's own directories, or in one it links, is what it reads.
    const readsHost = (locationId: string) => {
      const entry = account.entries[locationId];
      return entry === undefined || entry === "linked" || entry === "missing";
    };
    if (
      hostLocations.some(readsHost) ||
      (hostLocations.length === 0 && Object.keys(account.entries).every(readsHost))
    ) {
      return { kind: "host" };
    }
    const own = Object.values(state.receipts).filter(
      (receipt) =>
        receipt.nodeId === target.nodeId &&
        receipt.accountHomeId === target.accountHomeId &&
        account.entries[receipt.locationId] === "private" &&
        scopedMatch(receipt, account.observed),
    );
    if (own.length > 0) {
      return {
        kind: "verified",
        exclusive: true,
        deliveries: own.map((receipt) => ({
          locationId: `account:${receipt.locationId}`,
          digest: receipt.digest,
        })),
      };
    }
    return {
      kind: "refused",
      reason: `This account keeps its own copy of its ${target.provider} configuration, and the required revision of ${component.name} is not verified there yet.`,
    };
  }
  return { kind: "host" };
}

// --- The service-facing class ----------------------------------------------------

/** File components selected for this isolated checkout that are not machine-wide. */
export function isolatedWorktreeTargets(
  state: CapabilityState,
  effective: EffectiveAgentResources,
): NodePlanTarget[] {
  const { nodeId, provider } = effective.target;
  const host = desiredStateForNode(state, nodeId, state.machines[nodeId]?.inventory);
  return effective.resolvedPackages.flatMap((pkg) =>
    pkg.components.flatMap((id): NodePlanTarget[] => {
      const component = revisionComponent(state, pkg.id, id, pkg.artifactDigest);
      if (
        !component ||
        !FILE_KINDS.has(component.kind) ||
        (component.providerHints.length && !component.providerHints.includes(provider)) ||
        host.installations.some(
          (entry) =>
            entry.componentId === id &&
            entry.digest === pkg.artifactDigest &&
            entry.providers.includes(provider),
        )
      )
        return [];
      return planScopedLocations(PROJECT_CAPABILITY_LOCATIONS, component.kind, [
        provider,
      ]).locations.map(({ location }) => ({
        key: `${location.id}|${id}`,
        action: "install",
        kind: component.kind,
        packageId: pkg.id,
        componentId: id,
        componentName: component.name,
        pathOrKey: component.pathOrKey,
        locationId: location.id,
        artifactDigest: pkg.artifactDigest,
      }));
    }),
  );
}

/** Expected bytes of an isolated plan, verified again by the leaf after writing. */
export async function isolatedWorktreeDelivery(
  artifacts: CapabilityArtifactStore,
  target: NodePlanTarget,
): Promise<NonNullable<ScopedEvidence["isolated"]>[number] | undefined> {
  const location = projectCapabilityLocation(target.locationId ?? "");
  const packageDigest = target.artifactDigest;
  if (!location || !packageDigest) return undefined;
  const files = componentFiles(await artifacts.get(packageDigest), target);
  if (files.length === 0) return undefined;
  const name = installName(target.componentName, target.pathOrKey, location.layout);
  const entry = location.layout === "file" ? `${name}.md` : name;
  return {
    componentId: target.componentId,
    packageId: target.packageId,
    locationId: location.id,
    packageDigest,
    digest: treeDigest(installedComponentFiles(files, location.layout, entry)),
  };
}

/**
 * Runs the scoped passes for this machine, one at a time, and answers
 * launch evidence. Every pass reads the newest state.
 */
export class ScopedCapabilityDelivery {
  private chain: Promise<unknown> = Promise.resolve();
  private names = new Map<string, string>();
  /** Worktrees on other machines, named by the command node's last pass over them. */
  private remoteNames = new Map<string, string>();

  constructor(private readonly deps: ScopedDeliveryDeps) {}

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private git(): GitRunner {
    return this.deps.git ?? defaultGitRunner;
  }

  private async hostDesired(state: CapabilityState, nodeId: string): Promise<NodeDesiredState> {
    return desiredStateForNode(state, nodeId, state.machines[nodeId]?.inventory);
  }

  /** Every local worktree and added account on this machine. */
  runAll(): Promise<{ recheck: boolean }> {
    return this.serialized(async () => {
      let changed = false;
      let recheck = false;
      const failed = (error: unknown) => {
        log.warn("delivery.scope-failed", { error: formatLogError(error, { message: false }) });
        return false as const;
      };
      const listed = await this.deps.environments?.().catch(failed);
      const environments = listed || [];
      const known = new Set(environments.map((environment) => environment.id));
      const accounts = (await this.deps.accounts?.().catch(() => [])) ?? [];
      this.names = new Map([
        ...environments.map((environment): [string, string] => [
          `env:${environment.id}`,
          environment.name ?? environment.id,
        ]),
        ...accounts.map((account): [string, string] => [
          `account:${account.accountId}`,
          `${account.provider} account`,
        ]),
      ]);
      for (const environment of environments) {
        if (environment.environmentType !== "local") continue;
        const pass = await this.deliverProject(environment, known).catch(failed);
        if (pass) {
          changed ||= pass.changed;
          recheck ||= Boolean(pass.held);
        }
      }
      if (listed) changed = (await this.forgetGoneEnvironments(known)) || changed;
      for (const account of accounts) {
        const pass = await this.deliverAccount(account).catch(failed);
        if (pass) {
          changed ||= pass.changed;
          recheck ||= Boolean(pass.held);
        }
      }
      if (changed) this.deps.changed?.();
      return { recheck };
    });
  }

  /** One local worktree, before a launch from it. */
  deliverEnvironment(environmentId: string): Promise<void> {
    return this.serialized(async () => {
      const environments = (await this.deps.environments?.().catch(() => [])) ?? [];
      const environment = environments.find((entry) => entry.id === environmentId);
      if (!environment || environment.environmentType !== "local") return;
      const known = new Set(environments.map((entry) => entry.id));
      const pass = await this.deliverProject(environment, known);
      if (pass && pass.changed) this.deps.changed?.();
    });
  }

  /** The project locations of one worktree. */
  projectLocator(worktree: string): (locationId: string) => Located | undefined {
    return projectLocator(worktree);
  }

  /** Names for worktrees on other machines (`scoped-remote.ts`). */
  noteRemoteNames(names: ReadonlyMap<string, string>): void {
    for (const [key, name] of names) this.remoteNames.set(key, name);
  }

  /** An account's own directories, standing in for the host's. */
  accountLocator(account: ScopedAccount): (locationId: string) => Located | undefined {
    return (locationId) => {
      const mapping = ACCOUNT_LOCATIONS[account.provider].find(
        (entry) => entry.locationId === locationId,
      );
      const location = capabilityLocation(locationId);
      return mapping && location
        ? { location, directory: path.join(account.home, mapping.entry) }
        : undefined;
    };
  }

  private async forgetGoneEnvironments(known: ReadonlySet<string>): Promise<boolean> {
    const nodeId = await this.deps.selfId();
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    // Worktrees on other machines are settled by their own pass (`scoped-remote.ts`).
    const gone = Object.values(state.receipts).filter(
      (receipt) =>
        receipt.nodeId === nodeId &&
        receipt.environmentId !== undefined &&
        !known.has(receipt.environmentId),
    );
    if (gone.length === 0) return false;
    // The worktree went with its environment; there is nothing left to remove.
    this.deps.storage.capabilities.mutateCapabilityState((current) => {
      for (const receipt of gone) {
        delete current.receipts[receipt.id];
        delete current.drift[`drift:${receipt.id}`];
      }
      return { result: undefined, changed: true };
    });
    return true;
  }

  private async deliverProject(
    environment: ScopedEnvironment,
    known: ReadonlySet<string>,
  ): Promise<{ changed: boolean; held?: boolean } | false> {
    const worktree = environment.worktreePath;
    if (!worktree) return false;
    const stat = await fs.stat(worktree).catch(() => null);
    if (!stat?.isDirectory()) return false;
    const nodeId = await this.deps.selfId();
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const existing = Object.values(state.receipts).filter(
      (receipt) => receipt.nodeId === nodeId && receipt.environmentId === environment.id,
    );
    const assigned =
      (state.assignments[`project:${environment.projectId}`]?.setupIds.length ?? 0) +
      (state.assignments[`environment:${environment.id}`]?.setupIds.length ?? 0);
    // Most worktrees have no project setup: nothing to resolve, no Git to ask.
    if (assigned === 0 && existing.length === 0) return false;
    const host = await this.hostDesired(state, nodeId);
    const { installations } = desiredProjectState(
      state,
      nodeId,
      environment,
      host,
      this.deps.resolve,
    );
    if (installations.length === 0 && existing.length === 0) return false;

    const locate = this.projectLocator(worktree);
    const entryOf = (
      key: string,
      installation: Pick<ScopedInstallation, "packageId" | "componentId" | "locationId">,
      digest: string,
    ): WorktreeEntry[] => {
      const component = revisionComponent(
        state,
        installation.packageId,
        installation.componentId,
        digest,
      );
      return component
        ? [
            {
              key,
              locationId: installation.locationId,
              componentName: component.name,
              pathOrKey: component.pathOrKey,
            },
          ]
        : [];
    };

    // Collisions: a path the repository tracks, or a directory reached through a link.
    const git = this.git();
    const candidates = installations.flatMap((installation) =>
      entryOf(installation.key, installation, installation.digest),
    );
    const removals = existing.flatMap((receipt) =>
      entryOf(receipt.id, receipt, receipt.packageDigest),
    );
    const collisions = await worktreeCollisions(git, worktree, [...candidates, ...removals]);

    // Exclude before writing, so no status ever shows the copies.
    const writable = candidates.filter((candidate) => !collisions.has(candidate.key));
    const kept = existing.flatMap((receipt) =>
      receipt.status === "failed" ? [] : entryOf(receipt.id, receipt, receipt.packageDigest),
    );
    const knownEnvironment = (id: string) => known.has(id);
    const mcpContext = {
      storage: this.deps.storage,
      nodeId,
      environmentId: environment.id,
      worktree,
    };
    await syncWorktreeExclude(
      git,
      worktree,
      environment.id,
      [...writable, ...kept],
      knownEnvironment,
      await projectMcpExcludeFiles(mcpContext, writable),
    );
    const pass = await runScopedPass(this.deps, {
      nodeId,
      scope: { environmentId: environment.id },
      ...(this.deps.writeHeld
        ? { writeHeld: () => this.deps.writeHeld!({ environmentId: environment.id }) }
        : {}),
      desired: installations,
      locate,
      worktree,
      collisions,
      removeFiles: true,
    });
    const after = await this.deps.storage.capabilities.loadCapabilityState();
    const remaining = Object.values(after.receipts).flatMap((receipt) =>
      receipt.nodeId !== nodeId ||
      receipt.environmentId !== environment.id ||
      receipt.status === "failed"
        ? []
        : entryOf(receipt.id, receipt, receipt.packageDigest),
    );
    await syncWorktreeExclude(
      git,
      worktree,
      environment.id,
      remaining,
      knownEnvironment,
      await projectMcpExcludeFiles(mcpContext, []),
    );
    return pass;
  }

  private async deliverAccount(
    account: ScopedAccount,
  ): Promise<{ changed: boolean; held?: boolean } | false> {
    const nodeId = await this.deps.selfId();
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const evidence = await accountHomeEvidence(account.provider, account.home, this.deps.homes());
    const host = await this.hostDesired(state, nodeId);
    const desired = desiredAccountState(account, host, evidence);
    const accountHomeId = account.accountId;
    const existing = Object.values(state.receipts).filter(
      (receipt) =>
        receipt.nodeId === nodeId &&
        receipt.accountHomeId === accountHomeId &&
        receipt.providers.includes(account.provider),
    );
    if (desired.length === 0 && existing.length === 0) return false;
    const locate = this.accountLocator(account);
    // A directory that is linked again is the host's: its copies are the host's to remove.
    const privateLocate = (locationId: string) =>
      evidence[locationId] === "private" ? locate(locationId) : undefined;
    const pass = await runScopedPass(this.deps, {
      nodeId,
      scope: { accountHomeId },
      ...(this.deps.writeHeld ? { writeHeld: () => this.deps.writeHeld!({ account }) } : {}),
      desired,
      locate: privateLocate,
      removeFiles: Object.values(evidence).some((entry) => entry === "private"),
    });
    return pass;
  }

  /**
   * At launch: brings a local worktree's project copies up to date, then
   * collects the evidence `scopedRequiredDelivery` checks for the target
   * (the worktree's copies, the account's directories, or the container's
   * staged record).
   */
  async launchEvidence(
    target: CapabilityTarget,
    relativeWorktree?: string,
    resolveWorktree?: (state: CapabilityState) => EffectiveAgentResources,
  ): Promise<ScopedEvidence> {
    const environments = target.environmentId
      ? ((await this.deps.environments?.().catch(() => [])) ?? [])
      : [];
    const environment = environments.find((entry) => entry.id === target.environmentId) ?? null;
    if (
      !relativeWorktree &&
      environment?.environmentType === "local" &&
      target.environmentIncarnation === undefined
    ) {
      await this.deliverEnvironment(environment.id).catch(() => undefined);
    }
    const account =
      target.accountHomeId !== undefined
        ? (((await this.deps.accounts?.().catch(() => [])) ?? []).find(
            (entry) =>
              entry.accountId === target.accountHomeId && entry.provider === target.provider,
          ) ?? null)
        : null;
    const evidence = await this.evidenceFor(target, relativeWorktree ? null : environment, account);
    if (
      relativeWorktree &&
      environment?.environmentType === "local" &&
      environment.worktreePath &&
      resolveWorktree
    ) {
      const state = await this.deps.storage.capabilities.loadCapabilityState();
      evidence.isolated = await this.stageIsolatedWorktree(
        target,
        relativeWorktree,
        isolatedWorktreeTargets(state, resolveWorktree(state)),
      );
    }
    if (target.environmentIncarnation !== undefined && target.environmentId) {
      evidence.container =
        (await this.deps.containerDelivery?.(target.environmentId).catch(() => null)) ?? null;
    }
    return evidence;
  }

  stageIsolatedWorktree(
    target: CapabilityTarget,
    relativeWorktree: string,
    targets: readonly NodePlanTarget[],
    fence?: () => Promise<void>,
  ): Promise<NonNullable<ScopedEvidence["isolated"]>> {
    return this.serialized(async () => {
      if (!parseGraphBranchWorktreePath(relativeWorktree) || targets.length === 0) return [];
      const environment = (await this.deps.environments?.())?.find(
        (entry) => entry.id === target.environmentId && entry.environmentType === "local",
      );
      const root = environment?.worktreePath;
      if (!root || (await linkedAncestor(root, relativeWorktree))) return [];
      const worktree = confinedPath(root, relativeWorktree);
      const git = this.git();
      const [commonDir, topLevel] = await Promise.all([
        gitCommonDir(git, worktree),
        git(worktree, ["rev-parse", "--show-toplevel"]),
      ]);
      if (!commonDir || (await fs.realpath(worktree)) !== path.resolve(topLevel.trim())) return [];
      const byKey = new Map(targets.map((entry) => [entry.key, entry]));
      const candidates = targets.flatMap((entry) => {
        const location = projectCapabilityLocation(entry.locationId ?? "");
        return location?.readBy.includes(target.provider) &&
          location.kind === entry.kind &&
          entry.action === "install" &&
          !entry.force &&
          !entry.takeoverFrom
          ? [{ ...entry, locationId: location.id }]
          : [];
      });
      const collisions = await worktreeCollisions(git, worktree, candidates);
      const writable = candidates.filter((entry) => !collisions.has(entry.key));
      await fence?.();
      if (writable.length > 0)
        await syncGraphWorktreeExclude(
          commonDir,
          relativeWorktree,
          writable.flatMap((entry) => {
            const placed = worktreeEntryPath(entry);
            return placed ? [placed] : [];
          }),
        );
      const executor = new CapabilityExecutor({
        storage: this.deps.storage,
        artifacts: this.deps.artifacts,
        homes: this.deps.homes,
        locate: this.projectLocator(worktree),
        recordApplied: false,
      });
      const results = await executor.apply(writable, fence);
      return results.flatMap((result) => {
        const entry = byKey.get(result.key);
        return entry && result.digest && DELIVERED.has(result.status)
          ? [
              {
                componentId: entry.componentId,
                packageId: entry.packageId,
                locationId: entry.locationId!,
                packageDigest: entry.artifactDigest!,
                digest: result.digest,
              },
            ]
          : [];
      });
    });
  }

  /** Only private account locations are read. Links to host homes use host inventory. */
  async leafAccountReport(target: CapabilityTarget) {
    if (!target.accountHomeId || target.environmentIncarnation !== undefined) return undefined;
    const account = (await this.deps.accounts?.())?.find(
      (entry) => entry.accountId === target.accountHomeId && entry.provider === target.provider,
    );
    if (!account) return undefined;
    const entries = await accountHomeEvidence(account.provider, account.home, this.deps.homes());
    const locate = this.accountLocator(account);
    const copies = [];
    for (const [locationId, state] of Object.entries(entries)) {
      if (state !== "private") continue;
      const location = locate(locationId);
      if (location)
        copies.push(...(await managedLocationEntries(location.location, location.directory)));
    }
    return { accountHomeId: account.accountId, entries, copies };
  }

  /** Display names for the "Where available" rows of scoped copies, from the last pass. */
  scopeNames(): ReadonlyMap<string, string> {
    return new Map([...this.remoteNames, ...this.names]);
  }

  /** Inspects the current target without staging or starting anything. */
  async readEvidence(target: CapabilityTarget): Promise<ScopedEvidence | undefined> {
    if (!target.environmentId && !target.accountHomeId) return undefined;
    if (target.environmentIncarnation !== undefined && target.environmentId) {
      return { container: (await this.deps.containerDelivery?.(target.environmentId)) ?? null };
    }
    const [environments, accounts] = await Promise.all([
      target.environmentId ? this.deps.environments?.() : undefined,
      target.accountHomeId ? this.deps.accounts?.() : undefined,
    ]);
    return this.evidenceFor(
      target,
      environments?.find((entry) => entry.id === target.environmentId),
      accounts?.find(
        (entry) => entry.accountId === target.accountHomeId && entry.provider === target.provider,
      ),
    );
  }

  /** Evidence for one launch target (worktree or account); containers come from staging. */
  async evidenceFor(
    target: CapabilityTarget,
    environment?: ScopedEnvironment | null,
    account?: ScopedAccount | null,
  ): Promise<ScopedEvidence> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const evidence: ScopedEvidence = {};
    if (
      target.environmentIncarnation === undefined &&
      environment?.environmentType === "local" &&
      environment.worktreePath
    ) {
      const receipts = Object.values(state.receipts).filter(
        (receipt) => receipt.nodeId === target.nodeId && receipt.environmentId === environment.id,
      );
      const observed = await observeScopedReceipts(
        state,
        receipts,
        this.projectLocator(environment.worktreePath),
        { worktree: environment.worktreePath },
      );
      const base = this.deps.projectMcp?.(environment.id);
      const mcp = base
        ? projectMcpInstaller(base, {
            storage: this.deps.storage,
            nodeId: target.nodeId,
            environmentId: environment.id,
            worktree: environment.worktreePath,
          })
        : undefined;
      const mcpKeys = receipts
        .filter((receipt) => projectMcpLocation(receipt.locationId) && observable(receipt))
        .map((receipt) => receipt.id);
      for (const [key, digest] of await observeProjectMcpEntries(
        this.deps.storage,
        mcp,
        mcpKeys,
        true,
      ))
        observed.set(key, digest);
      evidence.project = { environmentId: environment.id, observed };
    }
    if (target.accountHomeId !== undefined && account) {
      const entries = await accountHomeEvidence(account.provider, account.home, this.deps.homes());
      const receipts = Object.values(state.receipts).filter(
        (receipt) =>
          receipt.nodeId === target.nodeId && receipt.accountHomeId === account.accountId,
      );
      const locate = this.accountLocator(account);
      evidence.account = {
        accountHomeId: account.accountId,
        provider: account.provider,
        entries,
        observed: await observeScopedReceipts(state, receipts, (id) =>
          entries[id] === "private" ? locate(id) : undefined,
        ),
      };
    }
    return evidence;
  }
}
