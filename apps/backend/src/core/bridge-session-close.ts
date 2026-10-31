import type { HttpBridgeAgent } from "./http-bridge-catalog.js";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";
import { TAB_TEARDOWN_BRIDGE_UPGRADE_REQUIRED_MARKER } from "@orkestrator/protocol/tab-teardown";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";

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
};

/** Close could not be confirmed; the caller must keep its intent and retry. */
export class BridgeClosePendingError extends Error {
  override readonly name = "BridgeClosePendingError";
}

/**
 * The bridge predates `POST /session/:id/close`, so no close exists until it is
 * restarted on a current build. Every published release has the route; only an
 * unpublished source build can get here.
 * The message carries {@link TAB_TEARDOWN_BRIDGE_UPGRADE_REQUIRED_MARKER} so
 * the renderer can show the restart notice.
 */
export class BridgeCloseUnsupportedError extends Error {
  override readonly name = "BridgeCloseUnsupportedError";

  constructor(message: string) {
    super(`${TAB_TEARDOWN_BRIDGE_UPGRADE_REQUIRED_MARKER} ${message}`);
  }
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
 * A 404/405 from the close route means the bridge predates it — never "already
 * closed" — and that is an actionable failure rather than a DELETE. Everything
 * else, 503 `pending` included, rejects so the durable intent stays.
 */
export async function closeBridgeSessionRetaining(
  agent: HttpBridgeAgent,
  sessionId: string,
  request: BridgeCloseRequest,
): Promise<BridgeCloseResult> {
  const label = BRIDGE_LABELS[agent];
  const response = await request("POST", `/session/${encodeURIComponent(sessionId)}/close`);
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel().catch(() => undefined);
    compatibilityPathUsage.record("bridge-close.upgrade-required");
    throw new BridgeCloseUnsupportedError(
      `The ${label} bridge predates non-destructive tab close. Restart the environment so ` +
        "it runs the current bridge; the conversation was not deleted and the close will be retried.",
    );
  }
  const body = await readSmallJson(response);
  if (response.ok && body?.closed === true) {
    return { outcome: body?.missing === true ? "missing" : "closed" };
  }
  throw new BridgeClosePendingError(
    `${label} session close is not confirmed (HTTP ${response.status})${boundedDetail(body)}`,
  );
}
