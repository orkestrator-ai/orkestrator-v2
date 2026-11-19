/**
 * The read side of `CapabilityService`
 * (docs/architecture/agent-capabilities-management.md, "The Capabilities
 * page"): the library, a package's files, setups, inventories, provider
 * support, effective resources, the session chip, machines, local changes,
 * activity, operations and updates. Nothing here writes the store.
 */
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  CAPABILITY_LIMITS,
  MY_SETUP_ID,
  isTerminalCapabilityOperationState,
  type ComponentKind,
  type EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityActivityList,
  CapabilityDriftList,
  CapabilityInventory,
  CapabilityLibrary,
  CapabilityMachineList,
  CapabilityOperationList,
  CapabilitySessionView,
  CapabilitySetupList,
  CapabilityTargetSupportResult,
  CapabilityUpdateList,
} from "@orkestrator/protocol/capability-resources-api";
import {
  canonicalCapabilityJson,
  capabilityRevisionComponents,
} from "@orkestrator/protocol/capability-resources-resolve";
import { capabilityLiveSemantics } from "@orkestrator/protocol/capability-resources-support";

import { operationSnapshot, type CapabilityOperationRecord } from "./operations.js";
import { supportFor } from "./planning.js";
import { assignmentSetups } from "./resolution.js";
import { effectiveReceiptStatus } from "./runtime-evidence.js";
import { CapabilityError } from "./security.js";
import {
  asText,
  optionalNumber,
  parseCeiling,
  parseSelections,
  parseTarget,
  stringList,
} from "./service-args.js";
import type { CapabilityServiceContext } from "./service-context.js";
import { containsLiteralMcpCredentials, scanPackageSecrets } from "./source-inspection.js";
import {
  availabilityCells,
  desiredByNode,
  machineSummaries,
  packageDetail,
  packageSummary,
} from "./views.js";

export class CapabilityLibraryReads {
  constructor(private readonly ctx: CapabilityServiceContext) {}

  private loadState() {
    return this.ctx.deps.storage.capabilities.loadCapabilityState();
  }

  async listPackages(args: Record<string, unknown>): Promise<CapabilityLibrary> {
    const state = await this.loadState();
    const machines = await this.ctx.machineFacts();
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
    const state = await this.loadState();
    const machines = await this.ctx.machineFacts();
    const detail = packageDetail(
      state,
      packageId,
      machines,
      desiredByNode(state, machines),
      this.ctx.scoped.scopeNames(),
    );
    if (!detail) throw new CapabilityError("not-found", "That package is not in the library.");
    return detail;
  }

  async readFile(
    args: Record<string, unknown>,
  ): Promise<{ path: string; content: string; truncated: boolean }> {
    const packageId = asText(args.packageId, "packageId");
    const filePath = asText(args.path, "path", CAPABILITY_LIMITS.maxPathChars);
    const state = await this.loadState();
    const pkg = state.packages[packageId];
    const digest = pkg?.artifactDigest ?? state.inspections[packageId]?.artifactDigest;
    if (!digest) throw new CapabilityError("not-found", "That package is not in the library.");
    const files = await this.ctx.artifacts.get(digest);
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
    const state = await this.loadState();
    const setups = Object.values(state.setups).sort((a, b) =>
      a.id === MY_SETUP_ID ? -1 : b.id === MY_SETUP_ID ? 1 : a.name.localeCompare(b.name),
    );
    return { revision: state.revision, setups };
  }

  async getInventory(args: Record<string, unknown>): Promise<CapabilityInventory> {
    const selfId = await this.ctx.deps.selfId();
    const nodeId = typeof args.nodeId === "string" && args.nodeId ? args.nodeId : selfId;
    if (nodeId === selfId) return this.ctx.observeSelf();
    if (args.refresh === true) return this.ctx.observeNode(nodeId);
    const state = await this.loadState();
    const inventory = state.machines[nodeId]?.inventory;
    if (!inventory)
      throw new CapabilityError("not-found", "That machine has not reported its inventory yet.");
    return inventory;
  }

  async getTargetSupport(args: Record<string, unknown>): Promise<CapabilityTargetSupportResult> {
    const selfId = await this.ctx.deps.selfId();
    const nodeId = typeof args.nodeId === "string" && args.nodeId ? args.nodeId : selfId;
    const state = await this.loadState();
    const inventory =
      nodeId === selfId
        ? await this.ctx.observeSelf().catch(() => undefined)
        : state.machines[nodeId]?.inventory;
    return { nodeId, matrices: AGENT_PLATFORMS.map((provider) => supportFor(inventory, provider)) };
  }

  async getEffectiveResources(args: Record<string, unknown>): Promise<EffectiveAgentResources> {
    const state = await this.loadState();
    const target = parseTarget(args.target, await this.ctx.deps.selfId());
    return this.ctx.resolveFor(state, {
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
    const target = parseTarget(args.target, await this.ctx.deps.selfId());
    const sessionRunning = args.sessionRunning === true;
    const state = await this.loadState();
    const assigned = assignmentSetups(state, "session", sessionKey);
    // The session's own policy, as its projection reports it: it can only narrow.
    const effective = this.ctx.resolveFor(state, {
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
    const state = await this.loadState();
    const machines = await this.ctx.machineFacts();
    const summaries = machineSummaries(state, machines, desiredByNode(state, machines));
    const groups = [
      ...new Set(Object.values(state.machines).flatMap((machine) => machine.groups)),
    ].sort();
    return { machines: summaries, groups };
  }

  async listDrift(args: Record<string, unknown>): Promise<CapabilityDriftList> {
    const state = await this.loadState();
    const nodeId = typeof args.nodeId === "string" ? args.nodeId : undefined;
    return {
      drift: Object.values(state.drift)
        .filter((entry) => !nodeId || entry.nodeId === nodeId)
        .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt)),
    };
  }

  async listActivity(args: Record<string, unknown>): Promise<CapabilityActivityList> {
    const state = await this.loadState();
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
    const state = await this.loadState();
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
    const state = await this.loadState();
    const operation = state.operations[operationId] as CapabilityOperationRecord | undefined;
    if (!operation) throw new CapabilityError("not-found", "That operation does not exist.");
    return operationSnapshot(operation);
  }

  async listUpdates(): Promise<CapabilityUpdateList> {
    const state = await this.loadState();
    return {
      updates: Object.values(state.updates).sort((a, b) =>
        b.detectedAt.localeCompare(a.detectedAt),
      ),
      ...(state.settings.lastUpdateCheckAt
        ? { lastCheckedAt: state.settings.lastUpdateCheckAt }
        : {}),
    };
  }
}
