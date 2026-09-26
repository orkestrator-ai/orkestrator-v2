import type { HttpBridgeAgent } from "./http-bridge-catalog.js";
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";
import { TAB_TEARDOWN_BRIDGE_UPGRADE_REQUIRED_MARKER } from "@orkestrator/protocol/tab-teardown";

/**
 * Ordinary close of a bridge session: stop owned work, release the bridge's
 * mapping, keep the vendor conversation. Every managed bridge serves it as
 * `POST /session/:id/close`; `DELETE /session/:id` stays the explicit,
 * provider-specific operation and is only ever used here as a *legacy* close,
 * for bridges proven never to delete history through it.
 *
 * Whether a bridge's legacy DELETE has ever deleted vendor history, in any
 * released version. Only `true` may be used as a fallback when a bridge
 * predates the close route (answers 404/405). Evidence, from this repository's
 * history of each bridge's DELETE handler:
 *
 * - codex: the first bridge (d58a1371) aborted the turn and dropped in-memory
 *   state; the SDK-era handler did the same; since the app-server migration
 *   (a43f9e25) it unsubscribes the thread. `thread/delete` has never been sent,
 *   and AGENTS.md forbids it.
 * - pi: `handleDelete` has released the SDK session and kept Pi's JSONL session
 *   file since the bridge was added (04a64ddc). Nothing in the bridge unlinks it.
 * - grok (acp-bridge): since 53d4b3f6 DELETE terminates the CLI child and
 *   rewrites the bridge's own state file. No ACP delete method is sent and
 *   Grok's session store is only read.
 * - cursor: the SDK bridge (671ad10a onwards) releases the SDK agent and keeps
 *   the SDK conversation store; before it, Cursor ran through the ACP bridge
 *   with the Grok DELETE above.
 * - claude: DELETE calls the Claude Agent SDK's `deleteSession`, which removes
 *   the `{sessionId}.jsonl` rollout. It must never be a close fallback.
 */
export const LEGACY_DELETE_RETAINS_HISTORY: Readonly<Record<HttpBridgeAgent, boolean>> = {
  claude: false,
  codex: true,
  cursor: true,
  grok: true,
  pi: true,
};

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
 * The bridge predates `POST /session/:id/close` and its DELETE is destructive,
 * so no safe close exists until the bridge is restarted on a current build.
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
  via: "close" | "legacy-delete";
};

type BridgeCloseRequest = (method: "POST" | "DELETE", path: string) => Promise<Response>;

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
 * `closed: true` (in-band `missing` included) or, for an older bridge proven
 * non-destructive, its legacy DELETE. A 2xx without that affirmation (empty,
 * oversized, malformed, or `closed` anything but `true`) is not a close.
 * A 404/405 from the close route means the bridge predates it — never "already
 * closed" — and for Claude that is an actionable failure rather than a DELETE.
 * Everything else, 503 `pending` included, rejects so the durable intent stays.
 */
export async function closeBridgeSessionRetaining(
  agent: HttpBridgeAgent,
  sessionId: string,
  request: BridgeCloseRequest,
): Promise<BridgeCloseResult> {
  const path = `/session/${encodeURIComponent(sessionId)}`;
  const label = BRIDGE_LABELS[agent];
  const response = await request("POST", `${path}/close`);
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel().catch(() => undefined);
    if (!LEGACY_DELETE_RETAINS_HISTORY[agent]) {
      throw new BridgeCloseUnsupportedError(
        `The ${label} bridge predates non-destructive tab close. Restart the environment so ` +
          "it runs the current bridge; the conversation was not deleted and the close will be retried.",
      );
    }
    const legacy = await request("DELETE", path);
    await legacy.body?.cancel().catch(() => undefined);
    // The legacy route has always answered 404 for an unknown session.
    if (legacy.status === 404) return { outcome: "missing", via: "legacy-delete" };
    if (!legacy.ok) {
      throw new BridgeClosePendingError(`${label} session close failed (HTTP ${legacy.status})`);
    }
    return { outcome: "closed", via: "legacy-delete" };
  }
  const body = await readSmallJson(response);
  if (response.ok && body?.closed === true) {
    return { outcome: body?.missing === true ? "missing" : "closed", via: "close" };
  }
  throw new BridgeClosePendingError(
    `${label} session close is not confirmed (HTTP ${response.status})${boundedDetail(body)}`,
  );
}
