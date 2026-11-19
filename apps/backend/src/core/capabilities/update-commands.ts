/**
 * Package updates and rollback for `CapabilityService`
 * (docs/architecture/agent-capabilities-management.md, "Updates and
 * rollback"). A check finds a new revision of each Git or registry package
 * (`update-checker.ts`) and records a proposal; taking it, or rolling back to
 * a kept revision, is a previewed change (`change-commands.ts`). A trusted
 * source whose update adds no risk is previewed and applied as the system.
 */
import {
  CAPABILITY_UPDATE_POLICIES,
  type CapabilitySetup,
  type CapabilityUpdatePolicy,
  type PackageSource,
} from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityChangeResult,
  CapabilityUpdateList,
} from "@orkestrator/protocol/capability-resources-api";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import type { CapabilityChangeCommands } from "./change-commands.js";
import { INSPECTION_TTL_MS } from "./inspection-commands.js";
import type { CapabilityLibraryReads } from "./library-reads.js";
import { newCorrelationId, recordActivity } from "./operations.js";
import { inspectRegistrySource, registryLatestVersion } from "./registry.js";
import { CapabilityError } from "./security.js";
import { asText, optionalNumber, stringList } from "./service-args.js";
import type { CapabilityServiceContext } from "./service-context.js";
import { inspectFiles, inspectGitSource, remoteGitHead } from "./source-inspection.js";
import { checkPackageUpdate } from "./update-checker.js";

const log = createLogger("capabilities");

export class CapabilityUpdateCommands {
  constructor(
    private readonly ctx: CapabilityServiceContext,
    private readonly reads: CapabilityLibraryReads,
    private readonly changes: CapabilityChangeCommands,
  ) {}

