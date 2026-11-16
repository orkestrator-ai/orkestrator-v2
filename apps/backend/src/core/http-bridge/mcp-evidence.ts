/**
 * Reads which saved MCP configuration a bridge session's runtime was built
 * from, for the MCP apply scheduler.
 *
 * Kept out of `http-bridge/provider.ts` (held to its reviewed size limit) and
 * separate from `runtimeHealth()`, whose result feeds renderer projections: the
 * file digests read here are backend-only. The route is the no-touch
 * `/session/:id/runtime-health`; a failed read, whatever its status, is "no
 * evidence".
 */
import type { BridgeConnection, ProviderMcpConfigReport } from "../agent-provider-contract.js";
import { bridgeMcpConfigEvidence } from "./runtime-health.js";
import { boundedJson, bridgeFetch } from "./transport.js";

export async function readBridgeMcpConfigEvidence(options: {
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  agent: string;
  sessionId: string;
  /** Aborts the read; it then rejects, which the scheduler counts as no evidence. */
  signal?: AbortSignal | undefined;
}): Promise<ProviderMcpConfigReport> {
  const response = await bridgeFetch(
    options.connection,
    `/session/${encodeURIComponent(options.sessionId)}/runtime-health`,
    options.signal ? { signal: options.signal } : {},
    options.fetchImpl,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { state: "none" };
  }
  const body = await boundedJson(response, `${options.agent} runtime health read`, {
    remaining: 512 * 1024,
  });
  const evidence = bridgeMcpConfigEvidence(body);
  return evidence ? { state: "evidence", evidence } : { state: "none" };
}
