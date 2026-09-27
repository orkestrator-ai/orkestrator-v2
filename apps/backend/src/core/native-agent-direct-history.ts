/**
 * Direct history paging: backend cursors that wrap a provider page cursor.
 *
 * The joined sync-v1 paging path (`getMessagePage` v1 cursors) refreshes and
 * fingerprints the whole retained projection before it can serve one page.
 * When a provider serves its own pages (bridge transcript v2), a page request
 * instead validates who the cursor belongs to and asks the provider for
 * exactly that range.
 *
 * The two cursor namespaces never mix: a v1 cursor names a message id inside
 * the backend's own joined history, a v2 cursor carries the provider's opaque
 * position within one provider history epoch. Neither is translated into the
 * other; the provider rejects a stale epoch itself, and this module rejects a
 * cursor presented for a different session or logical tab.
 */
import { createHash } from "node:crypto";

/** The page input's own ceiling; a wrapped provider cursor must fit inside it. */
export const DIRECT_HISTORY_CURSOR_MAX_LENGTH = 1024;

interface DirectHistoryCursorBody {
  v: 2;
  /** Digest of the logical session storage key. */
  key: string;
  /** Digest of the provider session id. */
  session: string;
  /** Provider history epoch the position belongs to; echoed as the page's epoch. */
  epoch: string;
  /** The provider's opaque page cursor. */
  cursor: string;
}

function shortDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function encodeDirectHistoryCursor(input: {
  sessionKey: string;
  providerSessionId: string;
  historyEpoch: string;
  providerCursor: string;
}): string | undefined {
  const body: DirectHistoryCursorBody = {
    v: 2,
    key: shortDigest(input.sessionKey),
    session: shortDigest(input.providerSessionId),
    epoch: input.historyEpoch,
    cursor: input.providerCursor,
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  // Too long to round-trip through the page command: page the old way instead
  // of minting a cursor the request validator would reject.
  return encoded.length <= DIRECT_HISTORY_CURSOR_MAX_LENGTH ? encoded : undefined;
}

export type DecodedHistoryCursor =
  | { version: 1 }
  | { version: 2; epoch: string; providerCursor: string }
  | { version: "invalid" };

/**
 * Classify a page cursor and, for a direct one, check it belongs to this
 * logical session and provider session. A cursor minted for another session
 * is reported `invalid`, never served against the wrong history.
 */
export function decodeHistoryCursor(
  cursor: string,
  owner: { sessionKey: string; providerSessionId: string },
): DecodedHistoryCursor {
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return { version: "invalid" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { version: "invalid" };
  const record = body as Record<string, unknown>;
  if (record.v === 1) return { version: 1 };
  if (
    record.v !== 2 ||
    record.key !== shortDigest(owner.sessionKey) ||
    record.session !== shortDigest(owner.providerSessionId) ||
    typeof record.epoch !== "string" ||
    record.epoch.length === 0 ||
    record.epoch.length > 128 ||
    typeof record.cursor !== "string" ||
    record.cursor.length === 0
  ) {
    return { version: "invalid" };
  }
  return { version: 2, epoch: record.epoch, providerCursor: record.cursor };
}
