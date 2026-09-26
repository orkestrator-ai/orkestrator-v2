/**
 * The structured results one session retains, bounded by count and bytes.
 *
 * A structured result may be the only answer a pipeline reads after a restart,
 * so it is recovery state and the aggregate state-file budget never sheds it.
 * That is exactly why it needs its own bound: sixty-four 1 MiB results is twice
 * the whole state file, and one busy session would otherwise block publication
 * for every Cursor tab. The oldest results go first; the one just recorded is
 * never the one evicted.
 *
 * The same rule applies on restore, so a file written before this bound (or by
 * a buggy predecessor) cannot bring an unbounded session back to life.
 */
import { MAX_STRUCTURED_RESULTS, MAX_STRUCTURED_RESULTS_BYTES, PROVIDER } from "./config.js";
import type { SessionState } from "./state.js";

/** Encoded bytes of each retained result, keyed by the session's result map. */
const encodedSizes = new WeakMap<Map<string, unknown>, Map<string, number>>();

/**
 * Record `value` as the result for `requestId`, then evict the oldest results
 * until the session is within both bounds.
 *
 * A single result larger than the per-session byte bound is replaced by the
 * same explicit `output_too_large` failure a live oversized turn records, so
 * the request id still answers and the session stays bounded. A live turn can
 * never reach that branch: its output is capped at `MAX_STRUCTURED_RESULT_BYTES`
 * before it is parsed.
 */
export function setStructuredResult(state: SessionState, requestId: string, value: unknown): void {
  let bytes = encodedBytes(requestId, value);
  if (bytes > MAX_STRUCTURED_RESULTS_BYTES) {
    value = {
      ok: false,
      provider: PROVIDER,
      requestId,
      error: { code: "output_too_large", message: "Structured output exceeded the size limit" },
    };
    bytes = encodedBytes(requestId, value);
  }
  const structured = state.structured;
  let sizes = encodedSizes.get(structured);
  if (!sizes) {
    sizes = new Map();
    encodedSizes.set(structured, sizes);
  }
  // Re-recording an id makes it the newest rather than leaving it where the
  // first write put it.
  structured.delete(requestId);
  structured.set(requestId, value);
  sizes.set(requestId, bytes);

  let total = 0;
  for (const [id, retained] of structured) {
    let size = sizes.get(id);
    if (size === undefined) {
      size = encodedBytes(id, retained);
      sizes.set(id, size);
    }
    total += size;
  }
  for (const id of structured.keys()) {
    if (structured.size <= MAX_STRUCTURED_RESULTS && total <= MAX_STRUCTURED_RESULTS_BYTES) break;
    if (id === requestId) break;
    total -= sizes.get(id) ?? 0;
    structured.delete(id);
    sizes.delete(id);
  }
  if (sizes.size > structured.size) {
    for (const id of sizes.keys()) if (!structured.has(id)) sizes.delete(id);
  }
}

/** Bytes of `["id",value]` less the punctuation, which is bounded by the count. */
function encodedBytes(requestId: string, value: unknown): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    encoded = undefined;
  }
  return Buffer.byteLength(JSON.stringify(requestId)) + Buffer.byteLength(encoded ?? "null");
}
