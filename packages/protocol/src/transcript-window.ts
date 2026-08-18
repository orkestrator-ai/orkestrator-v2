/**
 * Byte-aware transcript windowing shared by every transcript transport.
 *
 * The Claude bridge, the Codex bridge and the backend's native projection all
 * face the same problem: a transcript that has outgrown the transport ceiling
 * must degrade to an explicit tail window rather than fail the read. They used
 * to carry three copies of this logic, including the non-obvious envelope
 * reserve and the UTF-8 continuation-byte backup, which is exactly the kind of
 * subtlety that drifts between copies.
 *
 * Trimming order is oldest-first: whole messages from the front, then parts
 * from the front of the oldest message left, then the head of that message's
 * own `content`. The newest content is what a user is looking at, so it is the
 * last thing to go.
 */

import { Buffer } from "node:buffer";

/** JSON envelope around the message array: response keys and window metadata. */
const DEFAULT_ENVELOPE_RESERVE_BYTES = 256;
/** Retained tail of `content` when even a part-less message is over budget. */
const DEFAULT_CONTENT_FALLBACK_BYTES = 1024 * 1024;

export interface TranscriptWindowMetadata {
  /** True when any message, part, or content head was omitted. */
  truncated: boolean;
  /** Whole messages omitted from the front of the transcript. */
  omittedMessages?: number;
  /** Parts omitted from the front of the oldest retained message. */
  omittedParts?: number;
}

export interface BoundedTranscript<TMessage> {
  messages: TMessage[];
  messageWindow: TranscriptWindowMetadata;
  /**
   * True when the newest message alone is still over budget after every other
   * lever was pulled. Callers that declined the content fallback use this to
   * decide between reporting a degraded window and failing the read.
   */
  overflowed: boolean;
}

export interface BoundTranscriptOptions {
  /**
   * Bytes reserved for whatever JSON wraps the message array. Pass `0` when the
   * bound applies to the bare array rather than to a response body.
   */
  envelopeReserveBytes?: number;
  /**
   * Bytes of the final message's `content` to retain when dropping every part
   * still leaves it over budget, or `null` to leave `content` untouched and
   * report `overflowed` instead.
   */
  contentFallbackBytes?: number | null;
}

interface BoundableMessage {
  content: string;
  parts: unknown[];
}

/**
 * The last `maximumBytes` bytes of `value`, starting on a code-point boundary.
 *
 * Cutting mid-sequence would make the decoder substitute U+FFFD, which is three
 * bytes and can push the result back over the cap it was cut to fit.
 */
export function retainUtf8Tail(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const encoded = Buffer.from(value);
  if (encoded.length <= maximumBytes) return value;
  let start = encoded.length - maximumBytes;
  while (start < encoded.length && (encoded[start]! & 0b1100_0000) === 0b1000_0000) start += 1;
  return encoded.subarray(start).toString("utf8");
}

export function boundTranscriptResponse<TMessage extends BoundableMessage>(
  messages: readonly TMessage[],
  maximumBytes: number,
  options: BoundTranscriptOptions = {},
): BoundedTranscript<TMessage> {
  const envelope = options.envelopeReserveBytes ?? DEFAULT_ENVELOPE_RESERVE_BYTES;
  const contentFallbackBytes =
    options.contentFallbackBytes === undefined
      ? DEFAULT_CONTENT_FALLBACK_BYTES
      : options.contentFallbackBytes;

  const selected = [...messages];
  const sizes = selected.map((message) => Buffer.byteLength(JSON.stringify(message)));
  // Array brackets plus one comma between each adjacent pair.
  let bytes =
    envelope + 2 + sizes.reduce((total, size) => total + size, 0) + Math.max(0, sizes.length - 1);
  let start = 0;
  while (bytes > maximumBytes && start < selected.length - 1) {
    bytes -= sizes[start]! + 1;
    start += 1;
  }

  let omittedParts = 0;
  let truncatedContent = false;
  const oldestRetained = selected[start];
  if (bytes > maximumBytes && oldestRetained) {
    // Only the newest message can still be over budget: the loop above stops at
    // the final index, so `selected.slice(start)` is a single message here.
    //
    // Each part is serialized once and its size subtracted as it is shed.
    // Re-measuring the whole message per shift is quadratic, and this path only
    // ever runs when that message is already multi-megabyte — a message built
    // from many small parts would otherwise cost thousands of full passes.
    const parts = [...oldestRetained.parts];
    const partSizes = parts.map((part) => Buffer.byteLength(JSON.stringify(part)));
    while (parts.length > 0 && bytes > maximumBytes) {
      parts.shift();
      const shed = partSizes.shift()!;
      // A removed part takes its separating comma with it, except the last one.
      bytes -= shed + (parts.length > 0 ? 1 : 0);
      omittedParts += 1;
    }
    if (omittedParts > 0) {
      selected[start] = { ...oldestRetained, parts } as TMessage;
    }
    if (bytes > maximumBytes && contentFallbackBytes !== null) {
      selected[start] = {
        ...oldestRetained,
        content: retainUtf8Tail(oldestRetained.content, contentFallbackBytes),
        parts: [],
      } as TMessage;
      omittedParts = oldestRetained.parts.length;
      truncatedContent = true;
      bytes = envelope + 2 + Buffer.byteLength(JSON.stringify(selected[start]));
    }
  }

  const bounded = selected.slice(start);
  const omittedMessages = messages.length - bounded.length;
  return {
    messages: bounded,
    overflowed: bytes > maximumBytes,
    messageWindow: {
      truncated: omittedMessages > 0 || omittedParts > 0 || truncatedContent,
      ...(omittedMessages > 0 ? { omittedMessages } : {}),
      ...(omittedParts > 0 ? { omittedParts } : {}),
    },
  };
}
