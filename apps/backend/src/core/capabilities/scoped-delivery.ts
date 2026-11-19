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
 *   directories to the host's (`agent-accounts-homes.ts`), so the host copy
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

import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
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
import { CapabilityExecutor, type NodePlanResult, type NodePlanTarget } from "./executor.js";
import {
  installName,
  installedDigest,
  readLocationIndex,
  type CapabilityHomes,
} from "./native-ownership.js";
import { desiredStateForNode, type NodeDesiredState } from "./planning.js";
import {
  defaultGitRunner,
  excludePatterns,
  gitCommonDir,
  linkedAncestor,
  trackedPaths,
  writeExcludeBlock,
  type GitRunner,
} from "./project-git.js";
import {
  alsoVisibleAt,
  PROJECT_CAPABILITY_LOCATIONS,
  planScopedLocations,
  projectCapabilityLocation,
} from "./scoped-locations.js";
import { CAPABILITY_LOCATION_INDEX, removeManagedPath } from "./security.js";
import type { CapabilitiesStorage } from "../storage-capabilities.js";
import type { CapabilityState, InstallationReceipt } from "./types.js";

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
  /** This machine's environments; absent where the backend has none. */
  environments?(): Promise<ScopedEnvironment[]>;
  /** This machine's added accounts. */
  accounts?(): Promise<ScopedAccount[]>;
  /** The capability record of the container an environment runs now (`container-staging.ts`). */
  containerDelivery?(environmentId: string): Promise<ContainerDeliveryEvidence | null>;
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
        if (!FILE_KINDS.has(component.kind)) {
          undeliverable.push({
            provider,
            componentId,
            packageId: pkg.id,
            status: "unsupported",
            reason:
              component.kind === "mcp-server"
                ? "A project toolkit delivers files into the worktree; its MCP servers need My setup or the project's own MCP configuration."
                : "Only skills, commands, prompts and subagents are delivered into a worktree.",
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

export interface ScopedPassInput {
  nodeId: string;
  scope: { environmentId?: string; accountHomeId?: string };
  desired: ScopedInstallation[];
  locate(locationId: string): Located | undefined;
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
): Promise<Map<string, string | null>> {
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
    observed.set(
      receipt.id,
      await installedDigest(
        located.location,
        located.directory,
        entryName(component, located.location.layout),
      ),
    );
  }
  return observed;
}

/** A file location whose last managed file was removed keeps no empty index behind. */
async function dropEmptyIndexes(
  targets: readonly NodePlanTarget[],
  results: readonly NodePlanResult[],
  locate: (locationId: string) => Located | undefined,
): Promise<void> {
  const removed = new Set(
    results.filter((result) => result.status === "ready").map((result) => result.key),
  );
  const directories = new Set<string>();
  for (const target of targets) {
    if (target.action !== "remove" || !removed.has(target.key) || !target.locationId) continue;
    const located = locate(target.locationId);
    if (located?.location.layout === "file") directories.add(located.directory);
  }
  for (const directory of directories) {
    const index = await readLocationIndex(directory);
    if (Object.keys(index.files).length > 0) continue;
    await removeManagedPath(directory, CAPABILITY_LOCATION_INDEX).catch(() => false);
  }
}

/**
 * Observe, record drift, plan and apply one scope's copies with a located
 * executor, then record receipts. Receipts of other scopes are untouched.
 */
export async function runScopedPass(
  deps: Pick<ScopedDeliveryDeps, "storage" | "artifacts" | "homes" | "now">,
  input: ScopedPassInput,
): Promise<{ changed: boolean }> {
  const now = () => (deps.now ?? (() => new Date().toISOString()))();
  const state = await deps.storage.capabilities.loadCapabilityState();
  const existing = Object.values(state.receipts).filter((receipt) =>
    inScope(receipt, input.nodeId, input.scope),
  );
  const observed = await observeScopedReceipts(state, existing, input.locate);
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
      artifactDigest: installation.digest,
      ...(forceKeys.has(installation.key) ? { force: true } : {}),
    });
  }
  const forget: string[] = [];
  for (const receipt of existing) {
    if (desiredByKey.has(receipt.id)) continue;
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
      ...(forceKeys.has(receipt.id) ? { force: true } : {}),
    });
  }

  let results: NodePlanResult[] = [];
  if (targets.length > 0) {
    const executor = new CapabilityExecutor({
      storage: deps.storage,
      artifacts: deps.artifacts,
      homes: deps.homes,
      locate: input.locate,
      ...(deps.now ? { now: deps.now } : {}),
    });
    results = await executor.apply(targets);
    await dropEmptyIndexes(targets, results, input.locate);
  }
  if (
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
      current.receipts[key] = receiptFor(installation, {
        status: "failed",
        verification: "requested",
        digest: "",
        reason,
      });
    }
    for (const result of results) {
      const target = byKey.get(result.key);
      if (!target) continue;
      if (target.action === "remove") {
        if (result.status === "ready") {
          delete current.receipts[result.key];
          delete current.drift[`drift:${result.key}`];
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
    return { result: undefined, changed: true };
  });
  return { changed: true };
}

