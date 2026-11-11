/**
 * The `/session/:id/runtime-health` body for one session.
 *
 * Pure, so the shape — and in particular that it never resolves or hydrates a
 * session — is testable without mocking the session manager. The route passes
 * whatever `peekSession` found, which may be nothing.
 */
import { MCP_CONFIG_REPORTING_VERSION } from "@orkestrator/protocol/mcp-management";
import { emptyRuntimeHealth } from "@orkestrator/protocol/runtime-health";
import { openClaudeRuntime } from "../services/session-manager-runtime.js";
import type { SessionState } from "../types/index.js";

export function sessionRuntimeHealthBody(
  session: SessionState | undefined,
): Record<string, unknown> {
  // Which saved MCP configuration the last query started with. Content-free
  // digests, plus the names of servers the runtime could not unload, so it is
  // safe beside notices; absent until a query starts, which is how a caller
  // tells "not yet applied" from "applied". `mcpConfigReporting` is on every
  // body, even an unknown session's: without it the backend reads this bridge
  // as one too old to report at all.
  const mcpConfig = {
    mcpConfigReporting: MCP_CONFIG_REPORTING_VERSION,
    ...(session?.mcpConfigRevision
      ? { mcpConfig: structuredClone(session.mcpConfigRevision) }
      : {}),
  };
  if (!session) return { ...emptyRuntimeHealth(), ...mcpConfig };
  // Whether the session's Claude CLI is open, in the same vocabulary as the
  // Cursor and Pi bridges: `detached` once the idle window has released it.
  // Read from memory only, so observing it never re-attaches the session.
  const state = openClaudeRuntime(session) ? "attached" : "detached";
  // Which CLI that is (0005 task 8): unchanged across follow-ups, setting
  // changes and approvals written into one warm process, and advanced by every
  // launch. With `detached` it names the CLI the idle window released, so a
  // reader can tell "released" from "never launched". A bare counter: no PID,
  // nothing about the host.
  const generation = session.claudeRuntimeGeneration;
  const base = { state, ...(generation ? { runtimeGeneration: generation } : {}) };
  if (!session.health) return { ...emptyRuntimeHealth(), summary: base, ...mcpConfig };
  const { drift, notices } = session.health.snapshot();
  return { summary: { ...base, ...(drift ? { drift } : {}) }, notices, ...mcpConfig };
}
