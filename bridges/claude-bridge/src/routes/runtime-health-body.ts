/**
 * The `/session/:id/runtime-health` body for one session.
 *
 * Pure, so the shape — and in particular that it never resolves or hydrates a
 * session — is testable without mocking the session manager. The route passes
 * whatever `peekSession` found, which may be nothing.
 */
import { emptyRuntimeHealth } from "@orkestrator/protocol/runtime-health";
import type { SessionState } from "../types/index.js";

export function sessionRuntimeHealthBody(
  session: SessionState | undefined,
): Record<string, unknown> {
  // Which saved MCP configuration the last query started with. Content-free
  // digests only, so it is safe beside notices; absent until a query starts,
  // which is how a caller tells "not yet applied" from "applied".
  const mcpConfig = session?.mcpConfigRevision
    ? { mcpConfig: structuredClone(session.mcpConfigRevision) }
    : {};
  if (!session?.health) return { ...emptyRuntimeHealth(), ...mcpConfig };
  const { drift, notices } = session.health.snapshot();
  return { summary: drift ? { drift } : {}, notices, ...mcpConfig };
}
