import {
  isBatchableSessionId,
  parseSessionActivityBatchResponse,
  SESSION_ACTIVITY_BATCH_LIMITS,
  SESSION_ACTIVITY_BATCH_PATH,
  SESSION_ACTIVITY_BATCH_VERSION,
} from "@orkestrator/protocol/session-activity-batch";
import {
  type BridgeConnection,
  type ProviderActivityBatchEntry,
  ProviderUnavailableError,
} from "./agent-provider-contract.js";
import { assertOk, boundedJson, bridgeFetch } from "./http-bridge-transport.js";

/**
 * How long a bridge that answered 404/405 on the batch route is assumed not to
 * have it. The provider instance is already scoped to one bridge connection
 * (a restarted bridge gets a new connection and so a fresh reader); the expiry
 * only covers a bridge upgraded in place behind the same coordinates.
 */
export const ACTIVITY_BATCH_UNSUPPORTED_RECHECK_MS = 5 * 60_000;

/**
 * `POST /sessions/activity` client with per-connection capability detection.
 *
 * Only 404/405 is evidence that the route is absent. A timeout, a 5xx or a
 * malformed answer rejects instead and leaves the capability untouched: the
 * caller reads individually for that sweep and tries the batch again next
 * time, rather than concluding anything about the bridge or its sessions.
 */
export class HttpBridgeActivityBatchReader {
  private unsupportedUntil = 0;

  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async read(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderActivityBatchEntry> | "unsupported"> {
    if (this.now() < this.unsupportedUntil) return "unsupported";
    if (
      sessionIds.length > SESSION_ACTIVITY_BATCH_LIMITS.maxSessions ||
      new Set(sessionIds).size !== sessionIds.length ||
      !sessionIds.every(isBatchableSessionId)
    ) {
      // A caller bug, not a bridge answer: the bridge would refuse it anyway.
      throw new Error("Activity batch request is outside the protocol bounds");
    }
    const response = await bridgeFetch(
      this.connection,
      SESSION_ACTIVITY_BATCH_PATH,
      {
        method: "POST",
        body: JSON.stringify({ version: SESSION_ACTIVITY_BATCH_VERSION, sessionIds }),
      },
      this.fetchImpl,
    );
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel().catch(() => undefined);
      this.unsupportedUntil = this.now() + ACTIVITY_BATCH_UNSUPPORTED_RECHECK_MS;
      return "unsupported";
    }
    const operation = `${this.connection.agent} activity batch read`;
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
    assertOk(response, operation);
    const body = await boundedJson(response, operation, {
      // The bridge bounds its serialized answer; the slack covers encoding
      // differences in whitespace or escaping without admitting a new order
      // of magnitude.
      remaining: SESSION_ACTIVITY_BATCH_LIMITS.maxResponseBytes + 64 * 1024,
    });
    const parsed = parseSessionActivityBatchResponse(body, sessionIds);
    if (!parsed.ok) {
      throw new ProviderUnavailableError(
        `${this.connection.agent} returned a malformed activity batch`,
      );
    }
    const entries = new Map<string, ProviderActivityBatchEntry>();
    for (const [sessionId, entry] of parsed.entries) {
      if (entry.activity === "unavailable" || entry.activity === "deferred") {
        entries.set(sessionId, entry.activity);
        continue;
      }
      // Same shape `readProviderActivityObservation` produces for the single
      // route, so the reconciler cannot tell which path answered.
      const asyncQuestionItemIds = entry.asyncQuestionItemIds
        ? Array.from(new Set(entry.asyncQuestionItemIds))
        : [];
      entries.set(sessionId, {
        state: entry.activity,
        ...(asyncQuestionItemIds.length ? { asyncQuestionItemIds } : {}),
        ...(entry.readyForInput !== undefined ? { readyForInput: entry.readyForInput } : {}),
      });
    }
    return entries;
  }
}
