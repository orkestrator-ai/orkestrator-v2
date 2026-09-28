/**
 * Encoded-size accounting for retained native-agent transcript content.
 *
 * The renderer bounds how much transcript it keeps by the UTF-8 length of the
 * JSON encoding — a retention proxy, not an exact heap measurement. Measuring
 * that by serializing the whole joined message array made every streamed tail
 * update re-encode up to 8 MiB of immutable history on the main thread, several
 * times per install.
 *
 * Instead each message is measured once, when it is first seen, and the size
 * is cached against the object's identity. An array's size is then derived
 * from its elements: `[` + elements joined by `,` + `]`, which is exactly what
 * `JSON.stringify` produces for an array of plain data, so the derived total is
 * byte-for-byte equal to encoding the joined array.
 *
 * Identity caching is only sound because transcript messages are immutable
 * once received: wire payloads are freshly parsed, delta application builds
 * new arrays around the objects it keeps, and every rewrite on the display
 * path (`preferCompleteLiveHead`, pinning, block splitting) copies rather than
 * edits. A change to a message therefore always arrives as a new object, and
 * is measured as one. Any code that mutated a received message in place would
 * make its cached size stale — keep it immutable.
 *
 * Sizes are always measured from the received value. Nothing here accepts a
 * size a peer reported, so a malformed or malicious payload cannot understate
 * itself past client memory admission.
 *
 * The cache is a `WeakMap`, so it never outlives the messages it describes and
 * cannot grow into a registry of every message a tab has visited.
 */

export type EncodedValueMeasure = (value: unknown) => number;

/**
 * UTF-8 length of a string without allocating the encoded buffer.
 *
 * Matches `TextEncoder`, including its replacement of a lone surrogate with
 * U+FFFD (three bytes). `JSON.stringify` escapes lone surrogates anyway, so
 * that case only matters for callers measuring arbitrary strings.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Bytes one value occupies as an element of a JSON array.
 *
 * Values `JSON.stringify` cannot represent on their own (`undefined`, functions,
 * symbols, array holes) encode as `null` inside an array.
 */
export function measureEncodedValue(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 4 : utf8ByteLength(json);
}

let measure: EncodedValueMeasure = measureEncodedValue;
let sizes = new WeakMap<object, number>();

/**
 * The encoded size of one value, measured at most once per object identity.
 *
 * Primitives cannot key a `WeakMap` and are cheap, so they are measured
 * directly.
 */
export function encodedValueBytes(value: unknown): number {
  if (value === null || typeof value !== "object") return measure(value);
  const cached = sizes.get(value);
  if (cached !== undefined) return cached;
  const bytes = measure(value);
  sizes.set(value, bytes);
  return bytes;
}

/**
 * Exactly `utf8(JSON.stringify(values)).byteLength`, derived from the cached
 * element sizes. Only elements this module has not seen before are serialized.
 */
export function encodedArrayBytes(values: readonly unknown[]): number {
  let bytes = 2;
  for (let index = 0; index < values.length; index += 1) {
    bytes += encodedValueBytes(values[index]);
  }
  return values.length > 1 ? bytes + values.length - 1 : bytes;
}

/**
 * Bytes a retained history holds against the client history budget.
 *
 * An empty history retains nothing, so it counts as zero rather than as the
 * two bytes of `[]`. That keeps a session with no pages out of the global
 * eviction pass, which would otherwise bump its eviction generation — and
 * discard its paging state — to reclaim nothing.
 */
export function retainedHistoryBytes(messages: readonly unknown[]): number {
  return messages.length === 0 ? 0 : encodedArrayBytes(messages);
}

/** The reference measurement the cached accounting must always agree with. */
export function slowEncodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Swap the measurement function and drop every cached size.
 *
 * Tests use this to count how many values actually get serialized. Passing
 * nothing restores the real measurement.
 */
export function setEncodedValueMeasureForTests(next?: EncodedValueMeasure): void {
  measure = next ?? measureEncodedValue;
  sizes = new WeakMap();
}
