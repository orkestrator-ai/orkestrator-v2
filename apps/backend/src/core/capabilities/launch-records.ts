import type { CapabilityTarget } from "@orkestrator/protocol/capability-resources";

import { nativeAgentSessionStorageKey } from "../native-agent/index.js";
import type { CapabilityLaunchRecord, CapabilityState } from "./types.js";

/** A native logical key is unique only within its environment and provider. */
export function capabilityLaunchKey(target: CapabilityTarget, sessionKey: string): string {
  return `${target.nodeId}|${nativeAgentSessionStorageKey(target.environmentId ?? "", target.provider, sessionKey)}`;
}

export function matchingCapabilityLaunch(state: CapabilityState, target: CapabilityTarget) {
  if (!target.sessionId) return undefined;
  const matches = (launch: CapabilityLaunchRecord | undefined): launch is CapabilityLaunchRecord =>
    launch?.sessionKey === target.sessionId &&
    launch?.target.nodeId === target.nodeId &&
    launch.target.provider === target.provider &&
    (target.environmentId === undefined || launch.target.environmentId === target.environmentId);
  if (target.environmentId === undefined) {
    const matchesForProvider = Object.values(state.launches).filter(matches);
    return matchesForProvider.length === 1 ? matchesForProvider[0] : undefined;
  }
  return [
    state.launches[capabilityLaunchKey(target, target.sessionId)],
    state.launches[`${target.nodeId}|${target.sessionId}`],
    state.launches[target.sessionId],
  ].find(matches);
}
