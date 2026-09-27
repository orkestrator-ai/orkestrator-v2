/**
 * Backend side of the bridge transcript v2 contract
 * (`packages/protocol/src/bridge-transcript-summary.ts`).
 *
 * Capabilities are learned from answers, never assumed: a bridge that predates
 * v2 ignores `version=2` and answers its v1 envelope, which is read as v1 and
 * remembered, so an old bridge costs no extra round trip. A 404/405 from the
 * detail or page route means the route does not exist on this bridge. A
 * timeout, a 5xx or a malformed body proves nothing about capability and is
 * reported as a failed read instead.
 *
 * One instance lives on each `HttpBridgeProvider`, and a provider serves one
 * bridge connection, so every answer here is scoped to one bridge generation.
 * Negative answers still expire, because a bridge can be upgraded in place.
 */
import {
  parseBridgeTranscriptDetailResponse,
  parseBridgeTranscriptPageResponse,
  parseBridgeTranscriptSummaryUpdate,
} from "@orkestrator/protocol/bridge-transcript-summary";
import {
  ProviderUnavailableError,
  type BridgeConnection,
  type ProviderTranscriptDetail,
  type ProviderTranscriptPage,
  type ProviderTranscriptSnapshot,
} from "./agent-provider-contract.js";
import type { HttpBridgeAgent } from "./http-bridge-catalog.js";
import { asRecord } from "./agent-provider-runtime.js";
import { assertOk, boundedJson, bridgeFetch } from "./http-bridge-transport.js";

/** How long a "this bridge does not serve it" answer is trusted. */
export const TRANSCRIPT_V2_NEGATIVE_TTL_MS = 10 * 60_000;
/** A detail envelope: the 16 MiB image ceiling plus room for its JSON wrapper. */
const DETAIL_RESPONSE_MAX_BYTES = 16 * 1024 * 1024 + 64 * 1024;
/** A page envelope: its 1 MiB target plus an oversized final row's fallback. */
const PAGE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

type Feature = "summaries" | "details" | "pages";

export class HttpBridgeTranscriptCapabilities {
  private readonly unsupportedUntil = new Map<Feature, number>();

  constructor(private readonly now: () => number = Date.now) {}

  supports(feature: Feature): boolean {
    const until = this.unsupportedUntil.get(feature);
    if (until === undefined) return true;
    if (this.now() < until) return false;
    this.unsupportedUntil.delete(feature);
    return true;
  }

  markUnsupported(feature: Feature): void {
    this.unsupportedUntil.set(feature, this.now() + TRANSCRIPT_V2_NEGATIVE_TTL_MS);
  }

  markSupported(feature: Feature): void {
    this.unsupportedUntil.delete(feature);
  }
}

interface ReadInput {
  agent: HttpBridgeAgent;
  connection: BridgeConnection;
  fetchImpl: typeof fetch;
  sessionId: string;
}

function historyEpoch(generation: unknown, contentEpoch: unknown): string {
  const g =
    typeof generation === "string" || Number.isSafeInteger(generation)
      ? String(generation)
      : "unknown";
  const e =
    typeof contentEpoch === "string" || Number.isSafeInteger(contentEpoch)
      ? String(contentEpoch)
      : "legacy";
  return `${g.slice(0, 63)}:${e.slice(0, 63)}`;
}

/**
 * Map a parsed v2 summary snapshot onto the provider-neutral snapshot, the
 * same way the v1 envelope is mapped, plus the representation and cursor.
 */
function summarySnapshot(
  update: Extract<ReturnType<typeof parseBridgeTranscriptSummaryUpdate>, { status: "snapshot" }>,
): ProviderTranscriptSnapshot {
  const value = update.value;
  const window = value.messageWindow;
  return {
    messages: value.messages,
    ...(window.omittedParts ? { omittedParts: window.omittedParts } : {}),
    ...(window.truncationReason === "bytes" && window.omittedMessages
      ? { byteOmittedMessages: window.omittedMessages }
      : {}),
    historyStartIndex: value.startIndex,
    sourceToken: update.token,
    complete: value.complete,
    ...(value.title ? { title: value.title } : {}),
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    generation: value.generation,
    historyEpoch: historyEpoch(value.generation, value.contentEpoch),
    freshness: value.freshness,
    representation: "summary",
    ...(value.capabilities.pages && value.historyCursor
      ? { historyCursor: value.historyCursor }
      : {}),
  };
}

