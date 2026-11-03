/**
 * Narrow-only execution policy changes for a live session (security H4).
 *
 * The bridge token is readable by the agent the bridge runs (same uid), so any
 * route that holds the token is reachable by that agent. A route that let a
 * token holder *widen* a session's policy would let an injected agent turn
 * `approvals: "ask"` into `"auto-approve"` and drop its own sandbox. Changes
 * through the bridge are therefore accepted only when every axis stays the same
 * or gets stricter; widening needs a new bridge process, whose sessions take
 * their policy from the backend again.
 *
 * Each axis is compared on what the bridge actually enforces. Where an axis
 * cannot be shown to be no wider (an unknown shape, a changed policy id), the
 * change counts as widening: refusing a legitimate edge case is recoverable,
 * accepting a widening is not.
 */
import {
  nativeAgentUserMcpGrant,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";

/** The policy axis names a refusal reports. Content-free by construction. */
export type ExecutionPolicyAxis =
  | "id"
  | "approvals"
  | "sandbox"
  | "projectResources"
  | "networkAccess"
  | "containerNetworkAccess"
  | "toolPolicy.allow"
  | "toolPolicy.deny"
  | "capabilityPolicy.deny"
  | "capabilityPolicy.allow"
  | "capabilityPolicy.userMcpServers";

/** Higher is stricter. */
const APPROVALS_STRICTNESS: Record<NativeAgentExecutionPolicy["approvals"], number> = {
  "auto-approve": 0,
  ask: 1,
  deny: 2,
};

/** Higher is stricter: a provider sandbox inside a container is the strictest. */
const SANDBOX_STRICTNESS: Record<NativeAgentExecutionPolicy["sandbox"], number> = {
  none: 0,
  container: 1,
  provider: 2,
};

/** Higher is stricter. An absent outer firewall setting constrains nothing. */
function networkStrictness(value: "restricted" | "full" | undefined): number {
  return value === "restricted" ? 1 : 0;
}

function isSubset(candidate: readonly string[], of: readonly string[]): boolean {
  const allowed = new Set(of);
  return candidate.every((item) => allowed.has(item));
}

/** Every denial the policy carries, recognised by this build or not. */
function rawCapabilityDenials(policy: NativeAgentExecutionPolicy): string[] {
  return [
    ...(policy.capabilityPolicy?.deny ?? []),
    ...(policy.capabilityPolicy?.extendedDeny ?? []),
  ];
}

/**
 * The axes on which `next` grants more than `current`, in a stable order.
 *
 * Empty means `next` is the same as or narrower than `current` on every axis.
 * A session with no policy yet runs under the bridge's host default, which is
 * the widest there is, so any policy narrows it.
 */
export function executionPolicyWidenings(
  current: NativeAgentExecutionPolicy | undefined,
  next: NativeAgentExecutionPolicy,
): ExecutionPolicyAxis[] {
  if (!current) return [];
  const widened: ExecutionPolicyAxis[] = [];

  // The id selects provider behaviour as a whole (a coordinator's fixed
  // boundary, a pipeline's tools), so it is not ordered: any change is refused.
  if (next.id !== current.id) widened.push("id");
  if (APPROVALS_STRICTNESS[next.approvals] < APPROVALS_STRICTNESS[current.approvals]) {
    widened.push("approvals");
  }
  if (SANDBOX_STRICTNESS[next.sandbox] < SANDBOX_STRICTNESS[current.sandbox]) {
    widened.push("sandbox");
  }
  if (next.projectResources && !current.projectResources) widened.push("projectResources");
  if (networkStrictness(next.networkAccess) < networkStrictness(current.networkAccess)) {
    widened.push("networkAccess");
  }
  if (
    networkStrictness(next.containerNetworkAccess) <
    networkStrictness(current.containerNetworkAccess)
  ) {
    widened.push("containerNetworkAccess");
  }

  // `toolPolicy.allow` replaces the default auto-allowed tool list, so it is a
  // grant. An absent list means "the default", which this module cannot prove
  // is a subset of an explicit list, nor the reverse; only an absent list kept
  // absent, an emptied one, or a subset of an explicit one is narrower.
  const currentAllow = current.toolPolicy?.allow;
  const nextAllow = next.toolPolicy?.allow;
  const allowNarrows =
    currentAllow === undefined
      ? nextAllow === undefined || nextAllow.length === 0
      : nextAllow !== undefined && isSubset(nextAllow, currentAllow);
  if (!allowNarrows) widened.push("toolPolicy.allow");
  if (!isSubset(current.toolPolicy?.deny ?? [], next.toolPolicy?.deny ?? [])) {
    widened.push("toolPolicy.deny");
  }

  if (!isSubset(rawCapabilityDenials(current), rawCapabilityDenials(next))) {
    widened.push("capabilityPolicy.deny");
  }
  // `capabilityPolicy.allow` carves exceptions out of a denial: more is wider.
  if (!isSubset(next.capabilityPolicy?.allow ?? [], current.capabilityPolicy?.allow ?? [])) {
    widened.push("capabilityPolicy.allow");
  }
  // An absent selection keeps every configured server; a list keeps only those.
  const currentServers = nativeAgentUserMcpGrant(current);
  const nextServers = nativeAgentUserMcpGrant(next);
  if (
    currentServers !== undefined &&
    (nextServers === undefined || !isSubset(nextServers, currentServers))
  ) {
    widened.push("capabilityPolicy.userMcpServers");
  }
  return widened;
}
