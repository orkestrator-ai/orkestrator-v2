import { confinedPath } from "./security.js";
/**
 * Project setups in worktrees on other machines
 * (docs/architecture/agent-capabilities-management.md, "Shared locations and
 * isolation").
 *
 * The command node holds the setups and the receipts; the worktree and its
 * files are on the machine that owns the environment. After each pass over
 * a machine, the command node:
 *
 * 1. lists that machine's local-worktree environments from the federation
 *    read model (node summaries: environment id, project id, type) and adds
 *    every environment it already holds receipts for there;
 * 2. plans each one exactly as for its own worktrees (`desiredProjectState`)
 *    and asks the machine, in one bounded read
 *    (`get_capability_node_environment_observation`), for the digests on
 *    disk of the copies it recorded and which planned copies would collide;
 *    entries name a location id and a component, never a path;
 * 3. runs the scoped pass (`runScopedPass`) with that observation: drift is
 *    recorded and kept, unknown outcomes are settled from what is on disk,
 *    then the artifacts are staged over the existing chunked transfer and
 *    the writes go to the machine (`apply_capability_node_environment_plan`).
 *    Receipts are keyed `<node>|env:<environment>|<location>|<component>`
 *    and marked before the write, so a lost answer is observed before
 *    anything is sent again.
 *
 * The machine resolves the environment id to its own worktree from its own
 * environment store (a path never travels), checks the plan's keys belong to
 * that environment, and writes with the same rules as its own pass
 * (`worktree-writer.ts`: collisions with tracked or pre-existing files,
 * `info/exclude`, ownership markers, atomic writes), behind the executor's
 * single-writer epoch. An environment the machine no longer has releases its
 * receipts; one it still has but cannot reach now keeps them.
 */
import { promises as fs } from "node:fs";

import {
  applyCapabilityNodeEnvironmentPlanCommand,
  getCapabilityNodeEnvironmentObservationCommand,
} from "@orkestrator/protocol/contract/domains/capabilities";
import type { CapabilityTarget } from "@orkestrator/protocol/capability-resources";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import type { CapabilityArtifactStore } from "./artifact-store.js";
import {
  parseNodePlanTargets,
  type McpInstaller,
  type NodePlanResult,
  type NodePlanTarget,
} from "./executor.js";
import type { CapabilityHomes } from "./native-ownership.js";
import type { CapabilityLink } from "./node-transport.js";
import { desiredStateForNode } from "./planning.js";
import { defaultGitRunner, type GitRunner } from "./project-git.js";
import { classifyTransportError, OutcomeUnknownError } from "./reconciler.js";
import {
  desiredProjectState,
  observable,
  revisionComponent,
  runScopedPass,
  type ScopedDeliveryDeps,
  type ScopedEnvironment,
  type ScopedInstallation,
} from "./scoped-delivery.js";
import { observeProjectMcpEntries, projectMcpInstaller } from "./project-mcp.js";
import { projectCapabilityLocation, projectMcpLocation } from "./scoped-locations.js";
import { CapabilityError } from "./security.js";
import type { CapabilitiesStorage } from "../storage-capabilities.js";
import type { CapabilityState, InstallationReceipt } from "./types.js";
import type { LeafScopedReport } from "./launch-authority.js";
import {
  applyWorktreePlan,
  managedWorktreeEntries,
  observeWorktreeEntries,
  worktreeCollisions,
  type WorktreeEntry,
} from "./worktree-writer.js";

const log = createLogger("capabilities");

/** Environments one observation asks about, at most. */
export const MAX_REMOTE_ENVIRONMENTS = 200;
/** Entries per environment and list, at most. */
const MAX_ENTRIES = 2_000;
const MAX_REASON = 500;

export type RemoteEnvironmentState = "present" | "missing" | "unavailable";

export interface RemoteScopedDeps {
  storage: { capabilities: CapabilitiesStorage };
  artifacts: CapabilityArtifactStore;
  homes(): CapabilityHomes;
  selfId(): Promise<string>;
  resolve: ScopedDeliveryDeps["resolve"];
  now?: () => string;
  // Executor side: this machine's own environments, containers and their MCP management.
  environments?(): Promise<ScopedEnvironment[]>;
  containerDelivery?: ScopedDeliveryDeps["containerDelivery"];
  projectMcp?(environmentId: string): McpInstaller | undefined;
  git?: GitRunner;
  // Command side.
  link(nodeId: string): CapabilityLink | null;
  /** Another machine's environments (federation read model); null when not known. */
  remoteEnvironments?(nodeId: string): Promise<ScopedEnvironment[] | null>;
  /** Makes sure the machine holds an artifact (`remoteTransport().stage`). */
  stage(nodeId: string, epoch: number, digest: string): Promise<void>;
  /** Names for the "Where available" rows of those worktrees. */
  noteNames?(names: ReadonlyMap<string, string>): void;
  changed?(): void;
}

