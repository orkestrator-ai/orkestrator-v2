import type { HookCallback, HookJSONOutput, McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQueryControl } from "../types/index.js";
import type { SdkMcpServersConfig } from "./mcp-config.js";
import { claudeMcpToolPrefix } from "./mcp-tool-prefix.js";
import { sessionOperationError } from "./session-manager-core.js";

// Keeping a running CLI's MCP servers in step with the saved configuration.
//
// Pinned against CLI 2.1.309, and proved on the real CLI by
// `session-manager-prompt-mcp-sync.live.test.ts`:
//
// - `setMcpServers` replaces only the servers an earlier `setMcpServers` call
//   gave the CLI. The ones `query({ mcpServers })` passed at launch are not in
//   that set, so a call that leaves one out reports nothing removed and the
//   server keeps running, its tools still offered to the model.
// - Naming a server in a call takes it over, and restating a server's
//   unchanged configuration neither reconnects nor respawns it.
//
// So the first update that drops a launch server first restates the launch
// set unchanged, then sends the new one. A server the CLI still runs after
// that, or one it loaded from a settings file the bridge never passes inline
// (an SSE entry), is not reported as unloaded: its tools are refused by a
// PreToolUse hook until the runtime ends, and the recorded revision names it,
// so the apply view reports a restart rather than `applied`.

/** What a runtime's CLI was given, and still runs, as far as MCP goes. */
export interface ClaudeRuntimeMcp {
  /** The inline servers the CLI was last given. Holds credentials: memory only. */
  servers: SdkMcpServersConfig;
  /** Whether a `setMcpServers` call has taken the launch servers over. */
  claimed: boolean;
  /** Every server name the configuration declared when last applied, inline or not. */
  declared: Set<string>;
  /** Names the configuration no longer declares that the CLI still runs. */
  stale: Set<string>;
}

export function createClaudeRuntimeMcp(
  servers: SdkMcpServersConfig,
  declared: Iterable<string>,
): ClaudeRuntimeMcp {
  return { servers, claimed: false, declared: new Set(declared), stale: new Set() };
}

/** The part of a runtime the sync reads and updates. */
export interface McpSyncRuntime {
  readonly control: ClaudeQueryControl;
  /** Digest of applied inline MCP servers; empty means a failed update must retry. */
  mcpServers: string;
  readonly mcp: ClaudeRuntimeMcp;
}

/** The MCP configuration a turn asks the running CLI for. */
export interface McpSyncTarget {
  servers: SdkMcpServersConfig;
  /** Content-free identity of `servers`. */
  key: string;
  /** Every server name the configuration declares, including ones not passed inline. */
  names: ReadonlySet<string>;
  /** Injected servers that must be connected before the prompt is written. */
  required: readonly string[];
}

/**
 * Sources the user's MCP files never declare. A same-named server from one of
 * these is not the one the configuration dropped.
 */
const FOREIGN_SOURCES = new Set(["plugin", "sdk", "claudeai"]);

/** Bound on the names a revision reports; far beyond any real configuration. */
export const MAX_REPORTED_STALE_SERVERS = 256;

function conflict(message: string) {
  return sessionOperationError("conflict", message);
}

/** The servers a clean update removed, or undefined when it reported errors. */
function cleanUpdate(result: unknown): Set<string> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const { errors, removed } = result as { errors?: unknown; removed?: unknown };
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) return undefined;
  if (Object.keys(errors).length > 0) return undefined;
  return new Set(
    Array.isArray(removed)
      ? removed.filter((name): name is string => typeof name === "string")
      : [],
  );
}

async function setServers(control: ClaudeQueryControl, servers: SdkMcpServersConfig) {
  return control.setMcpServers!(servers).catch(() => {
    throw conflict("Claude MCP configuration could not be applied; retry the prompt");
  });
}

/**
 * Bring the running CLI's MCP servers to `next`.
 *
 * Throws a retryable conflict when the update or a required server fails, and
 * leaves `runtime.mcpServers` empty so the retry restates everything. A server
 * the configuration dropped but the CLI did not unload does not fail the turn:
 * it lands in `runtime.mcp.stale`.
 */