  async refreshUpdates(args: Record<string, unknown>): Promise<CapabilityUpdateList> {
    this.ctx.assertAuthority();
    const { deps } = this.ctx;
    const only = typeof args.packageId === "string" ? args.packageId : undefined;
    const state = await deps.storage.capabilities.loadCapabilityState();
    const auto: string[] = [];
    // Each registry's index is fetched once per pass.
    const registries = this.ctx.registries.context(state, new Map());
    for (const pkg of Object.values(state.packages)) {
      if (only && pkg.id !== only) continue;
      if (pkg.source.kind !== "git" && pkg.source.kind !== "registry") continue;
      try {
        const candidate = await checkPackageUpdate(state, pkg, {
          remoteHead: (target) =>
            target.source.kind === "registry"
              ? registryLatestVersion(target, registries)
              : remoteGitHead(
                  target.source as Extract<PackageSource, { kind: "git" }>,
                  deps.gitRun,
                ),
          inspect: (target) =>
            target.source.kind === "registry"
              ? inspectRegistrySource(target.source, registries)
              : inspectGitSource(target.source as Extract<PackageSource, { kind: "git" }>, {
                  workRoot: deps.dataDir,
                  ...(deps.gitRun ? { run: deps.gitRun } : {}),
                }),
          storeArtifact: async (inspected) => {
            await this.ctx.artifacts.put(inspected.files);
            deps.storage.capabilities.mutateCapabilityState((current) => {
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
                createdAt: this.ctx.now(),
              };
              return { result: undefined, changed: true };
            });
          },
          now: () => this.ctx.now(),
        });
        if (!candidate) continue;
        deps.storage.capabilities.mutateCapabilityState((current) => {
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
    deps.storage.capabilities.mutateCapabilityState((current) => {
      current.settings.lastUpdateCheckAt = this.ctx.now();
      return { result: undefined, changed: true };
    });
    for (const updateId of auto) {
      // Trusted and nothing escalates: preview and apply as the system.
      const current = await deps.storage.capabilities.loadCapabilityState();
      const update = current.updates[updateId];
      if (!update) continue;
      const preview = await this.changes.previewParsed(
        { kind: "update", packageId: update.packageId, updateId },
        undefined,
        "trusted-auto-update",
      );
      await this.changes
        .applyChange(
          { operationId: preview.operation.id, approvedDigest: preview.operation.planDigest },
          "trusted-auto-update",
        )
        .catch(() => undefined);
    }
    void this.ctx.announce({ packageIds: [], setupIds: [], operationIds: [] });
    return this.reads.listUpdates();
  }

  async previewUpdate(
    args: Record<string, unknown>,
    actor?: string,
  ): Promise<CapabilityChangeResult> {
    this.ctx.assertAuthority();
    const updateId = asText(args.updateId, "updateId");
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const update = state.updates[updateId];
    if (!update) throw new CapabilityError("not-found", "That update is no longer available.");
    if (state.packages[update.packageId]?.pinned) {
      throw new CapabilityError("conflict", "The package is pinned; unpin it to take updates.");
    }
    return this.changes.previewParsed(
      { kind: "update", packageId: update.packageId, updateId },
      `update:${updateId}`,
      actor,
    );
  }

  async approveUpdate(
    args: Record<string, unknown>,
    actor?: string,
  ): Promise<CapabilityChangeResult> {
    this.ctx.assertAuthority();
    const updateId = asText(args.updateId, "updateId");
    if (args.dismiss === true) {
      const record = this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
        const update = state.updates[updateId];
        if (!update) throw new CapabilityError("not-found", "That update is no longer available.");
        update.state = "dismissed";
        delete state.inspections[`update:${updateId}`];
        return { result: structuredClone(update), changed: true };
      });
      void this.ctx.announce({ packageIds: [record.packageId], setupIds: [], operationIds: [] });
      const now = this.ctx.now();
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
    return this.changes.applyChange({ operationId: preview.operation.id, approvedDigest }, actor);
  }

  async setUpdatePolicy(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetup> {
    this.ctx.assertAuthority();
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
    const setup = this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
      const current = state.setups[setupId];
      if (!current) throw new CapabilityError("not-found", "That setup does not exist.");
      if (expected !== undefined && expected !== current.revision) {
        throw new CapabilityError("conflict", "Someone else changed this setup; reload it.");
      }
      current.updatePolicy = policy as CapabilityUpdatePolicy;
      current.revision += 1;
      current.updatedAt = this.ctx.now();
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
    void this.ctx.announce({ packageIds: [], setupIds: [setupId], operationIds: [] });
    return setup;
  }

  async rollbackPackage(
    args: Record<string, unknown>,
    actor?: string,
  ): Promise<CapabilityChangeResult> {
    this.ctx.assertAuthority();
    const packageId = asText(args.packageId, "packageId");
    const toRevision = asText(args.toRevision, "toRevision");
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const pkg = state.packages[packageId];
    const previous = pkg?.previousRevisions?.find(
      (entry) => entry.revision === toRevision || entry.artifactDigest === toRevision,
    );
    if (!pkg || !previous)
      throw new CapabilityError("not-found", "That revision is not kept for rollback.");
    const files = await this.ctx.artifacts.get(previous.artifactDigest);
    const inspected = inspectFiles(pkg.source, files, { revision: previous.revision });
    const id = `rollback:${packageId}:${previous.artifactDigest}`;
    this.ctx.deps.storage.capabilities.mutateCapabilityState((current) => {
      current.inspections[id] = {
        id,
        source: pkg.source,
        packageId,
        displayName: pkg.displayName,
        revision: previous.revision,
        artifactDigest: previous.artifactDigest,
        components: inspected.components,
        createdAt: this.ctx.now(),
        expiresAt: new Date(Date.parse(this.ctx.now()) + INSPECTION_TTL_MS).toISOString(),
      };
      return { result: undefined, changed: true };
    });
    return this.changes.previewParsed(
      { kind: "rollback", packageId, toRevision },
      typeof args.requestKey === "string" ? args.requestKey : undefined,
      actor,
    );
  }
}
