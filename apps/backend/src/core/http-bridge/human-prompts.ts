import type { BridgeConnection } from "../agent-provider-contract.js";
import { asRecord } from "../agent-provider-runtime.js";
import { assertOk, boundedJson, bridgeFetch } from "./transport.js";

const HUMAN_PROMPTS_MAX_BYTES = 512 * 1024;

/**
 * `GET /session/:id/human-prompts`: the bridge's no-touch, bounded shell
 * output for a session. Every bridge serves it, so any failed status (a 404 or
 * 405 included) is an error like any other.
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
  assertOk(response, "Human prompt observation");
  return asRecord(
    await boundedJson(response, "Human prompt observation", { remaining: HUMAN_PROMPTS_MAX_BYTES }),
  );
}
