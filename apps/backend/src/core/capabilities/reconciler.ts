/**
 * Durable reconciliation of every enrolled machine against the latest
 * desired state (docs/architecture/agent-capabilities-management.md,
 * "Reconciliation and remote safety").
 *
 * One pass for one machine:
 *
 * 1. **Observe** its inventory (this machine directly, another over its node
 *    link). A machine that does not answer is `offline`: its desired state is
 *    kept and nothing is queued against it.
 * 2. **Settle unknown outcomes** from that observation: an earlier write whose
 *    answer was lost is confirmed if its bytes are there, and forgotten (so
 *    it is planned again from scratch) if they are not. A lost write is never
 *    re-sent blindly.
 * 3. **Record drift**: a managed item whose bytes changed, or that
 *    disappeared, becomes a Local changes entry and is left alone.
 * 4. **Plan** against the newest desired state, **stage** the artifacts it
 *    needs, and **apply**. An answer that does not prove the write happened
 *    (a timeout, a dropped link) marks those keys `outcome-unknown` and
 *    schedules another observation.
 *
 * Passes for one machine never overlap; a trigger during a pass runs one
 * more after it. Triggers: a change here, a machine connecting, app start
 * (which resumes every operation still in flight) and a periodic timer.
 * Running sessions are never restarted to meet a deadline.
 */
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import type { CapabilityTargetStatus } from "@orkestrator/protocol/capability-resources";
import type { CapabilityInventory } from "@orkestrator/protocol/capability-resources-api";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import type { CapabilitiesStorage } from "../storage-capabilities.js";
import { CapabilityArtifactStore } from "./artifact-store.js";
import { capabilityLocation } from "@orkestrator/protocol/capability-resources-support";

import { componentFiles, type NodePlanResult, type NodePlanTarget } from "./executor.js";
import { installName } from "./native-ownership.js";
import {
  finalizeOperation,
  newCorrelationId,
  recordActivity,
  updateOperationTargets,
} from "./operations.js";
import { desiredStateForNode, observedInstallations, planNode } from "./planning.js";
import { CapabilityError, treeDigest } from "./security.js";
import type { CapabilityState, InstallationReceipt } from "./types.js";

const log = createLogger("capabilities");

export class NodeOfflineError extends Error {
  constructor() {
    super("The machine is not connected.");
    this.name = "NodeOfflineError";
  }
}

export class NodeTooOldError extends Error {
  constructor() {
    super("This machine's Orkestrator predates capability management.");
    this.name = "NodeTooOldError";
  }
}

/** A write whose outcome the transport cannot prove either way. */
export class OutcomeUnknownError extends Error {
  constructor() {
    super("The machine did not confirm the result.");
    this.name = "OutcomeUnknownError";
  }
}

/** How the reconciler reaches one machine. */
export interface CapabilityNodeTransport {
  observe(nodeId: string, epoch: number): Promise<CapabilityInventory>;
  /** Makes sure the machine holds `digest`, sending it in chunks when it does not. */
  stage(nodeId: string, epoch: number, digest: string): Promise<void>;
  apply(
    nodeId: string,
    epoch: number,
    operationId: string,
    targets: NodePlanTarget[],
  ): Promise<NodePlanResult[]>;
}

export interface CapabilityReconcilerDeps {
  storage: { capabilities: CapabilitiesStorage };
  artifacts: CapabilityArtifactStore;
  selfId(): Promise<string>;
  /** Every machine this command node knows, with whether it is reachable now. */
  machines(): Promise<Array<{ nodeId: string; name: string; connected: boolean }>>;
  transport: CapabilityNodeTransport;
  emit(change: { packageIds: string[]; setupIds: string[]; operationIds: string[] }): void;
  /** Whether this node holds capability authority (it is not someone's leaf). */
  isAuthority(): boolean;
  now?: () => string;
  /** Delay before re-observing after an unknown outcome. */
  recheckMs?: number;
}