function scopedKeyPrefix(nodeId: string, environmentId: string): string {
  return `${nodeId}|env:${environmentId}|`;
}

/** A worktree's file directories and its project MCP files. */
function isProjectLocation(locationId: string): boolean {
  return (
    projectCapabilityLocation(locationId) !== undefined ||
    projectMcpLocation(locationId) !== undefined
  );
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

/** Entries from a peer: bounded, in this environment's key space, at a project location. */
function parseEntries(value: unknown, prefix: string): WorktreeEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CapabilityError("invalid-request", "Expected a list.");
  if (value.length > MAX_ENTRIES)
    throw new CapabilityError("too-large", "Too many entries for one environment.");
  return value.map((raw: unknown) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const key = text(entry.key, 1_024);
    const locationId = text(entry.locationId, 128);
    const componentName = text(entry.componentName, 200);
    const pathOrKey = typeof entry.pathOrKey === "string" ? entry.pathOrKey.slice(0, 512) : "";
    if (!key?.startsWith(prefix) || !locationId || !isProjectLocation(locationId)) {
      throw new CapabilityError("invalid-request", "An entry does not belong to this environment.");
    }
    if (!componentName) throw new CapabilityError("invalid-request", "An entry has no name.");
    return { key, locationId, componentName, pathOrKey };
  });
}

function entryFor(
  state: CapabilityState,
  key: string,
  item: Pick<InstallationReceipt, "packageId" | "componentId" | "locationId">,
  digest: string,
): WorktreeEntry[] {
  const component = revisionComponent(state, item.packageId, item.componentId, digest);
  return component
    ? [
        {
          key,
          locationId: item.locationId,
          componentName: component.name,
          pathOrKey: component.pathOrKey,
        },
      ]
    : [];
}

interface ObservedEnvironment {
  state: RemoteEnvironmentState;
  observed: Map<string, string | null>;
  collisions: Map<string, string>;
}

/** The machine's answer, bounded: it is input from a peer. */
function parseObservation(
  value: unknown,
  asked: ReadonlyMap<string, { keys: ReadonlySet<string> }>,
): Map<string, ObservedEnvironment> {
  const result = new Map<string, ObservedEnvironment>();
  const list = (value as { environments?: unknown } | null)?.environments;
  if (!Array.isArray(list)) throw new OutcomeUnknownError();
  for (const raw of list.slice(0, MAX_REMOTE_ENVIRONMENTS)) {
    const record = (raw ?? {}) as Record<string, unknown>;
    const environmentId = text(record.environmentId, 256);
    const request = environmentId ? asked.get(environmentId) : undefined;
    const state = record.state;
    if (!environmentId || !request) continue;
    if (state !== "present" && state !== "missing" && state !== "unavailable") continue;
    const observed = new Map<string, string | null>();
    const collisions = new Map<string, string>();
    const digests = (record.observed ?? {}) as Record<string, unknown>;
    for (const key of request.keys) {
      if (!Object.hasOwn(digests, key)) continue;
      const digest = digests[key];
      if (digest === null) observed.set(key, null);
      else if (text(digest, 200)) observed.set(key, digest as string);
    }
    const reasons = (record.collisions ?? {}) as Record<string, unknown>;
    for (const key of request.keys) {
      const reason = Object.hasOwn(reasons, key) ? text(reasons[key], MAX_REASON) : undefined;
      if (reason) collisions.set(key, reason);
    }
    result.set(environmentId, { state, observed, collisions });
  }
  return result;
}

function parseResults(value: unknown, targets: readonly NodePlanTarget[]): NodePlanResult[] {
  const keys = new Set(targets.map((target) => target.key));
  const list = (value as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) throw new OutcomeUnknownError();
  return list.slice(0, targets.length).flatMap((raw: unknown) => {
    const record = (raw ?? {}) as Record<string, unknown>;
    const key = text(record.key, 1_024);
    if (!key || !keys.has(key) || typeof record.status !== "string") return [];
    return [
      {
        key,
        status: record.status as NodePlanResult["status"],
        verification: (text(record.verification, 64) ??
          "requested") as NodePlanResult["verification"],
        ...(text(record.digest, 200) ? { digest: record.digest as string } : {}),
        ...(text(record.reason, MAX_REASON) ? { reason: record.reason as string } : {}),
      },
    ];
  });
}

