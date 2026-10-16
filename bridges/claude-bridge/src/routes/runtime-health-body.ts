/**
 * The `/session/:id/runtime-health` body for one session.
 *
 * Pure, so the shape — and in particular that it never resolves or hydrates a
 * session — is testable without mocking the session manager. The route passes
 * whatever `peekSession` found, which may be nothing.
 */
import { MCP_CONFIG_REPORTING_VERSION } from "@orkestrator/protocol/mcp-management";
import { emptyRuntimeHealth } from "@orkestrator/protocol/runtime-health";
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
  if (!session?.health) return { ...emptyRuntimeHealth(), ...mcpConfig };
  const { drift, notices } = session.health.snapshot();
  return { summary: drift ? { drift } : {}, notices, ...mcpConfig };
}
