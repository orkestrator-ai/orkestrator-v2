import { boundTranscriptResponse } from "./transcript-window.js";

export const BRIDGE_TRANSCRIPT_VERSION = 1 as const;
export const BRIDGE_TRANSCRIPT_MAX_MESSAGES = 100;
export const BRIDGE_TRANSCRIPT_TARGET_BYTES = 512 * 1024;

export interface BridgeTranscriptReadOptions {
  sessionIdentity: string;
  generation: string | number;
  contentEpoch: string | number;
  revision?: number;
  limit: number;
  targetBytes: number;
  knownToken?: string;
  complete: boolean;
  freshness?: "cached" | "current";
  title?: string;
}

function boundedInteger(value: number, maximum: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

/** Fast non-cryptographic digest for opaque cache identity, never authorization. */
function digest(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function bridgeTranscriptToken(
  options: BridgeTranscriptReadOptions,
  messages?: unknown[],
): string {
  const contentRevision =
    options.revision === undefined
      ? digest(JSON.stringify(messages ?? []))
      : String(options.revision);
  return [
    "bt1",
    digest(options.sessionIdentity),
    digest(String(options.generation)),
    digest(String(options.contentEpoch)),
    contentRevision,
    boundedInteger(options.limit, BRIDGE_TRANSCRIPT_MAX_MESSAGES, BRIDGE_TRANSCRIPT_MAX_MESSAGES),
    boundedInteger(
      options.targetBytes,
      BRIDGE_TRANSCRIPT_TARGET_BYTES,
      BRIDGE_TRANSCRIPT_TARGET_BYTES,
    ),
  ].join(".");
}

/**
 * Builds the shared conditional bridge envelope without serializing omitted
 * history. A known revision can answer unchanged before touching message text.
 */
export function bridgeTranscriptUpdate<T extends { content: string; parts: unknown[] }>(
  messages: readonly T[],
  options: BridgeTranscriptReadOptions,
):
  | { version: 1; status: "unchanged"; token: string }
  | {
      version: 1;
      status: "snapshot";
      token: string;
      value: {
        messages: T[];
        complete: boolean;
        messageWindow: {
          truncated: boolean;
          truncationReason?: "count" | "bytes";
          omittedMessages?: number;
          omittedParts?: number;
        };
        revision?: number;
        generation: string | number;
        contentEpoch: string | number;
        freshness: "cached" | "current";
        title?: string;
      };
    } {
  const limit = boundedInteger(
    options.limit,
    BRIDGE_TRANSCRIPT_MAX_MESSAGES,
    BRIDGE_TRANSCRIPT_MAX_MESSAGES,
  );
  const targetBytes = boundedInteger(
    options.targetBytes,
    BRIDGE_TRANSCRIPT_TARGET_BYTES,
    BRIDGE_TRANSCRIPT_TARGET_BYTES,
  );
  const token = bridgeTranscriptToken({ ...options, limit, targetBytes }, messages as unknown[]);
  if (options.knownToken === token) return { version: 1, status: "unchanged", token };

  const candidates = messages.slice(-limit);
  const bounded = boundTranscriptResponse(candidates, targetBytes, {
    envelopeReserveBytes: 0,
    contentFallbackBytes: 64 * 1024,
  });
  const omittedMessages = messages.length - bounded.messages.length;
  /*
   * Two independent reasons a reader may be missing history, kept apart.
   *
   * `windowTruncated` is what *this* response cut to fit its window, and is
   * the only thing `truncationReason` can honestly describe. A source that
   * already lost older history reports `complete: false`; that also leaves the
   * window truncated for the reader, but attributing it to bytes or count
   * would name a trim that never happened.
   */
  const windowTruncated = bounded.messageWindow.truncated || omittedMessages > 0;
  const truncated = !options.complete || windowTruncated;
  return {
    version: 1,
    status: "snapshot",
    token,
    value: {
      messages: bounded.messages,
      complete: options.complete && !windowTruncated,
      messageWindow: {
        truncated,
        ...(windowTruncated
          ? {
              truncationReason:
                messages.length > limit && candidates.length === bounded.messages.length
                  ? ("count" as const)
                  : ("bytes" as const),
              ...(omittedMessages > 0 ? { omittedMessages } : {}),
              ...(bounded.messageWindow.omittedParts
                ? { omittedParts: bounded.messageWindow.omittedParts }
                : {}),
            }
          : {}),
      },
      ...(options.revision === undefined ? {} : { revision: options.revision }),
      generation: options.generation,
      contentEpoch: options.contentEpoch,
      freshness: options.freshness ?? "current",
      ...(options.title ? { title: options.title } : {}),
    },
  };
}
