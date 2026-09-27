/**
 * Reads which saved MCP configuration a bridge session's runtime was built
 * from, for the MCP apply scheduler.
 *
 * Kept out of `http-bridge-provider.ts` (held to its reviewed size limit) and
 * separate from `runtimeHealth()`, whose result feeds renderer projections: the
 * file digests read here are backend-only. The route is the no-touch
 * `/session/:id/runtime-health`; any failure reads as "no evidence".
 */
import type { BridgeConnection, ProviderMcpConfigEvidence } from "./agent-provider-contract.js";
import { bridgeMcpConfigEvidence } from "./http-bridge-runtime-health.js";
import { boundedJson, bridgeFetch } from "./http-bridge-transport.js";

export async function readBridgeMcpConfigEvidence(options: {
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  agent: string;
  sessionId: string;
}): Promise<ProviderMcpConfigEvidence | undefined> {
  const response = await bridgeFetch(
    options.connection,
    `/session/${encodeURIComponent(options.sessionId)}/runtime-health`,
    {},
    options.fetchImpl,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  return bridgeMcpConfigEvidence(
    await boundedJson(response, `${options.agent} runtime health read`, {
      remaining: 512 * 1024,
    }),
  );
}