/** Classifies a transport failure into the vocabulary above. */
export function classifyTransportError(error: unknown, command: string): Error {
  if (
    error instanceof NodeOfflineError ||
    error instanceof NodeTooOldError ||
    error instanceof OutcomeUnknownError
  ) {
    return error;
  }
  if (incompatibility(error, command)?.code === "unknown-command") return new NodeTooOldError();
  if (error instanceof CapabilityError) return error;
  return new OutcomeUnknownError();
}

export class CapabilityReconciler {
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly rechecks = new Map<string, ReturnType<typeof setTimeout>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly deps: CapabilityReconcilerDeps) {}

  private now(): string {
    return (this.deps.now ?? (() => new Date().toISOString()))();
  }

  /** Starts the periodic pass and resumes what a previous run left in flight. */
  start(intervalMs = 5 * 60_000): void {
    if (this.timer || this.disposed) return;
    void this.reconcileAll("start").catch(() => undefined);
    this.timer = setInterval(
      () => void this.reconcileAll("timer").catch(() => undefined),
      intervalMs,
    );
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.rechecks.values()) clearTimeout(timer);
    this.rechecks.clear();
  }

  /** Waits for every pass in flight (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled(this.running.values());
  }

  async reconcileAll(reason: string): Promise<void> {
    if (this.disposed || !this.deps.isAuthority()) return;
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const machines = await this.deps.machines().catch(() => []);
    const selfId = await this.deps.selfId();
    const ids = new Set<string>([selfId, ...machines.map((machine) => machine.nodeId)]);
    await Promise.all(
      [...ids]
        .filter((nodeId) => state.machines[nodeId]?.enrolled !== false)
        .map((nodeId) => this.reconcileNode(nodeId, reason)),
    );
  }

  /** One machine; concurrent calls share a pass, and a call during one runs once more after it. */
  reconcileNode(nodeId: string, reason: string): Promise<void> {
    if (this.disposed || !this.deps.isAuthority()) return Promise.resolve();
    const running = this.running.get(nodeId);
    if (running) {
      this.again.add(nodeId);
      return running;
    }
    const run = (async () => {
      for (let pass = 0; pass < 3; pass += 1) {
        this.again.delete(nodeId);
        try {
          await this.passOnce(nodeId, reason);
        } catch (error) {
          log.warn("reconcile.failed", { error: formatLogError(error, { message: false }) });
          return;
        }
        if (!this.again.has(nodeId) || this.disposed) return;
      }
    })().finally(() => this.running.delete(nodeId));
    this.running.set(nodeId, run);
    return run;
  }

  private scheduleRecheck(nodeId: string): void {
    if (this.disposed || this.rechecks.has(nodeId)) return;
    const timer = setTimeout(() => {
      this.rechecks.delete(nodeId);
      void this.reconcileNode(nodeId, "recheck");
    }, this.deps.recheckMs ?? 15_000);
    timer.unref?.();
    this.rechecks.set(nodeId, timer);
  }

  private markNode(nodeId: string, status: CapabilityTargetStatus, reason: string): void {
    const touched = this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const results = new Map<string, { status: CapabilityTargetStatus; reason?: string }>();
      for (const operation of Object.values(state.operations)) {
        for (const target of operation.targets) {
          if (
            target.target.nodeId === nodeId &&
            (target.status === "pending" || target.status === "outcome-unknown")
          ) {
            results.set(target.key, { status, reason });
          }
        }
      }
      if (results.size === 0) return { result: [] as string[], changed: false };
      return { result: updateOperationTargets(state, results), changed: true };
    });
    if (touched.length > 0) this.deps.emit({ packageIds: [], setupIds: [], operationIds: touched });
  }

  private async passOnce(nodeId: string, reason: string): Promise<void> {
    let state = await this.deps.storage.capabilities.loadCapabilityState();
    const epoch = state.epoch;
    let inventory: CapabilityInventory;
    try {
      inventory = await this.deps.transport.observe(nodeId, epoch);
    } catch (error) {
      const classified = classifyTransportError(error, "get_capability_node_observation");
      if (classified instanceof NodeTooOldError) {
        this.markNode(nodeId, "unsupported", classified.message);
      } else if (classified instanceof CapabilityError && classified.code === "stale-epoch") {
        this.markNode(nodeId, "blocked-policy", classified.message);
      } else {
        this.markNode(nodeId, "offline", "Waiting for the machine to connect.");
      }
      return;
    }

    // What an unanswered write would have left on disk, from the artifact itself.
    const expectedDigests = new Map<string, string>();
    for (const receipt of Object.values(state.receipts)) {
      if (receipt.nodeId !== nodeId || !receipt.outcomeUnknown) continue;
      const expected = await expectedInstalledDigest(this.deps.artifacts, state, receipt).catch(
        () => undefined,
      );
      if (expected) expectedDigests.set(receipt.id, expected);
    }

    // Record the observation, settle unknown outcomes and note drift.
    const forceKeys = new Set<string>();
    const driftKeys = new Set<string>();
    this.deps.storage.capabilities.mutateCapabilityState((current) => {
      const now = this.now();
      const machine = (current.machines[nodeId] ??= {
        nodeId,
        enrolled: current.settings.enrollNewMachines,
        groups: [],
      });
      machine.inventory = inventory;
      machine.lastObservedAt = now;
      machine.lastSeenAt = now;
      const observed = observedInstallations(nodeId, inventory);
      for (const receipt of Object.values(current.receipts)) {
        if (receipt.nodeId !== nodeId) continue;
        const fileKind =
          !receipt.locationId.startsWith("mcp:") && !receipt.locationId.startsWith("plugin:");
        const seen = observed.byKey.get(receipt.id);
        if (receipt.outcomeUnknown) {
          const expected = expectedDigests.get(receipt.id) ?? receipt.digest;
          if (
            fileKind &&
            expected &&
            seen?.digest === expected &&
            seen.packageId === receipt.packageId
          ) {
            receipt.outcomeUnknown = false;
            receipt.digest = expected;
            receipt.status = "installed-next-session";
            receipt.verification = "present";
          } else if (fileKind) {
            // Observed absent or different: the write did not land. Plan it afresh.
            delete current.receipts[receipt.id];
          }
          continue;
        }
        if (!fileKind || receipt.status === "unsupported" || receipt.status === "failed") continue;
        const driftId = `drift:${receipt.id}`;
        const existing = current.drift[driftId];
        if (!seen || seen.drifted || (seen.digest && seen.digest !== receipt.digest)) {
          if (!existing || existing.state !== "open") {
            if (existing?.state === "replaced") {
              forceKeys.add(receipt.id);
              continue;
            }
            if (existing?.state === "kept-local") {
              driftKeys.add(receipt.id);
              continue;
            }
            current.drift[driftId] = {
              id: driftId,
              nodeId,
              provider: receipt.providers[0] ?? "claude",
              locationId: receipt.locationId,
              componentId: receipt.componentId,
              packageId: receipt.packageId,
              name: current.components[receipt.componentId]?.name ?? receipt.componentId,
              kind: seen ? "modified" : "removed",
              expectedDigest: receipt.digest,
              ...(seen?.digest ? { observedDigest: seen.digest } : {}),
              detectedAt: now,
              state: "open",
            };
            receipt.status = "drifted";
          }
          driftKeys.add(receipt.id);
        } else if (existing?.state === "open") {
          // The bytes match again: the local change was undone.
          delete current.drift[driftId];
          if (receipt.status === "drifted") receipt.status = "installed-next-session";
        }
      }
      return { result: undefined, changed: true };
    });

    state = await this.deps.storage.capabilities.loadCapabilityState();
    for (const entry of Object.values(state.drift)) {
      const key = entry.id.startsWith("drift:") ? entry.id.slice("drift:".length) : undefined;
      if (!key || entry.nodeId !== nodeId) continue;
      if (entry.state === "open" || entry.state === "kept-local") driftKeys.add(key);
      if (entry.state === "replaced") forceKeys.add(key);
    }
    const desired = desiredStateForNode(state, nodeId, inventory);
    const plan = planNode(state, desired, { connected: true, forceKeys, driftKeys });

    // Planned targets that will not be written settle now (unsupported, drift, kept).
    const settled = new Map<string, { status: CapabilityTargetStatus; reason?: string }>();
    for (const target of plan.planned) {
      if (target.action === "skip" || target.action === "keep") {
        settled.set(target.key, {
          status: target.status,
          ...(target.reason ? { reason: target.reason } : {}),
        });
      }
    }

    let results: NodePlanResult[] = [];
    let unknown = false;
    const operationId = this.activeOperationFor(state, nodeId) ?? `reconcile:${reason}`;
    if (plan.targets.length > 0) {
      try {
        const digests = [
          ...new Set(
            plan.targets.flatMap((target) =>
              target.artifactDigest && target.action !== "remove" ? [target.artifactDigest] : [],
            ),
          ),
        ];
        for (const digest of digests) await this.deps.transport.stage(nodeId, epoch, digest);
        results = await this.deps.transport.apply(nodeId, epoch, operationId, plan.targets);
      } catch (error) {
        const classified = classifyTransportError(error, "apply_capability_node_plan");
        if (classified instanceof NodeTooOldError) {
          for (const target of plan.targets)
            settled.set(target.key, { status: "unsupported", reason: classified.message });
        } else if (classified instanceof CapabilityError) {
          for (const target of plan.targets) {
            settled.set(target.key, {
              status: classified.code === "stale-epoch" ? "blocked-policy" : "failed",
              reason: classified.message,
            });
          }
        } else {
          unknown = true;
          for (const target of plan.targets)
            settled.set(target.key, {
              status: "outcome-unknown",
              reason: "Checking what the machine applied.",
            });
        }
      }
    }

    const byKey = new Map(plan.targets.map((target) => [target.key, target]));
    const touched = this.deps.storage.capabilities.mutateCapabilityState((current) => {
      const now = this.now();
      const desiredByKey = new Map(desired.installations.map((entry) => [entry.key, entry]));
      for (const result of results) {
        const target = byKey.get(result.key);
        if (!target) continue;
        settled.set(result.key, {
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
        });
        if (target.action === "remove") {
          if (result.status === "ready") delete current.receipts[result.key];
          continue;
        }
        const installation = desiredByKey.get(result.key);
        if (!installation) continue;
        if (result.status === "drifted") {
          current.drift[`drift:${result.key}`] ??= {
            id: `drift:${result.key}`,
            nodeId,
            provider: installation.providers[0]!,
            locationId: installation.locationId,
            componentId: installation.componentId,
            packageId: installation.packageId,
            name: current.components[installation.componentId]?.name ?? installation.componentId,
            kind: current.receipts[result.key] ? "modified" : "unmanaged",
            ...(result.digest ? { observedDigest: result.digest } : {}),
            detectedAt: now,
            state: "open",
          };
          continue;
        }
        const receipt: InstallationReceipt = {
          id: result.key,
          nodeId,
          locationId: installation.locationId,
          componentId: installation.componentId,
          packageId: installation.packageId,
          digest: result.digest ?? installation.digest,
          packageDigest: installation.digest,
          references: installation.references,
          providers: installation.providers,
          alsoVisibleTo: installation.alsoVisibleTo,
          status: result.status,
          verification: result.verification,
          ...(result.reason ? { reason: result.reason } : {}),
          operationId,
          appliedAt: now,
        };
        current.receipts[result.key] = receipt;
        if (forceKeys.has(result.key) && result.status !== "failed")
          delete current.drift[`drift:${result.key}`];
      }
      if (unknown) {
        for (const target of plan.targets) {
          const installation = desiredByKey.get(target.key);
          const existing = current.receipts[target.key];
          if (existing) existing.outcomeUnknown = true;
          else if (installation && target.action !== "remove") {
            current.receipts[target.key] = {
              id: target.key,
              nodeId,
              locationId: installation.locationId,
              componentId: installation.componentId,
              packageId: installation.packageId,
              digest: "",
              packageDigest: installation.digest,
              references: installation.references,
              providers: installation.providers,
              alsoVisibleTo: installation.alsoVisibleTo,
              status: "outcome-unknown",
              verification: "requested",
              operationId,
              appliedAt: now,
              outcomeUnknown: true,
            };
          }
        }
      }
      const machine = current.machines[nodeId];
      const allSettled = !unknown && results.every((result) => result.status !== "failed");
      if (machine && allSettled) {
        machine.appliedManifestDigest = desired.manifestDigest;
        machine.syncedRevision = current.revision;
      }
      const ids = updateOperationTargets(current, settled);
      for (const id of ids) {
        const operation = current.operations[id];
        if (operation) finalizeOperation(operation);
      }
      if (results.length > 0) {
        recordActivity(current, {
          action: "reconcile",
          summary: `Applied ${results.filter((result) => result.status !== "failed").length} of ${results.length} changes on ${nodeId}.`,
          packageIds: [...new Set(plan.targets.map((target) => target.packageId))].slice(0, 50),
          setupIds: [],
          ...(operationId.startsWith("capop_") ? { operationId } : {}),
          correlationId: newCorrelationId(),
        });
      }
      return { result: ids, changed: true };
    });
    this.deps.emit({ packageIds: [], setupIds: [], operationIds: touched });
    if (unknown) this.scheduleRecheck(nodeId);
  }

  private activeOperationFor(state: CapabilityState, nodeId: string): string | undefined {
    return Object.values(state.operations)
      .filter(
        (operation) =>
          (operation.state === "applying" || operation.state === "observing") &&
          operation.targets.some((target) => target.target.nodeId === nodeId),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
  }
}

