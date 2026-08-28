import { createHash, randomBytes } from "node:crypto";

export const GROK_INTERJECT_METHOD = "_x.ai/interject";
export const GROK_INTERJECTION_NOTIFICATION = "_x.ai/session/interjection";
export const MAX_GROK_INTERJECTION_JOURNAL = 256;
export const MAX_GROK_INTERJECTION_ID_BYTES = 512;
export const MAX_GROK_INTERJECTION_TEXT_BYTES = 64 * 1024;

/**
 * This generation deliberately changes on every bridge process start. Grok's
 * extension cannot bind an interjection to a prompt itself, so a future
 * adapter may only compare run tokens inside one live process.
 */
export const grokBridgeGeneration = randomBytes(12).toString("base64url");

export type GrokInterjectionState = "prepared" | "queued" | "delivered" | "ambiguous";

export interface GrokInterjectionJournalEntry {
  requestId: string;
  expectedRunId: string;
  inputDigest: string;
  state: GrokInterjectionState;
  createdAt: number;
  updatedAt: number;
}

export interface GrokInterjectRequest {
  sessionId: string;
  text: string;
  interjectionId: string;
}

export interface GrokInterjectResult {
  status: "queued";
}

export interface GrokInterjectionBroadcast {
  sessionId: string;
  interjectionId: string;
  text: string;
}

