/**
 * Reads which saved MCP configuration a bridge session's runtime was built
 * from, for the MCP apply scheduler.
 *
 * Kept out of `http-bridge-provider.ts` (held to its reviewed size limit) and
 * separate from `runtimeHealth()`, whose result feeds renderer projections: the
 * file digests read here are backend-only. The route is the no-touch
 * `/session/:id/runtime-health`; a failed read is "no evidence", and only a
 * 404/405 or a readable body without the report says the bridge is too old
 * to give one.
 */
import type { BridgeConnection, ProviderMcpConfigReport } from "./agent-provider-contract.js";
import { bridgeMcpConfigEvidence, bridgeReportsMcpConfig } from "./http-bridge-runtime-health.js";
import { boundedJson, bridgeFetch } from "./http-bridge-transport.js";

export async function readBridgeMcpConfigEvidence(options: {
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  agent: string;
  sessionId: string;
}): Promise<ProviderMcpConfigReport> {
  const response = await bridgeFetch(
    options.connection,
    `/session/${encodeURIComponent(options.sessionId)}/runtime-health`,
    {},
    options.fetchImpl,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    // 404/405 only ever means the bridge predates the route; any other
    // failure says nothing about its version.
    return response.status === 404 || response.status === 405
      ? { state: "unsupported" }
      : { state: "none" };
  }
  const body = await boundedJson(response, `${options.agent} runtime health read`, {
    remaining: 512 * 1024,
  });
  const evidence = bridgeMcpConfigEvidence(body);
  if (evidence) return { state: "evidence", evidence };
  return bridgeReportsMcpConfig(body) ? { state: "none" } : { state: "unsupported" };
}
