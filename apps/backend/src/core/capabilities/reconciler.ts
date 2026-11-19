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
  planDigestOf,
  recordActivity,
  updateOperationTargets,
} from "./operations.js";
import { desiredStateForNode, observedInstallations, planNode } from "./planning.js";
import { CapabilityError, treeDigest } from "./security.js";
import { isMachineWideReceipt, type CapabilityState, type InstallationReceipt } from "./types.js";

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
  /** A machine's display name for activity entries; its id when absent. */
  nodeName?(nodeId: string): Promise<string>;
  /**
   * After every pass over this machine (and after `reconcileAll` when this
   * machine is not enrolled): worktree and account-home deliveries
   * (`scoped-delivery.ts`), which follow their own assignments.
   */
  afterSelfPass?(): Promise<void>;
  /**
   * After every pass over another machine: project setups in that machine's
   * worktrees (`scoped-remote.ts`). `recheck` asks for another observation
   * soon, after an unanswered write.
   */
  afterNodePass?(nodeId: string): Promise<{ recheck: boolean }>;
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
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "node-unavailable") return new NodeOfflineError();
  switch (code) {
    case "invalid-request":
    case "not-found":
    case "conflict":
    case "unsafe-content":
    case "too-large":
    case "unsupported":
    case "stale-epoch":
    case "approval-required":
    case "secrets-detected":
    case "source-unavailable":
      return new CapabilityError(code, "The machine refused the capability request.");
  }
  return new OutcomeUnknownError();
}

