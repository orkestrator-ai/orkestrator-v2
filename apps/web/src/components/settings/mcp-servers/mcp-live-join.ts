/**
 * Join one live runtime row (an agent session's MCP inventory) to the saved
 * row it came from.
 *
 * A live row names a server and, for most providers, the layer it was loaded
 * from. Several saved rows can share that name (a project entry shadowing a
 * user entry), and the same name can mean different servers in another
 * target. The join therefore holds only for the exact target the session
 * runs in, and inside it picks the row the provider actually loads:
 * exact native name, then a source whose scope matches the live scope, then
 * the effective row, then precedence.
 */

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  McpConfigSource,
  McpDefinitionSummary,
  McpManagementSnapshot,
  McpOperationSnapshot,
  McpRuntimeApplyEntry,
} from "@orkestrator/protocol/mcp-management";
import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";

/** What a deep link from a live row says about that row. */
export interface McpLiveServerRef {
  provider: AgentPlatform;
  /** `null` for the backend-user target. */
  environmentId: string | null;
  /** Exact name the live session reports. */
  serverName: string;
  /** Layer the live session reports it was loaded from, when it says. */
  scope?: NativeAgentMcpServer["scope"];
  /** Logical session the row belongs to; joins it to apply runtimes. */
  logicalSessionKey?: string;
}

export type McpLiveJoin =
  /** The snapshot is for another target; nothing here describes the row. */
  | { kind: "other-target" }
  /** Orkestrator's own connection, injected at launch and never saved. */
  | { kind: "injected"; entryId?: string }
  /**
   * A plugin server. `entryId` is its read-only plugin row when this target
   * lists the plugin (Claude); absent when no plugin row has the name.
   */
  | {
      kind: "plugin";
      entryId?: string;
      sourceLabel?: string;
      /** Set when the row says the provider does not load the plugin. */
      disabledReason?: string;
    }
  /** No saved row in this target has that name. */
  | { kind: "not-found" }
  | {
      kind: "saved";
      entryId: string;
      sourceLabel: string;
      /** The provider loads the saved name under another spelling (Pi). */
      loadedAs?: string;
      /** Other saved rows with the same name, which the session does not load. */
      alsoNamed: number;
    };

/** Live scopes and the saved source scopes they can come from. */
const LIVE_SCOPE_SOURCES: Record<
  "user" | "project" | "local",
  ReadonlySet<McpConfigSource["scope"]>
> = {
  user: new Set(["backend-user", "environment-private"]),
  local: new Set(["claude-local"]),
  project: new Set(["project"]),
};

const STATUS_RANK: Record<McpDefinitionSummary["status"], number> = {
  effective: 0,
  disabled: 1,
  "policy-excluded": 2,
  shadowed: 3,
  invalid: 4,
  unsupported: 5,
  protected: 6,
};

/** The Pi bridge's own name rule (`sanitizeMcpName` in the Pi bridge). */
function piLoadedName(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function joinLiveMcpServer(
  snapshot: McpManagementSnapshot,
  ref: McpLiveServerRef,
): McpLiveJoin {
  const context = snapshot.target.context;
  if (
    snapshot.target.provider !== ref.provider ||
    (context.environmentId ?? null) !== ref.environmentId
  ) {
    return { kind: "other-target" };
  }
  const sources = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
  if (ref.scope === "plugin") {
    // Plugin rows carry the provider's own namespaced name, so only an exact
    // name in a plugin source is the same server.
    const row = snapshot.definitions
      .filter(
        (definition) =>
          definition.name === ref.serverName &&
          sources.get(definition.sourceId)?.scope === "plugin",
      )
      .sort(
        (left, right) =>
          STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
          (sources.get(right.sourceId)?.precedence ?? 0) -
            (sources.get(left.sourceId)?.precedence ?? 0),
      )[0];
    if (!row) return { kind: "plugin" };
    return {
      kind: "plugin",
      entryId: row.entryId,
      sourceLabel: sources.get(row.sourceId)?.label ?? "a plugin",
      ...(row.status === "disabled" && row.statusReason
        ? { disabledReason: row.statusReason }
        : {}),
    };
  }
  let named = snapshot.definitions.filter((definition) => definition.name === ref.serverName);
  let loadedAs: string | undefined;
  if (!named.length && ref.provider === "pi") {
    named = snapshot.definitions.filter(
      (definition) => piLoadedName(definition.name) === ref.serverName,
    );
    if (named.length) loadedAs = ref.serverName;
  }
  if (ref.scope === "orkestrator") {
    const injected = named.find((definition) => definition.status === "protected");
    return { kind: "injected", ...(injected ? { entryId: injected.entryId } : {}) };
  }
  if (!ref.scope) {
    const injected = named.find((definition) => definition.status === "protected");
    if (injected) return { kind: "injected", entryId: injected.entryId };
  }
  if (!named.length) return { kind: "not-found" };
  const scoped =
    ref.scope && ref.scope in LIVE_SCOPE_SOURCES
      ? named.filter((definition) => {
          const scope = sources.get(definition.sourceId)?.scope;
          return (
            scope !== undefined &&
            LIVE_SCOPE_SOURCES[ref.scope as "user" | "project" | "local"].has(scope)
          );
        })
      : [];
  const candidates = scoped.length ? scoped : named;
  const best = [...candidates].sort(
    (left, right) =>
      STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
      (sources.get(right.sourceId)?.precedence ?? 0) -
        (sources.get(left.sourceId)?.precedence ?? 0),
  )[0]!;
  if (best.status === "protected") return { kind: "injected", entryId: best.entryId };
  return {
    kind: "saved",
    entryId: best.entryId,
    sourceLabel: sources.get(best.sourceId)?.label ?? "this target",
    ...(loadedAs ? { loadedAs } : {}),
    alsoNamed: named.length - 1,
  };
}

/** The apply runtime id the backend uses for a session (`apply.ts`). */
export function mcpApplyRuntimeId(environmentId: string, logicalSessionKey: string): string {
  return `${environmentId}\u0000${logicalSessionKey}`;
}

/**
 * The newest listed apply outcome for one session, across the target's
 * operations. Operations list at most a page of runtimes, so a session that
 * is only counted in `omitted` has no entry here.
 */
export function latestRuntimeApply(
  operations: McpOperationSnapshot[],
  runtimeId: string,
): { operation: McpOperationSnapshot; runtime: McpRuntimeApplyEntry } | null {
  let latest: { operation: McpOperationSnapshot; runtime: McpRuntimeApplyEntry } | null = null;
  for (const operation of operations) {
    const runtime = operation.apply.runtimes.find((candidate) => candidate.runtimeId === runtimeId);
    if (!runtime) continue;
    if (!latest || operation.updatedAt > latest.operation.updatedAt)
      latest = { operation, runtime };
  }
  return latest;
}