/** The digest the executor records for a receipt's component, computed from the package artifact. */
export async function expectedInstalledDigest(
  artifacts: CapabilityArtifactStore,
  state: CapabilityState,
  receipt: InstallationReceipt,
): Promise<string | undefined> {
  const component = state.components[receipt.componentId];
  const location = capabilityLocation(receipt.locationId);
  if (!component || !location || !receipt.packageDigest) return undefined;
  const files = componentFiles(await artifacts.get(receipt.packageDigest), component);
  if (files.length === 0) return undefined;
  if (location.layout === "directory") return treeDigest(files);
  const entry = `${installName(component.name, component.pathOrKey, "file")}.md`;
  return treeDigest([{ ...files[0]!, path: entry }]);
}

/**
 * The transport to this machine itself: inventory and executor in process.
 * The epoch check still runs, so a stale authority on the same machine is
 * refused like any other.
 */
export function localTransport(input: {
  selfId(): Promise<string>;
  observe(): Promise<CapabilityInventory>;
  executor: {
    admitEpoch(controllerId: string, epoch: number): void;
    apply(targets: NodePlanTarget[]): Promise<NodePlanResult[]>;
  };
  artifacts: CapabilityArtifactStore;
}): Pick<CapabilityNodeTransport, "observe" | "stage" | "apply"> {
  return {
    observe: () => input.observe(),
    stage: async (_nodeId, _epoch, digest) => {
      if (!(await input.artifacts.has(digest))) {
        throw new CapabilityError("not-found", "The artifact is not in this machine's cache.");
      }
    },
    apply: async (_nodeId, epoch, _operationId, targets) => {
      input.executor.admitEpoch(await input.selfId(), epoch);
      return input.executor.apply(targets);
    },
  };
}

/** The reasons a machine summary shows for its connection state. */
export function connectionLabel(
  connected: boolean,
  self: boolean,
): "self" | "connected" | "offline" {
  return self ? "self" : connected ? "connected" : "offline";
}
