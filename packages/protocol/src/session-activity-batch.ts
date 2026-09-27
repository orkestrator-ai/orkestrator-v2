/**
 * Wire contract for `POST /sessions/activity`, the batched form of every HTTP
 * bridge's `GET /session/:id/activity`.
 *
 * The backend's activity sweep reads every persisted session every couple of
 * seconds. One request per session made an environment with many retained
 * sessions issue many small requests, and a slow read delayed every later
 * session in its group. This route answers a bounded set of sessions from the
 * exact code path the single route uses, so the two cannot disagree.
 *
 * The no-touch contract is the single route's, unchanged: answering must not
 * refresh liveness (`lastAccessed`), hydrate a transcript, attach or re-attach
 * an agent, or call a catalogue/status path that does any of those.
 *
 * The path is deliberately outside `/session/...`: every bridge routes
 * `/session/:id/...` by id, and a one-segment `/session/<word>` could be read
 * as a session id by an older router.
 *
 * Completeness is part of the contract. Every requested id is answered, and an
 * id the bridge could not read is answered `unavailable` rather than omitted:
 * absence is never evidence of idleness, and `missing` is only ever the
 * bridge's proof that the session does not exist (Claude, for example, answers
 * a failed existence probe `idle`, exactly as its single route does).
 */

export const SESSION_ACTIVITY_BATCH_PATH = "/sessions/activity";
export const SESSION_ACTIVITY_BATCH_VERSION = 1;

export const SESSION_ACTIVITY_BATCH_LIMITS = {
  /** Session ids per request; callers split larger groups into chunks. */
  maxSessions: 64,
  /** UTF-8 bytes per session id. Longer ids use the single route. */
  maxSessionIdBytes: 1_024,
  /** Request body bytes: 64 maximal ids plus JSON framing fit comfortably. */
  maxRequestBytes: 96 * 1024,
  /**
   * Serialized response bytes. An observation that does not fit is answered
   * `deferred` so the caller reads it through the single route instead; no
   * attention item is ever truncated to make a batch fit.
   */
  maxResponseBytes: 512 * 1024,
  /** Mirrors the single route's attention-metadata bound. */
  maxAsyncQuestionItemIds: 64,
  maxAsyncQuestionItemIdLength: 2_048,
  /** Per-bridge read fan-out while answering one request. */
  readConcurrency: 4,
} as const;

export type SessionActivityState = "idle" | "working" | "waiting" | "missing";

/** Exactly what `GET /session/:id/activity` answers for one session. */
export interface SessionActivityObservation {
  activity: SessionActivityState;
  /** The composer can accept input even if background work keeps it working. */
  readyForInput?: boolean;
  /** Content-free provider item ids that require attention. */
  asyncQuestionItemIds?: string[];
  /** Cursor: the session is being permanently closed. */
  closing?: boolean;
}

/**
 * One answered id. `unavailable`: this bridge could not read the session, which
 * is uncertainty and never evidence of deletion or idleness. `deferred`: the
 * observation did not fit the response budget; read it individually.
 */
export type SessionActivityBatchEntry =
  | SessionActivityObservation
  | { activity: "unavailable" }
  | { activity: "deferred" };

export interface SessionActivityBatchRequest {
  version: typeof SESSION_ACTIVITY_BATCH_VERSION;
  sessionIds: string[];
}

export interface SessionActivityBatchResponse {
  version: typeof SESSION_ACTIVITY_BATCH_VERSION;
  observations: Record<string, SessionActivityBatchEntry>;
}

const SESSION_ACTIVITY_STATES = new Set<string>(["idle", "working", "waiting", "missing"]);
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a provider session id may be sent in a batch at all. */
export function isBatchableSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    encoder.encode(value).byteLength <= SESSION_ACTIVITY_BATCH_LIMITS.maxSessionIdBytes
  );
}

/**
 * Strictly validate one observation. Known fields must be well formed; fields
 * this version does not define are dropped, so a later additive field cannot
 * break an older reader. Returns `undefined` for anything malformed.
 */