export async function syncClaudeRuntimeMcp(
  runtime: McpSyncRuntime,
  next: McpSyncTarget,
): Promise<void> {
  const { control, mcp } = runtime;
  const undeclared = Array.from(mcp.declared).filter((name) => !next.names.has(name));
  let removed: Set<string> | undefined;
  if (runtime.mcpServers !== next.key) {
    if (!control.setMcpServers) {
      throw conflict("Claude MCP configuration cannot be updated on this runtime");
    }
    // A partial update invalidates the previous identity too. Retrying
    // either configuration must actually restate it on the CLI.
    runtime.mcpServers = "";
    const dropped = Object.keys(mcp.servers).some((name) => !Object.hasOwn(next.servers, name));
    if (dropped && !mcp.claimed) {
      // Unchanged, so nothing reconnects. Its errors are about servers that
      // are either being dropped or restated again just below.
      await setServers(control, mcp.servers);
      mcp.claimed = true;
    }
    removed = cleanUpdate(await setServers(control, next.servers));
    if (!removed) {
      throw conflict("Claude MCP configuration could not be applied; retry the prompt");
    }
    mcp.servers = next.servers;
    mcp.claimed = true;
  }
  const verify = undeclared.length > 0 || mcp.stale.size > 0;
  let statuses: McpServerStatus[] | undefined;
  // Required injected servers can disconnect even without a config change.
  if (next.required.length > 0 || verify) {
    statuses = await control.mcpServerStatus?.().catch(() => {
      if (next.required.length === 0) return undefined;
      runtime.mcpServers = "";
      throw conflict("Claude required MCP server could not be confirmed; retry the prompt");
    });
  }
  if (
    !next.required.every((name) =>
      statuses?.some((server) => server.name === name && server.status === "connected"),
    )
  ) {
    runtime.mcpServers = "";
    throw conflict("Claude required MCP server is not connected; retry the prompt");
  }
  // Without a status to read, only an update that reported a server removed
  // proves it is gone.
  const stillRuns = (name: string) =>
    statuses
      ? statuses.some(
          (server) =>
            server.name === name &&
            server.status !== "disabled" &&
            !FOREIGN_SOURCES.has(server.source ?? ""),
        )
      : !removed?.has(name);
  for (const name of Array.from(mcp.stale)) {
    if (next.names.has(name) || !stillRuns(name)) mcp.stale.delete(name);
  }
  for (const name of undeclared) if (stillRuns(name)) mcp.stale.add(name);
  mcp.declared = new Set(next.names);
  runtime.mcpServers = next.key;
}

/** The names a revision reports, sorted and bounded. */
export function reportedStaleServers(mcp: ClaudeRuntimeMcp): string[] | undefined {
  if (!mcp.stale.size) return undefined;
  return Array.from(mcp.stale).sort().slice(0, MAX_REPORTED_STALE_SERVERS);
}

/**
 * The stale server a tool call reaches, if any.
 *
 * Server and tool names can both contain `__`, so even a longer declared
 * prefix cannot prove ownership. Refuse every matching stale prefix until
 * restart, including ambiguous live tools. MCP resource tools name their
 * server in their input instead.
 */
export function staleMcpServerFor(
  mcp: ClaudeRuntimeMcp,
  toolName: string,
  toolInput: unknown,
): string | undefined {
  if (!mcp.stale.size) return undefined;
  if (toolName.startsWith("mcp__")) {
    let stale: string | undefined;
    let staleLength = 0;
    for (const name of mcp.stale) {
      const prefix = claudeMcpToolPrefix(name);
      if (toolName.startsWith(prefix) && prefix.length > staleLength) {
        stale = name;
        staleLength = prefix.length;
      }
    }
    return stale;
  }
  const server = (toolInput as { server?: unknown } | undefined)?.server;
  return toolName.includes("Mcp") && typeof server === "string" && mcp.stale.has(server)
    ? server
    : undefined;
}

/**
 * Refuse the tools of servers the runtime could not unload.
 *
 * Registered at launch and never from settings, and a hook denial is final
 * whatever the permission mode, so this holds for subagents' calls too. It
 * reads the runtime's MCP state at each call, so a later turn's sync takes
 * effect without a new hook.
 */
export function createStaleMcpServerHook(mcp: ClaudeRuntimeMcp): HookCallback {
  return async (input): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const server = staleMcpServerFor(mcp, input.tool_name, input.tool_input);
    if (!server) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `The MCP server "${server}" was removed from this session's configuration, so ${input.tool_name} is not available. This Claude process loaded it at launch and cannot unload it; it is gone once the process closes after an idle period, or when the session is stopped.`,
      },
    };
  };
}