export interface GrokRpcRequester {
  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface GrokInterjectionQualification {
  extension: "available" | "absent" | "unknown";
  productionSteer: false;
  reason:
    | "recognized-invalid-session"
    | "method-not-found"
    | "unsafe-invalid-session-acceptance"
    | "probe-failed";
}

export function grokRunId(promptSequence: number): string {
  return `grok:${grokBridgeGeneration}:${promptSequence}`;
}

export function grokInterjectionDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseGrokInterjectResult(value: unknown): GrokInterjectResult | null {
  if (!isObject(value) || value.status !== "queued") return null;
  return { status: "queued" };
}

export function parseGrokInterjectionBroadcast(
  method: string,
  value: unknown,
): GrokInterjectionBroadcast | null {
  if (method !== GROK_INTERJECTION_NOTIFICATION || !isObject(value)) return null;
  if (
    typeof value.sessionId !== "string" ||
    typeof value.interjectionId !== "string" ||
    typeof value.text !== "string" ||
    !value.sessionId ||
    !value.interjectionId ||
    Buffer.byteLength(value.interjectionId) > MAX_GROK_INTERJECTION_ID_BYTES ||
    Buffer.byteLength(value.text) > MAX_GROK_INTERJECTION_TEXT_BYTES
  ) {
    return null;
  }
  return {
    sessionId: value.sessionId,
    interjectionId: value.interjectionId,
    text: value.text,
  };
}

export async function requestGrokInterjection(
  requester: GrokRpcRequester,
  input: GrokInterjectRequest,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<GrokInterjectResult> {
  const result = await requester.request(
    GROK_INTERJECT_METHOD,
    {
      sessionId: input.sessionId,
      text: input.text,
      interjectionId: input.interjectionId,
    },
    timeoutMs,
    signal,
  );
  const parsed = parseGrokInterjectResult(result);
  if (!parsed) throw new Error("Grok returned an invalid interjection result");
  return parsed;
}

/**
 * Store a journal entry without retaining the instruction itself. The backend
 * owns the protected retry copy; this bridge needs only a digest to reject a
 * caller that reuses an opaque id for different content.
 */
export function setGrokInterjectionJournal(
  journal: Map<string, GrokInterjectionJournalEntry>,
  entry: GrokInterjectionJournalEntry,
): void {
  if (!journal.has(entry.requestId) && journal.size >= MAX_GROK_INTERJECTION_JOURNAL) {
    const oldest = journal.keys().next().value;
    if (typeof oldest === "string") journal.delete(oldest);
  }
  journal.set(entry.requestId, entry);
}

export function prepareGrokInterjection(
  journal: Map<string, GrokInterjectionJournalEntry>,
  input: {
    requestId: string;
    expectedRunId: string;
    currentRunId?: string;
    text: string;
    running: boolean;
    now?: number;
  },
):
  | { outcome: "prepared"; entry: GrokInterjectionJournalEntry }
  | { outcome: "duplicate"; state: GrokInterjectionState }
  | { outcome: "conflict" | "idle" | "mismatch" | "invalid" } {
  if (
    !input.requestId ||
    !input.expectedRunId ||
    !input.text.trim() ||
    Buffer.byteLength(input.requestId) > MAX_GROK_INTERJECTION_ID_BYTES ||
    Buffer.byteLength(input.text) > MAX_GROK_INTERJECTION_TEXT_BYTES
  ) {
    return { outcome: "invalid" };
  }
  const inputDigest = grokInterjectionDigest(input.text);
  const existing = journal.get(input.requestId);
  if (existing) {
    if (existing.expectedRunId !== input.expectedRunId || existing.inputDigest !== inputDigest) {
      return { outcome: "conflict" };
    }
    return { outcome: "duplicate", state: existing.state };
  }
  if (!input.running || !input.currentRunId) return { outcome: "idle" };
  if (input.currentRunId !== input.expectedRunId) return { outcome: "mismatch" };
  const now = input.now ?? Date.now();
  const entry: GrokInterjectionJournalEntry = {
    requestId: input.requestId,
    expectedRunId: input.expectedRunId,
    inputDigest,
    state: "prepared",
    createdAt: now,
    updatedAt: now,
  };
  setGrokInterjectionJournal(journal, entry);
  return { outcome: "prepared", entry };
}

export function markGrokInterjectionQueued(
  journal: Map<string, GrokInterjectionJournalEntry>,
  requestId: string,
  now = Date.now(),
): GrokInterjectionJournalEntry | null {
  const entry = journal.get(requestId);
  if (!entry || entry.state !== "prepared") return null;
  const queued = { ...entry, state: "queued" as const, updatedAt: now };
  setGrokInterjectionJournal(journal, queued);
  return queued;
}

/**
 * The broadcast is delivery evidence, not provider idempotency. Grok accepts
 * the same interjection id more than once, so only a bridge-owned journal entry
 * with the same digest can be settled by it.
 */
export function applyGrokInterjectionBroadcast(
  journal: Map<string, GrokInterjectionJournalEntry>,
  acpSessionId: string,
  method: string,
  params: unknown,
  now = Date.now(),
): GrokInterjectionBroadcast | null {
  const broadcast = parseGrokInterjectionBroadcast(method, params);
  if (!broadcast || broadcast.sessionId !== acpSessionId) return null;
  const entry = journal.get(broadcast.interjectionId);
  if (!entry || entry.inputDigest !== grokInterjectionDigest(broadcast.text)) return null;
  if (entry.state !== "prepared" && entry.state !== "queued" && entry.state !== "delivered") {
    return null;
  }
  setGrokInterjectionJournal(journal, {
    ...entry,
    state: "delivered",
    updatedAt: now,
  });
  return broadcast;
}

/**
 * Opt-in upgrade probe. It uses a unique nonexistent session and empty text,
 * so recognition can be distinguished from JSON-RPC method absence without
 * injecting content into a real prompt. Recognition still does not enable
 * steer: the pinned CLI's stale-session fallback violates the product contract.
 */
export async function probeGrokInterjectionExtension(
  requester: GrokRpcRequester,
): Promise<GrokInterjectionQualification> {
  const probeId = `orkestrator-qualification-${randomBytes(12).toString("base64url")}`;
  try {
    await requestGrokInterjection(requester, {
      sessionId: probeId,
      interjectionId: probeId,
      text: "",
    });
    return {
      extension: "available",
      productionSteer: false,
      reason: "unsafe-invalid-session-acceptance",
    };
  } catch (error) {
    if (rpcErrorCode(error) === -32601) {
      return { extension: "absent", productionSteer: false, reason: "method-not-found" };
    }
    if (typeof rpcErrorCode(error) === "number") {
      return {
        extension: "available",
        productionSteer: false,
        reason: "recognized-invalid-session",
      };
    }
    return { extension: "unknown", productionSteer: false, reason: "probe-failed" };
  }
}

function rpcErrorCode(error: unknown): number | undefined {
  if (!isObject(error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
