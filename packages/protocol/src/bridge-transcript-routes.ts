/**
 * Route bodies for a bridge's three transcript reads, from one read source.
 *
 * `GET /session/:id/transcript`, `/transcript/detail` and `/transcript/page`
 * must agree about what they read: the same message array, generation,
 * content epoch and completeness. A detail locator or history cursor minted by
 * one is otherwise resolved against a different history by another. Each
 * bridge therefore builds one {@link BridgeTranscriptSource} per request and
 * passes it to these helpers, which own the query parsing and the contract's
 * in-band answers so the five bridges cannot drift apart.
 *
 * An unknown session answers `detail` and `page` in band (`missing` and
 * `expired`), never 404: the backend reads 404/405 from these routes as "this
 * bridge predates the route" and would otherwise stop asking a current bridge.
 */

import {
  bridgeTranscriptPage,
  bridgeTranscriptSummaryUpdate,
  readBridgeTranscriptDetail,
  type BridgeTranscriptDetailResponse,
  type BridgeTranscriptPageResponse,
  type BridgeTranscriptSummaryUpdate,
} from "./bridge-transcript-summary.js";
import { bridgeTranscriptUpdate } from "./progressive-transcript.js";

/** Everything a transcript route reads, computed once per request. */
export interface BridgeTranscriptSource<T extends { content: string; parts: unknown[] }> {
  messages: readonly T[];
  sessionIdentity: string;
  generation: string | number;
  contentEpoch: string | number;
  revision?: number;
  complete: boolean;
  freshness?: "cached" | "current";
  title?: string;
}

/** A query-string reader: `URLSearchParams#get` and Hono's `c.req.query` both fit. */
export type BridgeTranscriptQuery = (name: string) => string | null | undefined;

/**
 * `GET /session/:id/transcript`: the v2 summary envelope for `version=2`,
 * otherwise the unchanged v1 envelope. Both read the same source, so a v2
 * reader and an older v1 reader of one session see the same history.
 */
export function bridgeTranscriptRouteBody<T extends { content: string; parts: unknown[] }>(
  source: BridgeTranscriptSource<T>,
  query: BridgeTranscriptQuery,
): ReturnType<typeof bridgeTranscriptUpdate<T>> | BridgeTranscriptSummaryUpdate {
  const options = {
    sessionIdentity: source.sessionIdentity,
    generation: source.generation,
    contentEpoch: source.contentEpoch,
    revision: source.revision,
    limit: Number(query("limit")),
    targetBytes: Number(query("targetBytes")),
    knownToken: query("knownToken") ?? undefined,
    complete: source.complete,
    freshness: source.freshness,
    title: source.title,
  };
  return query("version") === "2"
    ? bridgeTranscriptSummaryUpdate(source.messages, { ...options, pages: true })
    : bridgeTranscriptUpdate(source.messages, options);
}

/** `GET /session/:id/transcript/detail?locator=`. */
export function bridgeTranscriptDetailRouteBody<T extends { content: string; parts: unknown[] }>(
  source: BridgeTranscriptSource<T> | undefined,
  query: BridgeTranscriptQuery,
): BridgeTranscriptDetailResponse {
  if (!source) return { version: 1, status: "missing" };
  const locator = query("locator");
  if (!locator) return { version: 1, status: "invalid" };
  return readBridgeTranscriptDetail(source.messages, locator);
}

/** The transcript sub-routes: `/transcript/detail` and `/transcript/page`. */
export type BridgeTranscriptSubRead = "detail" | "page";

/** Whether a path segment after `/transcript` names one of the sub-routes. */
export function isBridgeTranscriptSubRead(segment: unknown): segment is BridgeTranscriptSubRead {
  return segment === "detail" || segment === "page";
}

/** Dispatch for bridges whose router hands over the sub-route as a path segment. */
export function bridgeTranscriptSubReadBody<T extends { content: string; parts: unknown[] }>(
  source: BridgeTranscriptSource<T> | undefined,
  subRead: BridgeTranscriptSubRead,
  query: BridgeTranscriptQuery,
): BridgeTranscriptDetailResponse | BridgeTranscriptPageResponse {
  return subRead === "detail"
    ? bridgeTranscriptDetailRouteBody(source, query)
    : bridgeTranscriptPageRouteBody(source, query);
}

/** `GET /session/:id/transcript/page?cursor=&limit=&targetBytes=`. */
export function bridgeTranscriptPageRouteBody<T extends { content: string; parts: unknown[] }>(
  source: BridgeTranscriptSource<T> | undefined,
  query: BridgeTranscriptQuery,
): BridgeTranscriptPageResponse {
  // No session means no epoch the cursor could still name.
  if (!source) return { version: 1, status: "expired" };
  const cursor = query("cursor");
  if (!cursor) return { version: 1, status: "invalid" };
  return bridgeTranscriptPage(source.messages, {
    generation: source.generation,
    contentEpoch: source.contentEpoch,
    complete: source.complete,
    cursor,
    limit: Number(query("limit")),
    targetBytes: Number(query("targetBytes")),
  });
}
