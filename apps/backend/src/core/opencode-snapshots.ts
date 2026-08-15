import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";
import {
  asRecord,
  MAX_TRACKED_INTERACTION_SESSIONS,
  MAX_TRACKED_PROVIDER_INTERACTIONS,
  nonEmptyString,
  serializedByteLength,
} from "./agent-provider-runtime.js";
import { ProviderUnavailableError } from "./agent-provider-contract.js";

// One more than the sessions we can track, so a full tracking set still leaves
// room to observe that the provider returned an extra entry.
export const MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS =
  MAX_TRACKED_INTERACTION_SESSIONS + 1;
export const MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export function boundedOwnedOpenCodeCollection(
  value: unknown,
  ownedSessionIds: ReadonlySet<string>,
  operation: string,
): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProviderUnavailableError(`${operation} is malformed`);
  }
  const owned: unknown[] = [];
  for (const entry of value) {
    const request = asRecord(entry);
    const sessionId = nonEmptyString(request?.sessionID)
      ?? nonEmptyString(request?.sessionId);
    if (!sessionId || !ownedSessionIds.has(sessionId)) continue;
    const id = nonEmptyString(request?.id);
    if (
      !request
      || !id
      || id.length > AGENT_INTERACTION_LIMITS.maxIdLength
      || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
    ) {
      throw new ProviderUnavailableError(`${operation} contains a malformed identity`);
    }
    if (owned.length >= MAX_TRACKED_PROVIDER_INTERACTIONS) {
      throw new ProviderUnavailableError(`${operation} returned too many interactions`);
    }
    owned.push(entry);
  }
  return owned;
}

export type OpenCodeSessionLifecycleState =
  | "running"
  | "idle"
  | "unknown"
  | "missing";

export type OpenCodeExistenceSnapshot = ReturnType<
  typeof boundedOpenCodeExistenceSnapshot
>;

export type OpenCodeExistenceProbe = {
  state: "exists" | "missing" | "unknown";
  error?: unknown;
};

export function boundedOpenCodeStatusSnapshot(
  value: unknown,
  requestedSessionIds: ReadonlySet<string>,
): Record<string, Record<string, unknown>> {
  const snapshot = asRecord(value);
  if (!snapshot) {
    throw new ProviderUnavailableError("OpenCode status read is malformed");
  }
  const entries = Object.entries(snapshot);
  if (
    entries.length > MAX_TRACKED_PROVIDER_INTERACTIONS
    || serializedByteLength(value) > AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
  ) {
    throw new ProviderUnavailableError("OpenCode status read is oversized");
  }
  const validated: Record<string, Record<string, unknown>> = Object.create(null);
  for (const sessionId of requestedSessionIds) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, sessionId)) continue;
    const rawStatus = snapshot[sessionId];
    const status = asRecord(rawStatus);
    if (
      sessionId.length === 0
      || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
      || !status
      || typeof status.type !== "string"
    ) {
      throw new ProviderUnavailableError(
        "OpenCode status read contains a malformed entry",
      );
    }
    validated[sessionId] = status;
  }
  return validated;
}

export function boundedOpenCodeExistenceSnapshot(value: unknown): {
  sessionIds: Set<string>;
} {
  if (!Array.isArray(value)) {
    throw new ProviderUnavailableError("OpenCode session list is malformed");
  }
  if (
    value.length > MAX_OPENCODE_EXISTENCE_SNAPSHOT_SESSIONS
    || serializedByteLength(value) > MAX_OPENCODE_EXISTENCE_SNAPSHOT_BYTES
  ) {
    throw new ProviderUnavailableError("OpenCode session list is oversized");
  }
  const sessionIds = new Set<string>();
  for (const entry of value) {
    const sessionId = nonEmptyString(asRecord(entry)?.id);
    // The list is directory-wide and may contain sessions Orkestrator has
    // never owned. A malformed foreign entry cannot prove that a valid target
    // exists or is absent, so ignore it instead of stalling every tracked
    // session in the environment.
    if (
      !sessionId
      || sessionId.length > AGENT_INTERACTION_LIMITS.maxIdLength
    ) continue;
    sessionIds.add(sessionId);
  }
  return { sessionIds };
}