// --- Evidence for launch preflight ----------------------------------------------

/** What a launch can check for a target outside the machine-wide homes. */
export interface ScopedEvidence {
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
  | { kind: "verified" }
  | { kind: "refused"; reason: string }
  /** The machine-wide copy is what this target loads: check the host receipts. */
  | { kind: "host" };

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
    const item = container.record.items.find(
      (entry) =>
        entry.componentId === component.id &&
        entry.status === "staged" &&
        entry.providers.includes(target.provider),
    );
    if (item?.packageDigest === digest) return { kind: "verified" };
    return {
      kind: "refused",
      reason: item
        ? `This container was staged with an older revision of ${component.name}; rebuild it to stage the current one.`
        : `${component.name} was not staged into this container; rebuild it to stage the current setup.`,
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
    const own = Object.values(state.receipts).some(
      (receipt) =>
        receipt.nodeId === target.nodeId &&
        receipt.accountHomeId === target.accountHomeId &&
        account.entries[receipt.locationId] === "private" &&
        scopedMatch(receipt, account.observed),
    );
    if (own) return { kind: "verified" };
    return {
      kind: "refused",
      reason: `This account keeps its own copy of its ${target.provider} configuration, and the required revision of ${component.name} is not verified there yet.`,
    };
  }
  if (
    target.environmentId !== undefined &&
    evidence?.project?.environmentId === target.environmentId
  ) {
    const project = evidence.project;
    const verified = Object.values(state.receipts).some(
      (receipt) =>
        receipt.nodeId === target.nodeId &&
        receipt.environmentId === target.environmentId &&
        scopedMatch(receipt, project.observed),
    );
    if (verified) return { kind: "verified" };
  }
  return { kind: "host" };
}

// --- The service-facing class ----------------------------------------------------

const EXCLUDE_OWNER_PREFIX = "env-";

/**
 * Runs the scoped passes for this machine, one at a time, and answers
 * launch evidence. Every pass reads the newest state.
 */
