import type { BridgeConnection, ProviderRuntimeHealth } from "../agent-provider-contract.js";
import type { HttpBridgeAgent } from "./catalog.js";
import { bridgeRuntimeSummary } from "./runtime-health.js";
import { boundedJson, bridgeFetch } from "./transport.js";

/**
 * Bounded inventory, drift and provider diagnostics for one session
 * (`GET /session/:id/runtime-health`, no-touch).
 *
 * Answers in band for a bridge that predates the route and for a session it
 * does not have. A failure here must never fail the environment: this hop
 * cannot tell "older bridge" from "gone session", and health is optional
 * metadata either way — the authoritative liveness answer is `/activity`.
 * Kept out of `provider.ts`, which is at its module size limit.
 */
export async function readBridgeRuntimeHealth(
  connection: BridgeConnection,
  fetchImpl: typeof fetch,
  agent: HttpBridgeAgent,
  sessionId: string,
): Promise<ProviderRuntimeHealth> {
  try {
    const response = await bridgeFetch(
      connection,
      `/session/${encodeURIComponent(sessionId)}/runtime-health`,
      {},
      fetchImpl,
    );
    if (!response.ok) return { summary: {}, notices: [], authoritative: false };
    const summary = bridgeRuntimeSummary(
      await boundedJson(response, `${agent} runtime health read`, {
        remaining: 512 * 1024,
      }),
    );
    if (!summary) return { summary: {}, notices: [], authoritative: false };
    return { summary, notices: summary.notices ?? [], authoritative: true };
  } catch {
    return { summary: {}, notices: [], authoritative: false };
  }
}
