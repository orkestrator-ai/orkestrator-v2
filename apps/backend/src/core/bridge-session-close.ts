import type { HttpBridgeAgent } from "./http-bridge/index.js";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";

/**
 * Ordinary close of a bridge session: stop owned work, release the bridge's
 * mapping, keep the vendor conversation. Every managed bridge serves it as
 * `POST /session/:id/close`; `DELETE /session/:id` stays the explicit,
 * provider-specific operation and is never sent from a close: Claude's calls
 * the SDK's `deleteSession`, which removes the `{sessionId}.jsonl` rollout.
 */
const BRIDGE_LABELS: Readonly<Record<HttpBridgeAgent, string>> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
  antigravity: "Antigravity",
};

/** Close could not be confirmed; the caller must keep its intent and retry. */
export class BridgeClosePendingError extends Error {
  override readonly name = "BridgeClosePendingError";
}

export type BridgeCloseResult = {
  outcome: "closed" | "missing";
};

type BridgeCloseRequest = (method: "POST", path: string) => Promise<Response>;

const MAX_ERROR_DETAIL_CHARS = 160;
const MAX_CLOSE_RESPONSE_BYTES = 4_096;

async function readSmallJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await response.text();
    if (!text || text.length > MAX_CLOSE_RESPONSE_BYTES) return undefined;
    return asRecord(JSON.parse(text)) ?? undefined;
  } catch {
    return undefined;
  }
}

function boundedDetail(body: Record<string, unknown> | undefined): string {
  const detail = nonEmptyString(body?.error);
  if (!detail) return "";
  return `: ${detail.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_ERROR_DETAIL_CHARS)}`;
}

/**
 * Close one bridge session without deleting its conversation.
 *
 * Resolves only on affirmative evidence: a 2xx close answer whose body affirms
 * `closed: true` (in-band `missing` included). A 2xx without that affirmation
 * (empty, oversized, malformed, or `closed` anything but `true`) is not a close.
 * Every other answer, 503 `pending` and a 404/405 included, rejects so the
 * durable intent stays: a 404/405 is never "already closed", and nothing falls
 * back to DELETE.
 */
export async function closeBridgeSessionRetaining(
  agent: HttpBridgeAgent,
  sessionId: string,
  request: BridgeCloseRequest,
): Promise<BridgeCloseResult> {
  const label = BRIDGE_LABELS[agent];
  const response = await request("POST", `/session/${encodeURIComponent(sessionId)}/close`);
  const body = await readSmallJson(response);
  if (response.ok && body?.closed === true) {
    return { outcome: body?.missing === true ? "missing" : "closed" };
  }
  throw new BridgeClosePendingError(
    `${label} session close is not confirmed (HTTP ${response.status})${boundedDetail(body)}`,
  );
}
