import { ProviderUnavailableError, type BridgeConnection } from "./agent-provider-contract.js";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";
import { boundedJson, bridgeFetch } from "./http-bridge-transport.js";

/**
 * The failure the ACP bridge's dispatch journal recorded for one finished
 * turn, or null (`NativeAgentRuntimeProvider.turnTerminalError`).
 *
 * A Grok turn the bridge cut short (a held request expired, the agent
 * cancelled on its own, or it stopped early) still leaves the session idle,
 * so without this it would be recorded as completed. A bridge that predates
 * the journal's `turn`, or holds no record for the request, gives no evidence
 * of failure and reads as null, as before; only an unreadable answer throws,
 * so the caller asks again.
 */
export async function readAcpTurnTerminalError(
  connection: BridgeConnection,
  fetchImpl: typeof fetch,
  sessionId: string,
  requestId: string,
): Promise<string | null> {
  const response = await bridgeFetch(
    connection,
    `/session/${encodeURIComponent(sessionId)}/dispatch` +
      `?requestId=${encodeURIComponent(requestId)}`,
    {},
    fetchImpl,
  );
  if (!response.ok) {
    throw new ProviderUnavailableError(`${connection.agent} turn outcome is unavailable`);
  }
  const body = asRecord(await boundedJson(response, `${connection.agent} turn outcome`));
  if (!body) {
    throw new ProviderUnavailableError(`${connection.agent} returned a malformed turn outcome`);
  }
  return nonEmptyString(asRecord(body.turn)?.error)?.slice(0, 500) ?? null;
}