export function parseSessionActivityObservation(
  value: unknown,
): SessionActivityObservation | undefined {
  if (!isRecord(value)) return undefined;
  const { activity, readyForInput, asyncQuestionItemIds, closing } = value;
  if (typeof activity !== "string" || !SESSION_ACTIVITY_STATES.has(activity)) return undefined;
  if (readyForInput !== undefined && typeof readyForInput !== "boolean") return undefined;
  if (closing !== undefined && typeof closing !== "boolean") return undefined;
  let itemIds: string[] | undefined;
  if (asyncQuestionItemIds !== undefined) {
    if (
      !Array.isArray(asyncQuestionItemIds) ||
      asyncQuestionItemIds.length > SESSION_ACTIVITY_BATCH_LIMITS.maxAsyncQuestionItemIds ||
      !asyncQuestionItemIds.every(
        (itemId) =>
          typeof itemId === "string" &&
          itemId.length > 0 &&
          itemId.length <= SESSION_ACTIVITY_BATCH_LIMITS.maxAsyncQuestionItemIdLength,
      )
    ) {
      return undefined;
    }
    itemIds = [...(asyncQuestionItemIds as string[])];
  }
  return {
    activity: activity as SessionActivityState,
    ...(readyForInput !== undefined ? { readyForInput } : {}),
    ...(itemIds !== undefined ? { asyncQuestionItemIds: itemIds } : {}),
    ...(closing !== undefined ? { closing } : {}),
  };
}

/** Bridge side: validate a request body. Duplicate ids are refused, not merged. */
export function parseSessionActivityBatchRequest(
  value: unknown,
): { ok: true; sessionIds: string[] } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Expected a JSON object" };
  if (value.version !== SESSION_ACTIVITY_BATCH_VERSION) {
    return { ok: false, error: "Unsupported activity batch version" };
  }
  const { sessionIds } = value;
  if (!Array.isArray(sessionIds)) return { ok: false, error: "sessionIds must be an array" };
  if (sessionIds.length > SESSION_ACTIVITY_BATCH_LIMITS.maxSessions) {
    return { ok: false, error: "Too many sessionIds" };
  }
  const seen = new Set<string>();
  for (const sessionId of sessionIds) {
    if (!isBatchableSessionId(sessionId)) return { ok: false, error: "Invalid sessionId" };
    if (seen.has(sessionId)) return { ok: false, error: "Duplicate sessionId" };
    seen.add(sessionId);
  }
  return { ok: true, sessionIds: sessionIds as string[] };
}

/**
 * Backend side: validate a response against the ids that were asked for.
 *
 * Every requested id must be answered and nothing else may be: a response that
 * omits a session would otherwise let the caller infer an answer from absence.
 */
export function parseSessionActivityBatchResponse(
  value: unknown,
  requestedIds: readonly string[],
): { ok: true; entries: Map<string, SessionActivityBatchEntry> } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Expected a JSON object" };
  if (value.version !== SESSION_ACTIVITY_BATCH_VERSION) {
    return { ok: false, error: "Unsupported activity batch version" };
  }
  const { observations } = value;
  if (!isRecord(observations)) return { ok: false, error: "observations must be an object" };
  const answered = Object.keys(observations);
  if (answered.length !== new Set(requestedIds).size) {
    return { ok: false, error: "observations do not match the request" };
  }
  const entries = new Map<string, SessionActivityBatchEntry>();
  for (const sessionId of requestedIds) {
    if (!Object.hasOwn(observations, sessionId)) {
      return { ok: false, error: "observations omit a requested session" };
    }
    const raw = observations[sessionId];
    if (isRecord(raw) && (raw.activity === "unavailable" || raw.activity === "deferred")) {
      entries.set(sessionId, { activity: raw.activity });
      continue;
    }
    const observation = parseSessionActivityObservation(raw);
    if (!observation) return { ok: false, error: "malformed observation" };
    entries.set(sessionId, observation);
  }
  return { ok: true, entries };
}

/**
 * Read a request body without ever buffering more than `maxBytes`. Accepts a
 * Node `IncomingMessage` (an async iterable of chunks) or a web stream.
 */