export class CapabilityReconciler {
  private readonly running = new Map<string, Promise<void>>();
  private readonly scopedRuns = new Set<Promise<void>>();
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
    while (this.running.size > 0 || this.scopedRuns.size > 0)
      await Promise.allSettled([...this.running.values(), ...this.scopedRuns]);
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
    if (state.machines[selfId]?.enrolled === false) await this.runAfterSelfPass();
  }

  private async runAfterSelfPass(): Promise<void> {
    if (this.disposed || !this.deps.afterSelfPass) return;
    try {
      await this.deps.afterSelfPass();
    } catch (error) {
      log.warn("reconcile.scoped-failed", { error: formatLogError(error, { message: false }) });
    }
  }

  private async runAfterNodePass(nodeId: string): Promise<void> {
    if (this.disposed || !this.deps.afterNodePass || !this.deps.isAuthority()) return;
    try {
      const { recheck } = await this.deps.afterNodePass(nodeId);
      if (recheck) this.scheduleRecheck(nodeId);
    } catch (error) {
      log.warn("reconcile.scoped-failed", { error: formatLogError(error, { message: false }) });
    }
  }

  /**
   * Worktree and account copies only, on every machine: after a change whose
   * operation has no machine-wide target (a project toolkit's contents), so
   * project setups follow without a full pass over every machine. A machine
   * whose full pass is running gets its scoped pass at the end of it.
   */
  reconcileScoped(): Promise<void> {
    if (this.disposed || !this.deps.isAuthority()) return Promise.resolve();
    const run = (async () => {
      const selfId = await this.deps.selfId();
      const machines = await this.deps.machines().catch(() => []);
      const connected = machines.filter((machine) => machine.connected);
      await Promise.all(
        [selfId, ...connected.map((machine) => machine.nodeId)].map((nodeId) => {
          // A full pass in flight ends with this machine's scoped pass.
          const running = this.running.get(nodeId);
          if (running) return running;
          return nodeId === selfId ? this.runAfterSelfPass() : this.runAfterNodePass(nodeId);
        }),
      );
    })().finally(() => this.scopedRuns.delete(run));
    this.scopedRuns.add(run);
    return run;
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
        if (!this.again.has(nodeId) || this.disposed) break;
      }
      if (nodeId === (await this.deps.selfId())) await this.runAfterSelfPass();
      else await this.runAfterNodePass(nodeId);
    })().finally(() => {
      this.running.delete(nodeId);
      if (this.again.delete(nodeId)) this.scheduleRecheck(nodeId);
    });
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
      if (receipt.nodeId !== nodeId || !receipt.outcomeUnknown || !isMachineWideReceipt(receipt))
        continue;
      // MCP definitions and Claude plugins are observed by their package digest.
      if (receipt.locationId.startsWith("mcp:") || receipt.locationId.startsWith("plugin:")) {
        if (receipt.pendingWrite?.packageDigest)
          expectedDigests.set(receipt.id, receipt.pendingWrite.packageDigest);
        continue;
      }
      const expected = await expectedInstalledDigest(this.deps.artifacts, state, receipt).catch(
        () => undefined,
      );
      if (expected) expectedDigests.set(receipt.id, expected);
    }

    // Record the observation, settle unknown outcomes and note drift.
    const forceKeys = new Set<string>();
    const driftKeys = new Set<string>();
    const observedRemovals = new Map<string, { status: CapabilityTargetStatus }>();
    const observedOperations = this.deps.storage.capabilities.mutateCapabilityState((current) => {
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
        // Worktree and account copies are observed by their own pass (`scoped-delivery.ts`).
        if (receipt.nodeId !== nodeId || !isMachineWideReceipt(receipt)) continue;
        const fileKind =
          !receipt.locationId.startsWith("mcp:") && !receipt.locationId.startsWith("plugin:");
        const seen = observed.byKey.get(receipt.id);
        if (receipt.outcomeUnknown) {
          const expected = expectedDigests.get(receipt.id) ?? receipt.digest;
          if (
            expected &&
            receipt.pendingWrite?.action !== "remove" &&
            !seen?.drifted &&
            seen?.digest === expected &&
            seen.packageId === receipt.packageId
          ) {
            receipt.outcomeUnknown = false;
            receipt.packageDigest = receipt.pendingWrite?.packageDigest ?? receipt.packageDigest;
            delete receipt.pendingWrite;
            receipt.digest = expected;
            receipt.status = "installed-next-session";
            receipt.verification = fileKind ? "present" : "enabled";
          } else if (receipt.pendingWrite?.action === "remove" && !seen) {
            delete current.receipts[receipt.id];
            observedRemovals.set(receipt.id, { status: "ready" });
          } else if (fileKind && expectedDigests.has(receipt.id) && !seen) {
            // Observed absent or different: the write did not land. Plan it afresh.
            delete current.receipts[receipt.id];
          }
          continue;
        }
        if (
          (!fileKind && !seen?.drifted) ||
          receipt.status === "unsupported" ||
          receipt.status === "failed"
        )
          continue;
        const driftId = `drift:${receipt.id}`;
        const existing = current.drift[driftId];
        if (!seen || seen.drifted || (seen.digest && seen.digest !== receipt.digest)) {
          if (!existing || existing.state !== "open") {
            if (existing?.state === "adopted" && seen?.digest === existing.observedDigest) {
              // The adopted (or merged) revision holds these exact bytes: it may replace them.
              forceKeys.add(receipt.id);
              continue;
            }
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
      const operations = updateOperationTargets(
        current,
        observedRemovals,
        (target) => target.action === "remove",
      );
      return { result: operations, changed: true };
    });

    if (observedOperations.length > 0)
      this.deps.emit({ packageIds: [], setupIds: [], operationIds: observedOperations });
    state = await this.deps.storage.capabilities.loadCapabilityState();
    for (const entry of Object.values(state.drift)) {
      const key = entry.id.startsWith("drift:") ? entry.id.slice("drift:".length) : undefined;
      if (!key || entry.nodeId !== nodeId) continue;
      if (entry.state === "open" || entry.state === "kept-local") driftKeys.add(key);
      if (entry.state === "replaced") forceKeys.add(key);
    }
    if (!(state.machines[nodeId]?.enrolled ?? state.settings.enrollNewMachines)) return;
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
    let journaled = false;
    const priorReceipts = new Map<string, InstallationReceipt | undefined>();
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
        const intent = planDigestOf(undefined, plan.planned);
        if (!this.deps.isAuthority()) return;
        journaled = this.deps.storage.capabilities.mutateCapabilityState((current) => {
          if (
            current.epoch !== epoch ||
            !(current.machines[nodeId]?.enrolled ?? current.settings.enrollNewMachines)
          )
            return { result: false, changed: false };
          const latest = planNode(current, desiredStateForNode(current, nodeId, inventory), {
            connected: true,
            forceKeys,
            driftKeys,
          });
          if (
            planDigestOf(undefined, latest.planned) !== intent ||
            latest.manifestDigest !== plan.manifestDigest
          ) {
            return { result: false, changed: false };
          }
          const installations = new Map(desired.installations.map((entry) => [entry.key, entry]));
          for (const target of plan.targets) {
            const receipt = current.receipts[target.key];
            priorReceipts.set(target.key, receipt ? structuredClone(receipt) : undefined);
            const installation = installations.get(target.key);
            const pending =
              receipt ??
              (installation
                ? {
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
                    status: "outcome-unknown" as const,
                    verification: "requested" as const,
                    operationId,
                    appliedAt: this.now(),
                  }
                : undefined);
            if (!pending) continue;
            pending.outcomeUnknown = true;
            pending.pendingWrite = {
              action: target.action,
              ...(target.artifactDigest ? { packageDigest: target.artifactDigest } : {}),
            };
            current.receipts[target.key] = pending;
          }
          return { result: true, changed: true };
        });
        if (!journaled) {
          if (this.deps.isAuthority()) this.again.add(nodeId);
          return;
        }
        results = await this.deps.transport.apply(nodeId, epoch, operationId, plan.targets);
        const confirmed = new Set(results.map((result) => result.key));
        for (const target of plan.targets) {
          if (confirmed.has(target.key)) continue;
          unknown = true;
          settled.set(target.key, {
            status: "outcome-unknown",
            reason: "Checking what the machine applied.",
          });
        }
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
          unknown = journaled;
          for (const target of plan.targets)
            settled.set(target.key, {
              status: journaled
                ? "outcome-unknown"
                : classified instanceof NodeOfflineError
                  ? "offline"
                  : "failed",
              reason: journaled
                ? "Checking what the machine applied."
                : "The capability files could not be staged.",
            });
        }
      }
    }

    const byKey = new Map(plan.targets.map((target) => [target.key, target]));
    const machineName = (await this.deps.nodeName?.(nodeId).catch(() => nodeId)) ?? nodeId;
    const touched = this.deps.storage.capabilities.mutateCapabilityState((current) => {
      const now = this.now();
      const desiredByKey = new Map(desired.installations.map((entry) => [entry.key, entry]));
      const confirmed = new Set(results.map((result) => result.key));
      for (const [key, prior] of priorReceipts) {
        if (!confirmed.has(key) && unknown) continue;
        if (!confirmed.has(key) && !settled.has(key)) continue;
        if (prior) current.receipts[key] = prior;
        else delete current.receipts[key];
      }
      for (const result of results) {
        const target = byKey.get(result.key);
        if (!target) continue;
        settled.set(result.key, {
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
        });
        if (target.action === "remove") {
          if (result.status === "ready") {
            delete current.receipts[result.key];
            // An adopted deletion or a copy a local variant took over is settled.
            if (current.drift[`drift:${result.key}`]?.state === "adopted")
              delete current.drift[`drift:${result.key}`];
          }
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
        if (
          (forceKeys.has(result.key) ||
            current.drift[`drift:${result.key}`]?.state === "adopted") &&
          result.status !== "failed"
        )
          delete current.drift[`drift:${result.key}`];
      }
      const machine = current.machines[nodeId];
      const allSettled =
        !unknown &&
        plan.targets.every((target) => confirmed.has(target.key)) &&
        results.every(
          (result) => result.status === "ready" || result.status === "installed-next-session",
        );
      if (machine && allSettled) {
        machine.appliedManifestDigest = desired.manifestDigest;
        machine.syncedRevision = current.revision;
      }
      const plannedByKey = new Map(plan.planned.map((target) => [target.key, target]));
      const ids = updateOperationTargets(current, settled, (target) => {
        const planned = plannedByKey.get(target.key);
        return (
          planned?.toDigest === target.toDigest &&
          (target.action === "remove"
            ? planned?.action === "remove" && planned.fromDigest === target.fromDigest
            : planned !== undefined && planned.action !== "remove")
        );
      });
      for (const id of ids) {
        const operation = current.operations[id];
        if (operation) finalizeOperation(operation);
      }
      if (results.length > 0) {
        recordActivity(current, {
          action: "reconcile",
          summary: `Applied ${results.filter((result) => result.status !== "failed").length} of ${results.length} changes on ${machineName}.`,
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
  const location = capabilityLocation(receipt.locationId);
  const digest = receipt.pendingWrite?.packageDigest ?? receipt.packageDigest;
  const pkg = state.packages[receipt.packageId];
  const component =
    pkg?.artifactDigest === digest
      ? state.components[receipt.componentId]
      : pkg?.previousRevisions
          ?.find((entry) => entry.artifactDigest === digest)
          ?.components?.find((entry) => entry.id === receipt.componentId);
  if (!component || !location || !digest || receipt.pendingWrite?.action === "remove")
    return undefined;
  const files = componentFiles(await artifacts.get(digest), component);
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