/**
 * Worktrees on other machines: planned and recorded here, written there.
 * Also answers the two executor commands for this machine's own worktrees.
 */
export class RemoteScopedDelivery {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RemoteScopedDeps) {}

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private git(): GitRunner {
    return this.deps.git ?? defaultGitRunner;
  }

  // --- Command side -------------------------------------------------------------

  /**
   * One machine's worktrees, after its reconcile pass. Answers whether an
   * outcome is unknown, so the reconciler observes again soon.
   */
  deliverNode(nodeId: string): Promise<{ recheck: boolean }> {
    return this.serialized(() => this.deliverNodeNow(nodeId));
  }

  private async deliverNodeNow(nodeId: string): Promise<{ recheck: boolean }> {
    const none = { recheck: false };
    const selfId = await this.deps.selfId();
    if (nodeId === selfId) return none;
    const link = this.deps.link(nodeId);
    if (!link?.connected) return none;
    const listed = (await this.deps.remoteEnvironments?.(nodeId).catch(() => null)) ?? null;
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const receipts = Object.values(state.receipts).filter(
      (receipt) => receipt.nodeId === nodeId && receipt.environmentId !== undefined,
    );
    const local = new Map(
      (listed ?? [])
        .filter((environment) => environment.environmentType === "local")
        .map((environment) => [environment.id, environment]),
    );
    const assigned = (environment: ScopedEnvironment) =>
      (state.assignments[`project:${environment.projectId}`]?.setupIds.length ?? 0) +
        (state.assignments[`environment:${environment.id}`]?.setupIds.length ?? 0) >
      0;
    const ids = [
      ...new Set([
        ...receipts.map((receipt) => receipt.environmentId!),
        ...[...local.values()].filter(assigned).map((environment) => environment.id),
      ]),
    ]
      .sort()
      .slice(0, MAX_REMOTE_ENVIRONMENTS);
    if (ids.length === 0) return none;
    this.deps.noteNames?.(
      new Map(
        [...local.values()].map((environment): [string, string] => [
          `env:${environment.id}`,
          environment.name ?? environment.id,
        ]),
      ),
    );

    const host = desiredStateForNode(state, nodeId, state.machines[nodeId]?.inventory);
    const plans = new Map<string, ScopedInstallation[] | null>();
    const asked = new Map<string, { keys: Set<string> }>();
    const requests = ids.map((environmentId) => {
      const environment = local.get(environmentId);
      // Not in the read model (stale or truncated): observe only, change nothing.
      const desired = environment
        ? desiredProjectState(state, nodeId, environment, host, this.deps.resolve).installations
        : null;
      plans.set(environmentId, desired);
      const observe = receipts
        .filter((receipt) => receipt.environmentId === environmentId && observable(receipt))
        .flatMap((receipt) =>
          entryFor(
            state,
            receipt.id,
            receipt,
            receipt.pendingWrite?.packageDigest ?? receipt.packageDigest,
          ),
        );
      const probe = (desired ?? []).flatMap((installation) =>
        entryFor(state, installation.key, installation, installation.digest),
      );
      asked.set(environmentId, {
        keys: new Set([...observe, ...probe].map((entry) => entry.key)),
      });
      return { environmentId, observe, probe };
    });

    let answer: Map<string, ObservedEnvironment>;
    try {
      answer = parseObservation(
        await link.invokeCommand(getCapabilityNodeEnvironmentObservationCommand, {
          controllerId: selfId,
          epoch: state.epoch,
          environments: requests as never,
        }),
        asked,
      );
    } catch (error) {
      // Offline, too old or refused: nothing changes; the next pass asks again.
      const classified = classifyTransportError(
        error,
        getCapabilityNodeEnvironmentObservationCommand.name,
      );
      log.warn("reconcile.scoped-failed", { code: classified.name });
      return none;
    }

    let changed = false;
    let recheck = false;
    for (const environmentId of ids) {
      const seen = answer.get(environmentId);
      if (!seen) continue;
      if (seen.state === "missing") {
        changed = this.forgetEnvironment(nodeId, environmentId) || changed;
        continue;
      }
      const desired = plans.get(environmentId);
      if (seen.state !== "present" || !desired) continue;
      try {
        const pass = await runScopedPass(this.deps, {
          nodeId,
          scope: { environmentId },
          desired,
          collisions: seen.collisions,
          removeFiles: true,
          io: {
            durable: true,
            observe: async () => seen.observed,
            apply: (targets) => this.applyRemote(link, nodeId, environmentId, state.epoch, targets),
          },
        });
        changed = pass.changed || changed;
        recheck = pass.unknown === true || recheck;
      } catch (error) {
        log.warn("reconcile.scoped-failed", { error: formatLogError(error, { message: false }) });
      }
    }
    if (changed) this.deps.changed?.();
    return { recheck };
  }

  private forgetEnvironment(nodeId: string, environmentId: string): boolean {
    // The worktree went with its environment; there is nothing left to remove.
    return this.deps.storage.capabilities.mutateCapabilityState((current) => {
      let changed = false;
      for (const receipt of Object.values(current.receipts)) {
        if (receipt.nodeId !== nodeId || receipt.environmentId !== environmentId) continue;
        delete current.receipts[receipt.id];
        delete current.drift[`drift:${receipt.id}`];
        changed = true;
      }
      return { result: changed, changed };
    });
  }

  private async applyRemote(
    link: CapabilityLink,
    nodeId: string,
    environmentId: string,
    epoch: number,
    targets: NodePlanTarget[],
  ): Promise<NodePlanResult[]> {
    const digests = new Set(
      targets.flatMap((target) =>
        target.action !== "remove" && target.artifactDigest ? [target.artifactDigest] : [],
      ),
    );
    // Nothing is written before every artifact is there.
    for (const digest of digests) await this.deps.stage(nodeId, epoch, digest);
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const removing = new Set(
      targets.filter((target) => target.action === "remove").map((target) => target.key),
    );
    const keep = Object.values(state.receipts)
      .filter(
        (receipt) =>
          receipt.nodeId === nodeId &&
          receipt.environmentId === environmentId &&
          (receipt.status !== "failed" || removing.has(receipt.id)),
      )
      .flatMap((receipt) => entryFor(state, receipt.id, receipt, receipt.packageDigest));
    let answer: unknown;
    try {
      answer = await link.invokeCommand(applyCapabilityNodeEnvironmentPlanCommand, {
        controllerId: await this.deps.selfId(),
        epoch,
        operationId: "scoped",
        environmentId,
        targets: targets as never,
        keep: keep as never,
      });
    } catch (error) {
      throw classifyTransportError(error, applyCapabilityNodeEnvironmentPlanCommand.name);
    }
    if ((answer as { found?: unknown } | null)?.found !== true) {
      throw new CapabilityError("not-found", "The environment is not on that machine any more.");
    }
    return parseResults(answer, targets);
  }

  // --- Executor side: this machine's worktrees ------------------------------------

  private async localWorktree(
    environmentId: string,
  ): Promise<{ state: RemoteEnvironmentState; worktree?: string; known: Set<string> }> {
    const environments = await this.deps.environments?.().catch(() => undefined);
    if (!environments) return { state: "unavailable", known: new Set() };
    const known = new Set(environments.map((environment) => environment.id));
    const environment = environments.find(
      (entry) => entry.id === environmentId && entry.environmentType === "local",
    );
    if (!environment) return { state: "missing", known };
    const worktree = environment.worktreePath;
    const stat = worktree ? await fs.stat(worktree).catch(() => null) : null;
    if (!worktree || !stat?.isDirectory()) return { state: "unavailable", known };
    return { state: "present", worktree, known };
  }

  /**
   * A leaf's launch: the target's own copies on this machine, for the
   * command node to verify (`LeafScopedReport`): the managed copies in the
   * environment's worktree with their digests, or its container's staged
   * record and label. Ids and digests only.
   */
  async leafReport(
    target: CapabilityTarget,
    relativeWorktree?: string,
  ): Promise<LeafScopedReport | undefined> {
    if (!target.environmentId) return undefined;
    if (target.environmentIncarnation !== undefined) {
      const delivery = await this.deps.containerDelivery?.(target.environmentId).catch(() => null);
      if (!delivery) return undefined;
      return {
        container: {
          containerId: delivery.containerId,
          labelDigest: delivery.labelDigest,
          record: delivery.record
            ? {
                ...delivery.record,
                // Reasons can name components; the command node needs only the ids.
                items: delivery.record.items.map(({ reason: _reason, ...item }) => item),
              }
            : null,
        },
      };
    }
    const local = await this.localWorktree(target.environmentId);
    if (local.state !== "present" || !local.worktree) return undefined;
    const selfId = await this.deps.selfId();
    const worktree = relativeWorktree
      ? confinedPath(local.worktree, relativeWorktree)
      : local.worktree;
    const project = await managedWorktreeEntries(worktree);
    const executor = await this.deps.storage.capabilities.loadCapabilityExecutorState();
    const prefix = scopedKeyPrefix(selfId, target.environmentId);
    const mcpApplied = (relativeWorktree ? [] : Object.entries(executor.applied)).filter(
      ([key, entry]) =>
        key.startsWith(prefix) &&
        entry.componentId !== undefined &&
        projectMcpLocation(key.slice(prefix.length).split("|")[0] ?? "") !== undefined,
    );
    if (mcpApplied.length > 0) {
      const base = this.deps.projectMcp?.(target.environmentId);
      const observed = await observeProjectMcpEntries(
        this.deps.storage,
        base
          ? projectMcpInstaller(base, {
              storage: this.deps.storage,
              nodeId: selfId,
              environmentId: target.environmentId,
              worktree: local.worktree,
            })
          : undefined,
        mcpApplied.map(([key]) => key),
      );
      for (const [key, entry] of mcpApplied) {
        const digest = observed.get(key);
        if (digest) {
          project.push({
            locationId: key.slice(prefix.length).split("|")[0]!,
            componentId: entry.componentId!,
            digest,
          });
        }
      }
    }
    return { project };
  }

  /** `get_capability_node_environment_observation` (epoch already admitted). */
  observeForController(args: Record<string, unknown>): Promise<{ environments: unknown[] }> {
    return this.serialized(async () => {
      const selfId = await this.deps.selfId();
      const list = args.environments;
      if (!Array.isArray(list) || list.length > MAX_REMOTE_ENVIRONMENTS) {
        throw new CapabilityError("invalid-request", "Expected a bounded list of environments.");
      }
      const environments: unknown[] = [];
      for (const raw of list) {
        const record = (raw ?? {}) as Record<string, unknown>;
        const environmentId = text(record.environmentId, 256);
        if (!environmentId)
          throw new CapabilityError("invalid-request", "environmentId is required.");
        const prefix = scopedKeyPrefix(selfId, environmentId);
        const observe = parseEntries(record.observe, prefix);
        const probe = parseEntries(record.probe, prefix);
        const local = await this.localWorktree(environmentId);
        if (local.state !== "present" || !local.worktree) {
          environments.push({ environmentId, state: local.state });
          continue;
        }
        const [observed, collisions] = await Promise.all([
          observeWorktreeEntries(local.worktree, observe),
          worktreeCollisions(this.git(), local.worktree, probe),
        ]);
        // Project MCP servers are observed through this machine's MCP management.
        const base = this.deps.projectMcp?.(environmentId);
        const mcp = base
          ? projectMcpInstaller(base, {
              storage: this.deps.storage,
              nodeId: selfId,
              environmentId,
              worktree: local.worktree,
            })
          : undefined;
        const mcpKeys = observe
          .filter((entry) => projectMcpLocation(entry.locationId))
          .map((entry) => entry.key);
        for (const [key, digest] of await observeProjectMcpEntries(this.deps.storage, mcp, mcpKeys))
          observed.set(key, digest);
        environments.push({
          environmentId,
          state: "present",
          observed: Object.fromEntries(observed),
          collisions: Object.fromEntries(collisions),
        });
      }
      return { environments };
    });
  }

  /** `apply_capability_node_environment_plan` (epoch already admitted). */
  applyForController(
    args: Record<string, unknown>,
  ): Promise<{ found: boolean; results: NodePlanResult[] }> {
    return this.serialized(async () => {
      const selfId = await this.deps.selfId();
      const environmentId = text(args.environmentId, 256);
      if (!environmentId)
        throw new CapabilityError("invalid-request", "environmentId is required.");
      const prefix = scopedKeyPrefix(selfId, environmentId);
      const targets = parseNodePlanTargets(args.targets, isProjectLocation);
      if (targets.some((target) => !target.key.startsWith(prefix) || !target.locationId)) {
        throw new CapabilityError(
          "invalid-request",
          "A plan target does not belong to this environment.",
        );
      }
      const keep = parseEntries(args.keep, prefix);
      const local = await this.localWorktree(environmentId);
      if (local.state !== "present" || !local.worktree) return { found: false, results: [] };
      const results = await applyWorktreePlan(
        {
          storage: this.deps.storage,
          artifacts: this.deps.artifacts,
          homes: () => this.deps.homes(),
          git: this.git(),
          ...(this.deps.projectMcp?.(environmentId)
            ? { projectMcp: this.deps.projectMcp(environmentId)! }
            : {}),
          ...(this.deps.now ? { now: this.deps.now } : {}),
        },
        {
          nodeId: selfId,
          worktree: local.worktree,
          environmentId,
          targets,
          keep,
          knownEnvironment: (id) => local.known.has(id),
        },
      );
      return { found: true, results };
    });
  }
}