export async function readBoundedBody(
  source: AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number = SESSION_ACTIVITY_BATCH_LIMITS.maxRequestBytes,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!source) return { ok: true, text: "" };
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  const accept = (chunk: Uint8Array | string): boolean => {
    const data = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    bytes += data.byteLength;
    if (bytes > maxBytes) return false;
    text += decoder.decode(data, { stream: true });
    return true;
  };
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!accept(value)) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
    }
  } else {
    for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
      // Leaving the loop early releases the iterator; a Node request stream is
      // then destroyed rather than drained, which is the point of the bound.
      if (!accept(chunk)) return { ok: false };
    }
  }
  return { ok: true, text: text + decoder.decode() };
}

function entryBytes(sessionId: string, entry: SessionActivityBatchEntry): number {
  return encoder.encode(JSON.stringify({ [sessionId]: entry })).byteLength;
}

/**
 * Bridge side: answer every id from the bridge's single-route reader.
 *
 * `read` must be the function the bridge's `GET /session/:id/activity` answers
 * with, so the batch cannot drift from it. A throw or a malformed observation
 * answers `unavailable` for that id only. If the answers exceed the response
 * budget, the largest are answered `deferred` until they fit.
 */
export async function buildSessionActivityBatchResponse(
  sessionIds: readonly string[],
  read: (sessionId: string) => unknown,
  options: { concurrency?: number; maxResponseBytes?: number } = {},
): Promise<SessionActivityBatchResponse> {
  const entries: SessionActivityBatchEntry[] = Array.from(
    { length: sessionIds.length },
    () => ({ activity: "unavailable" }) as const,
  );
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < sessionIds.length) {
      const index = next++;
      try {
        entries[index] = parseSessionActivityObservation(await read(sessionIds[index]!)) ?? {
          activity: "unavailable",
        };
      } catch {
        entries[index] = { activity: "unavailable" };
      }
    }
  };
  const concurrency = Math.max(
    1,
    Math.min(
      options.concurrency ?? SESSION_ACTIVITY_BATCH_LIMITS.readConcurrency,
      sessionIds.length,
    ),
  );
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const maxResponseBytes =
    options.maxResponseBytes ?? SESSION_ACTIVITY_BATCH_LIMITS.maxResponseBytes;
  const sizes = sessionIds.map((sessionId, index) => entryBytes(sessionId, entries[index]!));
  // Framing (`{"version":1,"observations":{}}`) plus one comma per entry.
  let total = 32 + sizes.reduce((sum, size) => sum + size, 0);
  if (total > maxResponseBytes) {
    const largestFirst = sizes
      .map((size, index) => ({ size, index }))
      .sort((a, b) => b.size - a.size);
    for (const { size, index } of largestFirst) {
      if (total <= maxResponseBytes) break;
      entries[index] = { activity: "deferred" };
      total -= size - entryBytes(sessionIds[index]!, entries[index]!);
    }
  }
  // `Object.fromEntries` defines own properties, so an id such as `__proto__`
  // is answered as data rather than rewriting the object's prototype.
  return {
    version: SESSION_ACTIVITY_BATCH_VERSION,
    observations: Object.fromEntries(
      sessionIds.map((sessionId, index) => [sessionId, entries[index]!]),
    ),
  };
}

/**
 * Bridge side: the whole route. Returns the status and JSON body to send, so
 * each bridge's router only has to supply its body source and its reader.
 */
export async function answerSessionActivityBatch(
  body: Parameters<typeof readBoundedBody>[0],
  read: (sessionId: string) => unknown,
  options: { contentLength?: string | null; concurrency?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const declared = options.contentLength ? Number(options.contentLength) : undefined;
  if (declared !== undefined && declared > SESSION_ACTIVITY_BATCH_LIMITS.maxRequestBytes) {
    return { status: 413, body: { error: "Request body is too large" } };
  }
  const raw = await readBoundedBody(body);
  if (!raw.ok) return { status: 413, body: { error: "Request body is too large" } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return { status: 400, body: { error: "Request body must be valid JSON" } };
  }
  const request = parseSessionActivityBatchRequest(parsed);
  if (!request.ok) return { status: 400, body: { error: request.error } };
  return {
    status: 200,
    body: await buildSessionActivityBatchResponse(
      request.sessionIds,
      read,
      options.concurrency !== undefined ? { concurrency: options.concurrency } : {},
    ),
  };
}
