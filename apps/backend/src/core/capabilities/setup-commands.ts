/**
 * Setups, assignments, exceptions, machine enrollment and package state for
 * `CapabilityService` (docs/architecture/agent-capabilities-management.md,
 * "Setups and assignments"). Each command checks the expected revision,
 * writes the store in one transaction with an activity entry, then announces
 * the change and asks the reconciler to deliver it.
 */
import { randomBytes } from "node:crypto";

import {
  CAPABILITY_LIMITS,
  CAPABILITY_UPDATE_POLICIES,
  isCapabilitySelector,
  type CapabilitySetup,
  type CapabilityUpdatePolicy,
} from "@orkestrator/protocol/capability-resources";
import type { CapabilitySetupList } from "@orkestrator/protocol/capability-resources-api";

import type { CapabilityLibraryReads } from "./library-reads.js";
import { newCorrelationId, recordActivity } from "./operations.js";
import { CapabilityError } from "./security.js";
import { asRecord, asText, optionalNumber, parseSelections, stringList } from "./service-args.js";
import type { CapabilityServiceContext } from "./service-context.js";

export class CapabilitySetupCommands {
  constructor(
    private readonly ctx: CapabilityServiceContext,
    private readonly reads: CapabilityLibraryReads,
  ) {}

  async setSetup(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetup> {
    this.ctx.assertAuthority();
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
    const setup = this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
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
        updatedAt: this.ctx.now(),
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
    void this.ctx.announce({ packageIds: [], setupIds: [id], operationIds: [] });
    void this.ctx.reconciler.reconcileAll("setup-changed");
    return setup;
  }

  async deleteSetup(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetupList> {
    this.ctx.assertAuthority();
    const setupId = asText(args.setupId, "setupId");
    const expected = optionalNumber(args.expectedRevision);
    this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
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
    void this.ctx.announce({ packageIds: [], setupIds: [setupId], operationIds: [] });
    void this.ctx.reconciler.reconcileAll("setup-deleted");
    return this.reads.listSetups();
  }

  /** One scope's own assignment (what its checkboxes show), not what it inherits. */
  async getAssignment(args: Record<string, unknown>): Promise<{
    scope: string;
    scopeId: string;
    setupIds: string[];
    revision: number;
  }> {
    const scope = asText(args.scope, "scope");
    if (!["project", "environment", "template", "graph-node", "session"].includes(scope)) {
      throw new CapabilityError("invalid-request", "Choose what the setups are for.");
    }
    const scopeId = asText(args.scopeId, "scopeId");
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const assignment = state.assignments[`${scope}:${scopeId}`];
    return {
      scope,
      scopeId,
      setupIds: (assignment?.setupIds ?? []).filter((setupId) => Boolean(state.setups[setupId])),
      revision: assignment?.revision ?? 0,
    };
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
    if (!this.ctx.deps.isAuthority()) this.ctx.assertAuthority();
    const scopeId = asText(args.scopeId, "scopeId");
    const expected = optionalNumber(args.expectedRevision);
    const assignment = this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
      const id = `${scope}:${scopeId}`;
      const existing = state.assignments[id];
      if (expected !== undefined && expected !== (existing?.revision ?? 0)) {
        throw new CapabilityError("conflict", "The selection changed elsewhere; reload it.");
      }
      const setupIds = stringList(args.setupIds, 16, (setupId) => Boolean(state.setups[setupId]));
      if (setupIds.length === 0 && !existing) return { result: null, changed: false };
      const next = {
        id,
        scope,
        scopeId,
        setupIds,
        revision: (existing?.revision ?? 0) + 1,
        updatedAt: this.ctx.now(),
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
    void this.ctx.announce({
      packageIds: [],
      setupIds: assignment?.setupIds ?? [],
      operationIds: [],
    });
    void this.ctx.reconciler.reconcileAll("assignment-changed");
    return assignment ?? { id: `${scope}:${scopeId}`, scope, scopeId, setupIds: [], revision: 0 };
  }

  async manageException(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetup> {
    this.ctx.assertAuthority();
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
    const setup = this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
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
      current.updatedAt = this.ctx.now();
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
    void this.ctx.announce({ packageIds: [], setupIds: [setupId], operationIds: [] });
    void this.ctx.reconciler.reconcileAll("exception-changed");
    return setup;
  }

  async setMachineEnrollment(args: Record<string, unknown>, actor?: string) {
    this.ctx.assertAuthority();
    const nodeId = asText(args.nodeId, "nodeId");
    const enrolled = args.enrolled === undefined ? undefined : args.enrolled === true;
    const groups =
      args.groups === undefined
        ? undefined
        : stringList(args.groups, 16, (group) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(group));
    this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
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
    void this.ctx.announce({ packageIds: [], setupIds: [], operationIds: [] });
    if (enrolled !== false) void this.ctx.reconciler.reconcileNode(nodeId, "enrolled");
    const list = await this.reads.listMachines();
    const summary = list.machines.find((machine) => machine.nodeId === nodeId);
    if (!summary) throw new CapabilityError("not-found", "That machine is not known.");
    return summary;
  }

  async setPackageState(args: Record<string, unknown>, actor?: string) {
    this.ctx.assertAuthority();
    const packageId = asText(args.packageId, "packageId");
    this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
      const pkg = state.packages[packageId];
      if (!pkg) throw new CapabilityError("not-found", "That package is not in the library.");
      if (typeof args.pinned === "boolean") pkg.pinned = args.pinned;
      if (typeof args.paused === "boolean") pkg.paused = args.paused;
      pkg.updatedAt = this.ctx.now();
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
    void this.ctx.announce({ packageIds: [packageId], setupIds: [], operationIds: [] });
    void this.ctx.reconciler.reconcileAll("package-state");
    const library = await this.reads.listPackages({});
    const row = library.packages.find((entry) => entry.id === packageId);
    if (!row) throw new CapabilityError("not-found", "That package is not in the library.");
    return row;
  }
}
