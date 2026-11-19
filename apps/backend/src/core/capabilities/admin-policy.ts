/**
 * Administrator (organisation) policy: the forbidden sources and components
 * in the capabilities store's settings
 * (docs/architecture/agent-capabilities-management.md, "Administrator policy").
 *
 * The resolver already enforces both lists over every setup layer
 * (`capabilityPolicyDenial`); this module reads and edits them. An edit
 * replaces each list it names, compared against the policy's own revision
 * (`settings.policyRevision`) so two administrators cannot overwrite each
 * other's change; it is recorded in Activity and every machine is
 * reconciled, so a newly forbidden package is removed where it was
 * installed and shows "Blocked by policy" wherever it is assigned.
 *
 * The state helpers are pure functions over `CapabilityState`; the commands
 * run them inside the store's transaction.
 */
import {
  CAPABILITY_ADMIN_POLICY_LIMITS,
  capabilityPolicyPackageMatch,
  parseForbiddenComponent,
  parseForbiddenSource,
  type CapabilityAdminPolicyView,
  type CapabilityPolicyEntryResult,
} from "@orkestrator/protocol/capability-admin-policy";
import { isCapabilitySourceForbidden } from "@orkestrator/protocol/capability-registry";
import { capabilityRevisionComponents } from "@orkestrator/protocol/capability-resources-resolve";

import type { CapabilitiesStorage } from "../storage-capabilities.js";
import { newCorrelationId, recordActivity } from "./operations.js";
import { CapabilityError } from "./security.js";
import type { CapabilityState } from "./types.js";

export function assertCapabilitySourceAllowed(state: CapabilityState, packageId: string): void {
  if (isCapabilitySourceForbidden(state.settings.forbiddenSources, packageId)) {
    throw new CapabilityError("approval-required", "Administrator policy forbids this source.");
  }
}

/** Packages listed as blocked in the view. */
const MAX_BLOCKED_LISTED = 50;

export function adminPolicyView(state: CapabilityState): CapabilityAdminPolicyView {
  const { settings } = state;
  const components = new Map(Object.entries(state.components));
  const assigned = new Set(
    Object.values(state.setups).flatMap((setup) =>
      setup.packageSelections.map((selection) => selection.packageId),
    ),
  );
  const blocked: CapabilityAdminPolicyView["blocked"] = [];
  for (const pkg of Object.values(state.packages).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  )) {
    const entry = capabilityPolicyPackageMatch(
      settings,
      pkg.id,
      capabilityRevisionComponents(pkg, pkg.artifactDigest, components) ?? [],
    );
    if (entry === undefined) continue;
    blocked.push({
      packageId: pkg.id,
      displayName: pkg.displayName,
      entry,
      assigned: assigned.has(pkg.id),
    });
  }
  return {
    revision: settings.policyRevision ?? 0,
    forbiddenSources: [...settings.forbiddenSources],
    forbiddenComponents: [...settings.forbiddenComponents],
    ...(settings.policyUpdatedAt ? { updatedAt: settings.policyUpdatedAt } : {}),
    blocked: blocked.slice(0, MAX_BLOCKED_LISTED),
    blockedTruncated: Math.max(0, blocked.length - MAX_BLOCKED_LISTED),
  };
}

/** Validates and normalises one list; the first bad entry refuses the whole edit. */
function parseList(
  value: unknown,
  key: string,
  parse: (raw: string) => CapabilityPolicyEntryResult,
): string[] {
  if (!Array.isArray(value)) throw new CapabilityError("invalid-request", `${key} must be a list.`);
  if (value.length > CAPABILITY_ADMIN_POLICY_LIMITS.maxEntries) {
    throw new CapabilityError(
      "too-large",
      `At most ${CAPABILITY_ADMIN_POLICY_LIMITS.maxEntries} entries in ${key}.`,
    );
  }
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new CapabilityError("invalid-request", `${key} holds only text entries.`);
    }
    const parsed = parse(raw);
    if ("error" in parsed) {
      throw new CapabilityError(
        "invalid-request",
        `"${raw.trim().slice(0, 80)}" in ${key}: ${parsed.error}`,
      );
    }
    if (!out.includes(parsed.value)) out.push(parsed.value);
  }
  return out;
}

