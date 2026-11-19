/**
 * Previewing, applying and cancelling a change for `CapabilityService`
 * (docs/architecture/agent-capabilities-management.md, "Operations and
 * approval"). A preview plans the change against a copy of the state and
 * writes only the operation record; apply needs the exact plan digest the
 * user approved, recomputed against the current state, then commits the
 * change, the approval and the operation together and starts delivery.
 * Change parsing and application are `operations.ts`.
 */
import { isTrustedSource, packageUpdatePolicy } from "./update-checker.js";
import {
  CAPABILITY_LIMITS,
  isTerminalCapabilityOperationState,
  summarizeCapabilityTargets,
  type CapabilityPlannedTarget,
  type CapabilityTarget,
} from "@orkestrator/protocol/capability-resources";
import type { CapabilityChangeResult } from "@orkestrator/protocol/capability-resources-api";
import {
  canonicalCapabilityJson,
  UNRESTRICTED_CAPABILITY_CEILING,
} from "@orkestrator/protocol/capability-resources-resolve";
import { capabilityLocation } from "@orkestrator/protocol/capability-resources-support";

import type { CapabilityImportCommands } from "./import-commands.js";
import {
  applyChangeToState,
  approvalReasonsFor,
  finalizeOperation,
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
import { desiredStateForNode, installationKey, planNode, sha256 } from "./planning.js";
import { defaultGitRunner } from "./project-git.js";
import {
  accountHomeEvidence,
  desiredAccountState,
  desiredProjectState,
  revisionComponent,
  type ScopedInstallation,
} from "./scoped-delivery.js";
import { CapabilityError } from "./security.js";
import { asRecord, asText, requestKeyOf } from "./service-args.js";
import type { CapabilityServiceContext } from "./service-context.js";
import {
  assertDistributableArtifact,
  containsLiteralMcpCredentials,
  scanPackageSecrets,
} from "./source-inspection.js";
import type { CapabilityState } from "./types.js";
import { worktreeCollisions, type WorktreeEntry } from "./worktree-writer.js";

export class CapabilityChangeCommands {
  constructor(
    private readonly ctx: CapabilityServiceContext,
    private readonly imports: CapabilityImportCommands,
  ) {}

  private async scopedTargets(
    draft: CapabilityState,
    machine: Awaited<ReturnType<CapabilityServiceContext["machineFacts"]>>[number],
    desired: ReturnType<typeof desiredStateForNode>,
  ): Promise<CapabilityPlannedTarget[]> {
    const { nodeId, self, connected } = machine;
    const scopes = new Map<
      string,
      {
        target: Omit<CapabilityTarget, "provider">;
        items: ScopedInstallation[];
        worktree?: string;
      }
    >();
    const targets: CapabilityPlannedTarget[] = [];
    const environments = self
      ? await this.ctx.deps.scoped?.environments?.()
      : await this.ctx.deps.remoteEnvironments?.(nodeId);
    for (const environment of environments ?? []) {
      if (environment.environmentType !== "local" || (self && !environment.worktreePath)) continue;
      const { installations, undeliverable } = desiredProjectState(
        draft,
        nodeId,
        environment,
        desired,
        (state, target) =>
          this.ctx.resolveFor(state, { target, ceiling: UNRESTRICTED_CAPABILITY_CEILING }),
      );
      const target = { nodeId, environmentId: environment.id, projectId: environment.projectId };
      scopes.set(`env:${environment.id}`, {
        target,
        items: installations,
        ...(self && environment.worktreePath ? { worktree: environment.worktreePath } : {}),
      });
      for (const entry of undeliverable) {
        targets.push({
          key: `${nodeId}|env:${environment.id}|preview:${entry.provider}|${entry.componentId}`,
          target: { ...target, provider: entry.provider },
          action: "skip",
          status: entry.status,
          reason: entry.reason,
          packageId: entry.packageId,
          componentId: entry.componentId,
          liveSemantics: "new-session-required",
        });
      }
    }
    const accounts = self ? await this.ctx.deps.scoped?.accounts?.() : undefined;
    for (const account of accounts ?? []) {
      const evidence = await accountHomeEvidence(
        account.provider,
        account.home,
        this.ctx.deps.homes(),
      );
      scopes.set(`account:${account.accountId}`, {
        target: { nodeId, accountHomeId: account.accountId },
        items: desiredAccountState(account, desired, evidence),
      });
    }
    const status = self || connected ? "pending" : "offline";
    for (const [scope, { target, items, worktree }] of scopes) {
      const start = targets.length;
      const wanted = new Set(items.map((entry) => entry.key));
      for (const item of items) {
        const receipt = draft.receipts[item.key];
        if (
          receipt?.packageDigest === item.digest &&
          (receipt.status === "ready" || receipt.status === "installed-next-session")
        )
          continue;
        targets.push({
          key: item.key,
          target: { ...target, provider: item.providers[0] ?? "claude" },
          action: receipt ? "update" : "install",
          status,
          packageId: item.packageId,
          componentId: item.componentId,
          locationId: item.locationId,
          ...(receipt ? { fromDigest: receipt.digest } : {}),
          toDigest: item.digest,
          liveSemantics: "new-session-required",
        });
      }
      for (const receipt of Object.values(draft.receipts)) {
        const receiptScope = receipt.environmentId
          ? `env:${receipt.environmentId}`
          : receipt.accountHomeId
            ? `account:${receipt.accountHomeId}`
            : undefined;
        if (receiptScope !== scope || receipt.nodeId !== nodeId || wanted.has(receipt.id)) continue;
        targets.push({
          key: receipt.id,
          target: { ...target, provider: receipt.providers[0] ?? "claude" },
          action: "remove",
          status,
          packageId: receipt.packageId,
          componentId: receipt.componentId,
          locationId: receipt.locationId,
          fromDigest: receipt.digest,
          liveSemantics: "new-session-required",
        });
      }
      if (worktree) {
        const changed = targets.slice(start);
        const entries = changed.flatMap((entry): WorktreeEntry[] => {
          const digest = entry.toDigest ?? draft.receipts[entry.key]?.packageDigest;
          const component =
            digest && revisionComponent(draft, entry.packageId, entry.componentId, digest);
          return component && entry.locationId
            ? [
                {
                  key: entry.key,
                  locationId: entry.locationId,
                  componentName: component.name,
                  pathOrKey: component.pathOrKey,
                },
              ]
            : [];
        });
        if (entries.length > 0) {
          const collisions = await worktreeCollisions(
            this.ctx.deps.scoped?.git ?? defaultGitRunner,
            worktree,
            entries,
          );
          for (const entry of changed) {
            const reason = collisions.get(entry.key);
            if (reason) Object.assign(entry, { action: "skip", status: "failed", reason });
          }
        }
      }
    }
    return targets;
  }

  /** Plans `change` against a copy of the state for every enrolled machine. */
  private async planChange(state: CapabilityState, change: CapabilityChange) {
    const draft = structuredClone(state);
    const applied = applyChangeToState(draft, change);
    const machines = await this.ctx.machineFacts();
    const targets: CapabilityPlannedTarget[] = [];
    for (const machine of machines) {
      if (draft.machines[machine.nodeId]?.enrolled === false) continue;
      if (change.kind === "reconcile" && change.nodeIds && !change.nodeIds.includes(machine.nodeId))
        continue;
      const inventory = draft.machines[machine.nodeId]?.inventory;
      const desired = desiredStateForNode(draft, machine.nodeId, inventory);
      const plan = planNode(draft, desired, { connected: machine.connected || machine.self });
      const scoped = await this.scopedTargets(draft, machine, desired);
      const relevant = [...plan.planned, ...scoped].filter(
        (target) =>
          applied.packageIds.length === 0 || applied.packageIds.includes(target.packageId),
      );
      targets.push(
        ...relevant.filter((target) => target.action !== "keep" || change.kind === "reconcile"),
      );
    }
    targets.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (targets.length > CAPABILITY_LIMITS.maxTargetsPerOperation) {
      throw new CapabilityError(
        "too-large",
        "This change has too many targets for a single approval.",
      );
    }
    return { draft, applied, targets, planDigest: planDigestOf(change, targets) };
  }

  async previewChange(
    args: Record<string, unknown>,
    actor?: string,
  ): Promise<CapabilityChangeResult> {
    this.ctx.assertAuthority();
    const raw = asRecord(args.change, "change");
    const change =
      raw.kind === "adopt-drift"
        ? await this.ctx.drift.prepareAdoption(asText(raw.driftId, "driftId"), raw.mode)
        : parseCapabilityChange(raw);
    return this.previewParsed(change, requestKeyOf(args.requestKey), actor);
  }

  /** Records an operation awaiting approval for an already-parsed change. */
  async previewParsed(
    change: CapabilityChange,
    requestKey: string | undefined,
    actor?: string,
    renewCancelled = false,
  ): Promise<CapabilityChangeResult> {
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
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
        if (operation && (!renewCancelled || operation.state !== "cancelled"))
          return {
            operation: operationSnapshot(operation as CapabilityOperationRecord),
            replayed: true,
          };
      }
    }
    if (change.kind === "add-to-setup" && "packageId" in change) {
      const pkg = state.packages[change.packageId];
      if (!pkg) throw new CapabilityError("not-found", "The package is not in the library.");
      change = { ...change, expectedArtifactDigest: pkg.artifactDigest };
    }
    if ("inspectionId" in change) {
      const inspection = state.inspections[change.inspectionId];
      if (!inspection)
        throw new CapabilityError("conflict", "The inspection expired; inspect the source again.");
    }
    const { applied, targets, planDigest, draft } = await this.planChange(state, change);
    const reasons = approvalReasonsFor(draft, applied.addedComponentIds);
    if (change.kind === "use-toolkit-on-fleet") {
      reasons.push("This toolkit will be used on every enrolled machine.");
    }
    if (change.kind === "add-to-setup" && "inspectionId" in change) {
      const inspection = state.inspections[change.inspectionId];
      if (inspection?.adoption) reasons.push(...this.ctx.drift.adoptionReasons(state, inspection));
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
      change.kind === "use-toolkit-on-fleet" ||
      change.kind === "adopt" ||
      change.kind === "update" ||
      change.kind === "rollback"
    ) {
      await this.assertPackageArtifactsSafe(draft, applied.packageIds);
    }
    const id = newOperationId();
    const now = this.ctx.now();
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
    this.ctx.deps.storage.capabilities.mutateCapabilityState((current) => {
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
    void this.ctx.announce({
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
      const files = await this.ctx.artifacts.get(pkg.artifactDigest);
      const secrets = scanPackageSecrets(files);
      if (containsLiteralMcpCredentials(files)) secrets.push("literal MCP credential");
      if (secrets.length > 0) {
        throw new CapabilityError(
          "secrets-detected",
          `Remove the detected credential (${secrets.join(", ")}) before applying this revision.`,
        );
      }
      assertDistributableArtifact(files);
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
    this.ctx.assertAuthority();
    const operationId = asText(args.operationId, "operationId");
    const approvedDigest = asText(args.approvedDigest, "approvedDigest");
    const requestKey = requestKeyOf(args.requestKey);
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
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
      if (operation.kind === "update") this.cancelOperation({ operationId });
      throw new CapabilityError(
        "approval-required",
        "Something changed since the preview (a package revision, a setup or a machine). Review the new preview.",
      );
    }
    const change = operation.change;
    await this.ctx.drift.assertAdoptionCurrent(state, change);
    if (
      change.kind === "add-to-setup" ||
      change.kind === "use-toolkit-on-fleet" ||
      change.kind === "adopt" ||
      change.kind === "update" ||
      change.kind === "rollback"
    ) {
      await this.assertPackageArtifactsSafe(replanned.draft, replanned.applied.packageIds);
    }
    // Observations can publish while artifacts are checked. Revalidate against
    // that new snapshot before committing, and still require the approved effects.
    const commitBasis = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const finalPlan = await this.planChange(commitBasis, change);
    if (
      finalPlan.planDigest !== approvedDigest ||
      replanned.applied.packageIds.some(
        (id) =>
          replanned.draft.packages[id]?.artifactDigest !==
          finalPlan.draft.packages[id]?.artifactDigest,
      )
    ) {
      if (operation.kind === "update") this.cancelOperation({ operationId });
      throw new CapabilityError(
        "approval-required",
        "The delivery plan changed. Review a fresh preview.",
      );
    }
    const result = this.ctx.deps.storage.capabilities.mutateCapabilityState((current) => {
      this.ctx.assertAuthority();
      if (
        current.handover?.role === "sending" ||
        current.handover?.role === "sent" ||
        current.epoch !== state.epoch ||
        planningIntent(current) !== planningIntent(commitBasis)
      ) {
        throw new CapabilityError(
          "conflict",
          "Capability state changed after approval. Review a new preview.",
        );
      }
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
      if (actor === "trusted-auto-update" && change.kind === "update") {
        const update = current.updates[change.updateId];
        if (
          !update ||
          update.requiresApproval ||
          current.packages[change.packageId]?.diverged ||
          packageUpdatePolicy(current, change.packageId) !== "trusted-auto" ||
          !isTrustedSource(current, change.packageId)
        ) {
          throw new CapabilityError("approval-required", "This update now requires approval.");
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
              detectedAt: this.ctx.now(),
              state: "replaced",
            };
          }
        }
      }
      const now = this.ctx.now();
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
      finalizeOperation(record);
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
    if (change.kind === "import") await this.imports.completeImport(change.importId, actor);
    void this.ctx.announce({
      packageIds: result.applied.packageIds,
      setupIds: result.applied.setupId ? [result.applied.setupId] : [],
      operationIds: [operationId, ...result.superseded],
    });
    const nodes = [...new Set(result.record.targets.map((target) => target.target.nodeId))];
    for (const nodeId of nodes) void this.ctx.reconciler.reconcileNode(nodeId, "apply");
    // Worktrees follow project toolkits on every machine, targeted or not.
    void this.ctx.reconciler.reconcileScoped();
    if (nodes.length === 0) {
      this.ctx.deps.storage.capabilities.mutateCapabilityState((current) => {
        const record = current.operations[operationId];
        if (record && record.state === "applying") record.state = "completed";
        return { result: undefined, changed: true };
      });
    }
    return { operation: operationSnapshot(result.record), replayed: false };
  }

  async cancelOperation(args: Record<string, unknown>) {
    this.ctx.assertAuthority();
    const operationId = asText(args.operationId, "operationId");
    const record = this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
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
      operation.updatedAt = this.ctx.now();
      return { result: structuredClone(operation), changed: true };
    });
    void this.ctx.announce({
      packageIds: record.packageIds,
      setupIds: [],
      operationIds: [operationId],
    });
    return operationSnapshot(record);
  }
}

function planningIntent(state: CapabilityState): string {
  return canonicalCapabilityJson({
    packages: state.packages,
    components: state.components,
    setups: state.setups,
    assignments: state.assignments,
    settings: state.settings,
    machines: Object.values(state.machines)
      .filter(
        ({ enrolled, groups }) =>
          enrolled !== state.settings.enrollNewMachines || groups.length > 0,
      )
      .map(({ nodeId, enrolled, groups }) => ({ nodeId, enrolled, groups }))
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)),
  });
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
    case "use-toolkit-on-fleet":
      return `Enabled ${state.setups[change.setupId]?.name ?? change.setupId} on the fleet.`;
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
