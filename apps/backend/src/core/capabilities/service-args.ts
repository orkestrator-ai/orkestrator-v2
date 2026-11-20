/**
 * Argument parsing for `CapabilityService` commands
 * (docs/architecture/agent-capabilities-management.md). Arguments arrive as
 * opaque records from the command registry; these checks bound every string
 * and list before a collaborator reads it.
 */
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  CAPABILITY_LIMITS,
  type CapabilityPackageSelection,
  type CapabilityTarget,
} from "@orkestrator/protocol/capability-resources";
import {
  canonicalCapabilityJson,
  type CapabilityPermissionCeiling,
} from "@orkestrator/protocol/capability-resources-resolve";

import { sha256 } from "./planning.js";
import { CapabilityError } from "./security.js";

export function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityError("invalid-request", `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function asText(
  value: unknown,
  name: string,
  max: number = CAPABILITY_LIMITS.maxIdChars,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new CapabilityError("invalid-request", `${name} is required.`);
  }
  return value;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseTarget(value: unknown, fallbackNode: string): CapabilityTarget {
  const record = asRecord(value, "target");
  if (!isAgentPlatform(record.provider))
    throw new CapabilityError("invalid-request", "target.provider is required.");
  const optional = (key: string) =>
    typeof record[key] === "string" &&
    (record[key] as string).length <= CAPABILITY_LIMITS.maxIdChars
      ? { [key]: record[key] as string }
      : {};
  return {
    nodeId: typeof record.nodeId === "string" && record.nodeId ? record.nodeId : fallbackNode,
    provider: record.provider,
    ...optional("accountHomeId"),
    ...optional("projectId"),
    ...optional("environmentId"),
    ...optional("environmentIncarnation"),
    ...optional("sessionId"),
  };
}

export function parseCeiling(value: unknown): CapabilityPermissionCeiling {
  if (value === undefined) return { denied: [], userMcpServers: null, digest: "unrestricted" };
  const record = asRecord(value, "ceiling");
  const denied = Array.isArray(record.denied)
    ? record.denied
        .filter((entry): entry is string => typeof entry === "string" && entry.length <= 128)
        .slice(0, 64)
    : [];
  const userMcpServers = Array.isArray(record.userMcpServers)
    ? record.userMcpServers
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 32)
    : null;
  return {
    denied,
    userMcpServers,
    digest: sha256(canonicalCapabilityJson({ denied: [...denied].sort(), userMcpServers })),
  };
}

export function parseSelections(value: unknown): CapabilityPackageSelection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new CapabilityError("invalid-request", "selections must be a list.");
  return value.slice(0, CAPABILITY_LIMITS.maxSelectionsPerSetup).map((entry: unknown) => {
    const record = asRecord(entry, "selection");
    return {
      packageId: asText(record.packageId, "packageId"),
      version: typeof record.version === "string" ? record.version : "latest",
      ...(Array.isArray(record.components)
        ? { components: record.components.filter((id): id is string => typeof id === "string") }
        : {}),
      ...(record.required === true ? { required: true } : {}),
    };
  });
}

export function stringList(
  value: unknown,
  max: number,
  check: (entry: string) => boolean = () => true,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CapabilityError("invalid-request", "Expected a list.");
  return value
    .filter((entry): entry is string => typeof entry === "string" && check(entry))
    .slice(0, max);
}

/** A request key, bounded; absent when the caller sent none. */
export function requestKeyOf(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 200) : undefined;
}
