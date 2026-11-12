import type { BridgeConnection } from "../agent-provider-contract.js";
import { asRecord } from "../agent-provider-runtime.js";
import { compatibilityPathUsage } from "../compatibility-path-usage.js";
import { assertOk, boundedJson, bridgeFetch } from "./transport.js";

const HUMAN_PROMPTS_MAX_BYTES = 512 * 1024;

/**
 * `GET /session/:id/human-prompts`: the bridge's no-touch, bounded shell
 * output for a session. `null` when the bridge predates the route (404/405),
 * the compatibility path counted as `bridge-human-prompts.missing-route`
 * (to-do 7570).
 */
export async function readBridgeHumanPrompts(
  connection: BridgeConnection,
  fetchImpl: typeof fetch,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const response = await bridgeFetch(
    connection,
    `/session/${encodeURIComponent(sessionId)}/human-prompts`,
    {},
    fetchImpl,
  );
  if (response.status === 404 || response.status === 405) {
    compatibilityPathUsage.record("bridge-human-prompts.missing-route");
    return null;
  }
  assertOk(response, "Human prompt observation");
  return asRecord(
    await boundedJson(response, "Human prompt observation", { remaining: HUMAN_PROMPTS_MAX_BYTES }),
  );
}