export class ScopedCapabilityDelivery {
  private chain: Promise<unknown> = Promise.resolve();
  private names = new Map<string, string>();

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
  runAll(): Promise<void> {
    return this.serialized(async () => {
      let changed = false;
      const environments = (await this.deps.environments?.().catch(() => [])) ?? [];
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
        changed = (await this.deliverProject(environment, known)) || changed;
      }
      changed = (await this.forgetGoneEnvironments(known)) || changed;
      for (const account of accounts) {
        changed = (await this.deliverAccount(account)) || changed;
      }
      if (changed) this.deps.changed?.();
    });
  }

  /** One local worktree, before a launch from it. */
  deliverEnvironment(environmentId: string): Promise<void> {
    return this.serialized(async () => {
      const environments = (await this.deps.environments?.().catch(() => [])) ?? [];
      const environment = environments.find((entry) => entry.id === environmentId);
      if (!environment || environment.environmentType !== "local") return;
      const known = new Set(environments.map((entry) => entry.id));
      if (await this.deliverProject(environment, known)) this.deps.changed?.();
    });
  }

  /** The project locations of one worktree. */
  projectLocator(worktree: string): (locationId: string) => Located | undefined {
    return (locationId) => {
      const location = projectCapabilityLocation(locationId);
      return location
        ? { location, directory: path.join(worktree, ...location.relative.split("/")) }
        : undefined;
    };
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
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const gone = Object.values(state.receipts).filter(
      (receipt) => receipt.environmentId !== undefined && !known.has(receipt.environmentId),
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
  ): Promise<boolean> {
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
    const relativeEntry = (
      installation: Pick<ScopedInstallation, "packageId" | "componentId" | "digest" | "locationId">,
    ) => {
      const location = projectCapabilityLocation(installation.locationId);
      const component = revisionComponent(
        state,
        installation.packageId,
        installation.componentId,
        installation.digest,
      );
      if (!location || !component) return null;
      return {
        location,
        relative: `${location.relative}/${entryName(component, location.layout)}`,
        directory: location.layout === "directory",
      };
    };

    // Collisions: a path the repository tracks, or a directory reached through a link.
    const collisions = new Map<string, string>();
    const git = this.git();
    const commonDir = await gitCommonDir(git, worktree);
    const candidates = installations.flatMap((installation) => {
      const entry = relativeEntry(installation);
      return entry ? [{ installation, ...entry }] : [];
    });
    if (commonDir) {
      const paths = new Set<string>();
      for (const candidate of candidates) {
        paths.add(candidate.relative);
        if (!candidate.directory)
          paths.add(`${candidate.location.relative}/.orkestrator-capabilities.json`);
      }
      let tracked: Set<string>;
      try {
        tracked = await trackedPaths(git, worktree, [...paths]);
      } catch {
        // Without the index's answer nothing can be shown to be safe to write.
        tracked = new Set(paths);
      }
      for (const candidate of candidates) {
        const index = `${candidate.location.relative}/.orkestrator-capabilities.json`;
        if (tracked.has(candidate.relative) || (!candidate.directory && tracked.has(index))) {
          collisions.set(
            candidate.installation.key,
            `${candidate.relative} is tracked in this repository; Orkestrator never replaces a tracked file. Rename the component or remove the file from the repository.`,
          );
        }
      }
    }
    for (const candidate of candidates) {
      if (collisions.has(candidate.installation.key)) continue;
      const linked = await linkedAncestor(worktree, candidate.location.relative);
      if (linked) {
        collisions.set(
          candidate.installation.key,
          `${linked} in this worktree is a link or a file; Orkestrator does not write through it.`,
        );
      }
    }

    // Exclude before writing, so no status ever shows the copies.
    const owner = `${EXCLUDE_OWNER_PREFIX}${environment.id}`;
    const writable = candidates.filter((candidate) => !collisions.has(candidate.installation.key));
    const kept = existing.flatMap((receipt) => {
      if (receipt.status === "failed") return [];
      const entry = relativeEntry({ ...receipt, digest: receipt.packageDigest });
      return entry ? [entry] : [];
    });
    const keepOwner = (name: string) =>
      !name.startsWith(EXCLUDE_OWNER_PREFIX) || known.has(name.slice(EXCLUDE_OWNER_PREFIX.length));
    if (commonDir) {
      await writeExcludeBlock(commonDir, owner, excludePatterns([...writable, ...kept]), keepOwner);
    }
    const { changed } = await runScopedPass(this.deps, {
      nodeId,
      scope: { environmentId: environment.id },
      desired: installations,
      locate,
      collisions,
      removeFiles: true,
    });
    if (commonDir) {
      const after = await this.deps.storage.capabilities.loadCapabilityState();
      const remaining = Object.values(after.receipts).flatMap((receipt) => {
        if (receipt.environmentId !== environment.id || receipt.status === "failed") return [];
        const entry = relativeEntry({ ...receipt, digest: receipt.packageDigest });
        return entry ? [entry] : [];
      });
      await writeExcludeBlock(commonDir, owner, excludePatterns(remaining), keepOwner);
    }
    return changed;
  }

  private async deliverAccount(account: ScopedAccount): Promise<boolean> {
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
    const { changed } = await runScopedPass(this.deps, {
      nodeId,
      scope: { accountHomeId },
      desired,
      locate: privateLocate,
      removeFiles: Object.values(evidence).some((entry) => entry === "private"),
    });
    return changed;
  }

  /**
   * At launch: brings a local worktree's project copies up to date, then
   * collects the evidence `scopedRequiredDelivery` checks for the target
   * (the worktree's copies, the account's directories, or the container's
   * staged record).
   */
  async launchEvidence(target: CapabilityTarget): Promise<ScopedEvidence> {
    const environments = target.environmentId
      ? ((await this.deps.environments?.().catch(() => [])) ?? [])
      : [];
    const environment = environments.find((entry) => entry.id === target.environmentId) ?? null;
    if (environment?.environmentType === "local" && target.environmentIncarnation === undefined) {
      await this.deliverEnvironment(environment.id).catch(() => undefined);
    }
    const account =
      target.accountHomeId !== undefined
        ? (((await this.deps.accounts?.().catch(() => [])) ?? []).find(
            (entry) =>
              entry.accountId === target.accountHomeId && entry.provider === target.provider,
          ) ?? null)
        : null;
    const evidence = await this.evidenceFor(target, environment, account);
    if (target.environmentIncarnation !== undefined && target.environmentId) {
      evidence.container =
        (await this.deps.containerDelivery?.(target.environmentId).catch(() => null)) ?? null;
    }
    return evidence;
  }

  /** Display names for the "Where available" rows of scoped copies, from the last pass. */
  scopeNames(): ReadonlyMap<string, string> {
    return this.names;
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
      evidence.project = {
        environmentId: environment.id,
        observed: await observeScopedReceipts(
          state,
          receipts,
          this.projectLocator(environment.worktreePath),
        ),
      };
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