export interface AdminPolicyChange {
  changed: boolean;
  added: string[];
  removed: string[];
}

/**
 * Replaces the lists `input` names (`forbiddenSources`, `forbiddenComponents`)
 * if `expectedRevision` is the policy's revision. Throws `conflict` otherwise.
 */
export function applyAdminPolicy(
  state: CapabilityState,
  input: Record<string, unknown>,
  now: string,
): AdminPolicyChange {
  const current = state.settings.policyRevision ?? 0;
  if (typeof input.expectedRevision !== "number" || !Number.isInteger(input.expectedRevision)) {
    throw new CapabilityError("invalid-request", "expectedRevision is required.");
  }
  if (input.expectedRevision !== current) {
    throw new CapabilityError(
      "conflict",
      "The policy changed since it was loaded. Review the current policy and try again.",
    );
  }
  if (input.forbiddenSources === undefined && input.forbiddenComponents === undefined) {
    throw new CapabilityError(
      "invalid-request",
      "Name forbiddenSources, forbiddenComponents or both.",
    );
  }
  const sources =
    input.forbiddenSources === undefined
      ? state.settings.forbiddenSources
      : parseList(input.forbiddenSources, "forbiddenSources", parseForbiddenSource);
  const components =
    input.forbiddenComponents === undefined
      ? state.settings.forbiddenComponents
      : parseList(input.forbiddenComponents, "forbiddenComponents", parseForbiddenComponent);
  const before = new Set([
    ...state.settings.forbiddenSources,
    ...state.settings.forbiddenComponents,
  ]);
  const after = new Set([...sources, ...components]);
  const added = [...after].filter((entry) => !before.has(entry));
  const removed = [...before].filter((entry) => !after.has(entry));
  if (added.length === 0 && removed.length === 0) return { changed: false, added, removed };
  state.settings.forbiddenSources = [...sources];
  state.settings.forbiddenComponents = [...components];
  state.settings.policyRevision = current + 1;
  state.settings.policyUpdatedAt = now;
  return { changed: true, added, removed };
}

function changeSummary(change: AdminPolicyChange): string {
  const list = (entries: string[]) =>
    entries.length > 3
      ? `${entries.slice(0, 3).join(", ")} and ${entries.length - 3} more`
      : entries.join(", ");
  const parts = [
    ...(change.added.length ? [`forbade ${list(change.added)}`] : []),
    ...(change.removed.length ? [`allowed ${list(change.removed)} again`] : []),
  ];
  return `Administrator policy: ${parts.join("; ")}.`;
}

export interface AdminPolicyCommandDeps {
  storage: CapabilitiesStorage;
  now(): string;
  assertAuthority(): void;
  announce(packageIds: string[]): void;
  /** Re-plans every machine: a forbidden package is removed, an allowed one delivered. */
  reconcileAll(reason: string): void;
}

/** `get_capability_admin_policy` and `set_capability_admin_policy`. */
export class CapabilityAdminPolicyCommands {
  constructor(private readonly deps: AdminPolicyCommandDeps) {}

  async get(): Promise<CapabilityAdminPolicyView> {
    return adminPolicyView(await this.deps.storage.loadCapabilityState());
  }

  async set(args: Record<string, unknown>, actor?: string): Promise<CapabilityAdminPolicyView> {
    this.deps.assertAuthority();
    const affected = this.deps.storage.mutateCapabilityState((state) => {
      const blockedBefore = new Set(adminPolicyView(state).blocked.map((entry) => entry.packageId));
      const change = applyAdminPolicy(state, args, this.deps.now());
      if (!change.changed) return { result: null, changed: false };
      const blockedAfter = new Set(adminPolicyView(state).blocked.map((entry) => entry.packageId));
      const packageIds = [
        ...[...blockedAfter].filter((id) => !blockedBefore.has(id)),
        ...[...blockedBefore].filter((id) => !blockedAfter.has(id)),
      ].slice(0, 20);
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: "admin-policy",
        summary: changeSummary(change),
        packageIds,
        setupIds: [],
        correlationId: newCorrelationId(),
      });
      return { result: packageIds, changed: true };
    });
    if (affected) {
      this.deps.announce(affected);
      this.deps.reconcileAll("admin-policy");
    }
    return this.get();
  }
}