/**
 * Read `/transcript?version=2`. Returns `undefined` when the bridge answered
 * v1 instead — with that body, so the caller can use it without re-reading.
 */
export async function readHttpBridgeSummaryTranscript(
  input: ReadInput & {
    options: { limit: number; targetBytes: number; knownSourceToken?: string };
  },
): Promise<
  | {
      kind: "summary";
      result: ProviderTranscriptSnapshot | { unchanged: true; sourceToken: string };
    }
  | { kind: "v1"; response: Response; body: Record<string, unknown> | null | undefined }
> {
  const query = new URLSearchParams({
    version: "2",
    limit: String(input.options.limit),
    targetBytes: String(input.options.targetBytes),
  });
  if (input.options.knownSourceToken) query.set("knownToken", input.options.knownSourceToken);
  const response = await bridgeFetch(
    input.connection,
    `/session/${encodeURIComponent(input.sessionId)}/transcript?${query.toString()}`,
    {},
    input.fetchImpl,
  );
  if (response.status === 404 || response.status === 405) {
    return { kind: "v1", response, body: undefined };
  }
  assertOk(response, `${input.agent} progressive transcript read`);
  const body = asRecord(
    await boundedJson(response, `${input.agent} progressive transcript read`, {
      remaining: TRANSCRIPT_RESPONSE_MAX_BYTES,
    }),
  );
  if (body?.version !== 2) return { kind: "v1", response, body };
  const update = parseBridgeTranscriptSummaryUpdate(body);
  if (!update) {
    throw new ProviderUnavailableError(`${input.agent} returned a malformed transcript summary`);
  }
  return update.status === "unchanged"
    ? { kind: "summary", result: { unchanged: true, sourceToken: update.token } }
    : { kind: "summary", result: summarySnapshot(update) };
}

/** `undefined` means this bridge has no detail route. */
export async function readHttpBridgeTranscriptDetail(
  input: ReadInput & { locator: string },
): Promise<ProviderTranscriptDetail | undefined> {
  const query = new URLSearchParams({ locator: input.locator });
  const response = await bridgeFetch(
    input.connection,
    `/session/${encodeURIComponent(input.sessionId)}/transcript/detail?${query.toString()}`,
    {},
    input.fetchImpl,
  );
  if (response.status === 404 || response.status === 405) return undefined;
  assertOk(response, `${input.agent} transcript detail read`);
  const parsed = parseBridgeTranscriptDetailResponse(
    await boundedJson(response, `${input.agent} transcript detail read`, {
      remaining: DETAIL_RESPONSE_MAX_BYTES,
    }),
  );
  if (!parsed) {
    throw new ProviderUnavailableError(`${input.agent} returned a malformed transcript detail`);
  }
  if (parsed.status === "ok") return { status: "ok", detail: parsed.detail };
  // A locator this backend minted from the bridge's own summary cannot be
  // malformed unless something between them is; that is not "missing".
  if (parsed.status === "invalid") {
    throw new ProviderUnavailableError(`${input.agent} rejected a transcript detail locator`);
  }
  return { status: parsed.status };
}

/** `undefined` means this bridge has no page route. */
export async function readHttpBridgeTranscriptPage(
  input: ReadInput & { cursor: string; limit: number; targetBytes: number },
): Promise<ProviderTranscriptPage | undefined> {
  const query = new URLSearchParams({
    cursor: input.cursor,
    limit: String(input.limit),
    targetBytes: String(input.targetBytes),
  });
  const response = await bridgeFetch(
    input.connection,
    `/session/${encodeURIComponent(input.sessionId)}/transcript/page?${query.toString()}`,
    {},
    input.fetchImpl,
  );
  if (response.status === 404 || response.status === 405) return undefined;
  assertOk(response, `${input.agent} transcript page read`);
  const parsed = parseBridgeTranscriptPageResponse(
    await boundedJson(response, `${input.agent} transcript page read`, {
      remaining: PAGE_RESPONSE_MAX_BYTES,
    }),
  );
  if (!parsed) {
    throw new ProviderUnavailableError(`${input.agent} returned a malformed transcript page`);
  }
  if (parsed.status !== "page") return { status: "expired" };
  return {
    status: "page",
    messages: parsed.messages,
    historyStartIndex: parsed.startIndex,
    ...(parsed.nextCursor ? { historyCursor: parsed.nextCursor } : {}),
    complete: parsed.complete,
    truncated: parsed.truncated,
    historyEpoch: historyEpoch(parsed.generation, parsed.contentEpoch),
    representation: "summary",
  };
}
