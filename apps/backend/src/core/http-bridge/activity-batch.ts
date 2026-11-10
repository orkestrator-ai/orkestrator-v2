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
} from "../agent-provider-contract.js";
import { assertOk, boundedJson, bridgeFetch } from "./transport.js";

/**
 * `POST /sessions/activity` client.
 *
 * Every bridge from v2.21.0, the support floor, serves the route, so nothing
 * remembers a negative answer. A 404/405 (only an unpublished bridge) answers
 * `unsupported` for this read; a timeout, a 5xx or a malformed answer rejects.
 * Either way the caller reads individually for that sweep and tries the batch
 * again next time, rather than concluding anything about the bridge or its
 * sessions.
 */
export class HttpBridgeActivityBatchReader {
  constructor(
    private readonly connection: BridgeConnection,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async read(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderActivityBatchEntry> | "unsupported"> {
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
        ...(entry.completionPending !== undefined
          ? { completionPending: entry.completionPending }
          : {}),
        ...(entry.contentRevision !== undefined ? { contentRevision: entry.contentRevision } : {}),
        ...(entry.turnFailed ? { turnFailed: entry.turnFailed } : {}),
      });
    }
    return entries;
  }
}
