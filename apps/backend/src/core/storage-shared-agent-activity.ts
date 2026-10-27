import { createHash } from "node:crypto";
import {
  aggregateAgentActivityState,
  AGENT_ACTIVITY_SOURCES,
  AGENT_ACTIVITY_STATES,
  isAgentActivityTimestamp,
  parseUsableAgentActivityTime,
} from "@orkestrator/protocol/agent-activity";
import type { AgentActivityState, Environment } from "./models.js";
import { isOneOf, isRecord } from "./storage-shared-core.js";

export const MAX_FRONTEND_AGENT_ACTIVITY_OBSERVERS = 32;

/**
 * Read back the persisted per-source snapshots, discarding any whose state or
 * timestamp no longer parses. A poisoned entry must not be able to pin the
 * aggregate, and dropping it here means every writer sees the same clean view.
 */
export function readAgentActivitySources(
  environment: Environment,
  referenceTime: number,
): NonNullable<Environment["agentActivitySources"]> {
  const sources: NonNullable<Environment["agentActivitySources"]> = {};
  for (const candidateSource of AGENT_ACTIVITY_SOURCES) {
    const snapshot = environment.agentActivitySources?.[candidateSource];
    if (!snapshot || !isOneOf(snapshot.state, AGENT_ACTIVITY_STATES)) continue;
    const snapshotTime = parseUsableAgentActivityTime(snapshot.updatedAt, referenceTime);
    if (!Number.isFinite(snapshotTime)) continue;
    const observedTime =
      snapshot.observedAt === undefined
        ? Number.NaN
        : parseUsableAgentActivityTime(snapshot.observedAt, referenceTime);
    sources[candidateSource] = {
      state: snapshot.state,
      updatedAt: new Date(snapshotTime).toISOString(),
      ...(snapshot.stale === true ? { stale: true } : {}),
      ...(Number.isFinite(observedTime)
        ? { observedAt: new Date(observedTime).toISOString() }
        : {}),
    };
  }
  return sources;
}

export function frontendAgentActivityObserverKey(observerId: string): string {
  return createHash("sha256").update(observerId).digest("hex");
}

/**
 * A stable digest of the parts of an environment's activity snapshot that
 * clients render: the aggregate state plus each source's and observer's state.
 * Timestamps and lease expiries are deliberately excluded — a write that only
 * refreshes them (a lease renewal) changes nothing any client displays, so it
 * does not need to be announced. Keys are sorted so map iteration order cannot
 * fake a difference.
 */
export function agentActivityStructureFingerprint(environment: Environment): string {
  const states = (
    record: Partial<Record<string, { state?: unknown } | undefined>> | undefined,
  ): Array<[string, unknown]> =>
    Object.entries(record ?? {})
      .map(([key, snapshot]): [string, unknown] => [
        key,
        snapshot
          ? [snapshot.state, "stale" in snapshot ? snapshot.stale === true : false]
          : undefined,
      ])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    state: environment.agentActivityState ?? null,
    sources: states(environment.agentActivitySources),
    observers: states(environment.frontendAgentActivityObservers),
  });
}

export function readFrontendAgentActivityObservers(
  environment: Environment,
  referenceTime: number,
): NonNullable<Environment["frontendAgentActivityObservers"]> {
  const observers: NonNullable<Environment["frontendAgentActivityObservers"]> = {};
  const stored = environment.frontendAgentActivityObservers;
  if (!isRecord(stored)) return observers;

  for (const [observerKey, candidate] of Object.entries(stored)) {
    if (!isRecord(candidate)) continue;
    if (!isOneOf(candidate.state, AGENT_ACTIVITY_STATES)) continue;
    const updatedTime = parseUsableAgentActivityTime(candidate.updatedAt, referenceTime);
    const leaseExpiresAt = candidate.leaseExpiresAt;
    if (
      !Number.isFinite(updatedTime) ||
      !isAgentActivityTimestamp(leaseExpiresAt) ||
      Date.parse(leaseExpiresAt) <= referenceTime
    ) {
      continue;
    }
    observers[observerKey] = {
      state: candidate.state,
      updatedAt: new Date(updatedTime).toISOString(),
      leaseExpiresAt: new Date(Date.parse(leaseExpiresAt)).toISOString(),
    };
  }
  return observers;
}

export function aggregateEnvironmentAgentActivity(
  sources: NonNullable<Environment["agentActivitySources"]>,
  observers: NonNullable<Environment["frontendAgentActivityObservers"]>,
): AgentActivityState {
  return aggregateAgentActivityState({ ...sources, ...observers });
}

export function nextAgentActivityTimestamp(
  previousValue: unknown,
  referenceTime = Date.now(),
): string {
  const previousTime = parseUsableAgentActivityTime(previousValue, referenceTime);
  return new Date(
    Math.max(
      referenceTime,
      Number.isFinite(previousTime) ? previousTime + 1 : Number.NEGATIVE_INFINITY,
    ),
  ).toISOString();
}
