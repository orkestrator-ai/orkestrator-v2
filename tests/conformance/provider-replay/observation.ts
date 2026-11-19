/**
 * What a replay pins: the bridge-visible outcome of the traffic, reduced to a
 * stable, reviewable, content-light JSON shape.
 *
 * The three things a provider upgrade must not change silently are covered
 * by three fields:
 *
 *  - `rows`: transcript assembly. One row per model response (invariant 14),
 *    each part's type, tool name and state, and a short excerpt of prose.
 *  - `pending`: interactions the user is being asked to answer.
 *  - `activity` / `completion`: whether the bridge reports the turn running,
 *    blocked or idle, and how the turn ended.
 *
 * `liveTail` reads the transcript through the production v2 summary route
 * (`bridgeTranscriptRouteBody`) with a small window, so a late update to a
 * row that has left the live tail is pinned as reaching readers through
 * `revisedMessages`, exactly as the backend reads it.
 *
 * Row and part ids are random in most bridges, so rows are referred to by
 * index. Tool outputs are reduced to their length; prose to a bounded
 * excerpt. A replay should fail when the structure changes, not when a
 * recorded file's contents shift by a line.
 */
import {
  bridgeTranscriptRouteBody,
  type BridgeTranscriptSource,
} from "@orkestrator/protocol/node/bridge-transcript-routes";

/** Prose longer than this is cut, with its full length kept beside it. */
export const REPLAY_EXCERPT_CHARS = 120;
/** The live-tail window the observation reads, in rows. */
export const REPLAY_LIVE_TAIL_ROWS = 2;

export interface ReplayPartShape {
  type: string;
  text?: string;
  textLength?: number;
  toolName?: string;
  toolState?: string;
  outputLength?: number;
  error?: true;
  leftRunning?: true;
  parentTask?: true;
}

export interface ReplayRowShape {
  role: string;
  text: string;
  textLength: number;
  parts: ReplayPartShape[];
}

export interface ReplayPendingShape {
  kind: string;
  toolName?: string;
}

export interface ReplayObservation {
  label: string;
  activity: string;
  completion?: Record<string, unknown>;
  pending: ReplayPendingShape[];
  rows: ReplayRowShape[];
  /**
   * Provider vocabulary the bridge had no branch for (`RuntimeHealthRecorder`
   * drift). Absent when clean. A new kind here after a provider bump is the
   * earliest sign the protocol moved.
   */
  drift?: { unknownEvents: number; unknownKinds: string[] };
  liveTail: {
    /** Absolute index of the first row in the live window. */
    startIndex: number;
    /** Rows before the window that the summary carries as revised, by index. */
    revisedOutsideTail: number[];
  };
  /** Bridge-specific facts an adapter pins (provider session id mapping, …). */
  extra?: Record<string, unknown>;
}

/** What an adapter reports for a checkpoint; `observe()` normalises it. */
export interface ReplayObservationInput<
  T extends { id: string; content: string; parts: unknown[] } = {
    id: string;
    content: string;
    parts: unknown[];
  },
> {
  /**
   * The session's transcript source, for an in-process adapter: the summary
   * is built from it through the production route body.
   */
  transcript?: BridgeTranscriptSource<T>;
  /**
   * For an adapter that drives a bridge process over HTTP instead: every row
   * (`/session/:id/messages`) and the bridge's own v2 summary of the live
   * tail (`/session/:id/transcript?version=2&limit=REPLAY_LIVE_TAIL_ROWS`).
   */
  served?: { messages: readonly T[]; summary: unknown };
  activity: string;
  completion?: Record<string, unknown>;
  pending: ReplayPendingShape[];
  drift?: { unknownEvents: number; unknownKinds: readonly string[] };
  extra?: Record<string, unknown>;
}

function excerpt(value: string): string {
  return value.length > REPLAY_EXCERPT_CHARS ? `${value.slice(0, REPLAY_EXCERPT_CHARS)}…` : value;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const PROSE_PART_TYPES = new Set(["text", "thinking", "reasoning", "status", "error", "file"]);

export function normalizePart(part: unknown): ReplayPartShape {
  const record = (part ?? {}) as Record<string, unknown>;
  const type = str(record.type) ?? "unknown";
  const shape: ReplayPartShape = { type };
  const content = str(record.content) ?? str(record.text);
  if (PROSE_PART_TYPES.has(type) && content !== undefined) {
    shape.text = excerpt(content);
    if (content.length > REPLAY_EXCERPT_CHARS) shape.textLength = content.length;
  }
  const toolName = str(record.toolName);
  if (toolName) shape.toolName = toolName;
  const toolState = str(record.toolState);
  if (toolState) shape.toolState = toolState;
  const output = str(record.toolOutput);
  if (output !== undefined) shape.outputLength = output.length;
  if (str(record.toolError)) shape.error = true;
  if (record.toolLeftRunning === true) shape.leftRunning = true;
  if (str(record.parentTaskUseId)) shape.parentTask = true;
  return shape;
}

export function normalizeRow(row: {
  role?: unknown;
  content: string;
  parts: unknown[];
}): ReplayRowShape {
  return {
    role: str(row.role) ?? "unknown",
    text: excerpt(row.content),
    textLength: row.content.length,
    parts: row.parts.map(normalizePart),
  };
}

/** Normalises one checkpoint, reading the live tail through the production route. */
export function observe<T extends { id: string; content: string; parts: unknown[] }>(
  label: string,
  input: ReplayObservationInput<T>,
): ReplayObservation {
  let messages: readonly T[];
  let summary: unknown;
  if (input.transcript) {
    messages = input.transcript.messages;
    const query: Record<string, string> = { version: "2", limit: String(REPLAY_LIVE_TAIL_ROWS) };
    summary = bridgeTranscriptRouteBody(input.transcript, (name) => query[name]);
  } else if (input.served) {
    messages = input.served.messages;
    summary = input.served.summary;
  } else {
    throw new Error(`${label}: an observation needs a transcript source or served rows`);
  }
  const body = summary as {
    status?: string;
    value?: { startIndex: number; revisedMessages?: unknown[] };
  };
  if (body.status !== "snapshot" || !body.value) {
    throw new Error(`transcript summary for ${label} was not a snapshot`);
  }
  const indexById = new Map(messages.map((message, index) => [message.id, index]));
  const revisedOutsideTail = (body.value.revisedMessages ?? [])
    .map((message) => indexById.get((message as { id?: string }).id ?? ""))
    .filter((index): index is number => index !== undefined)
    .sort((a, b) => a - b);
  return {
    label,
    activity: input.activity,
    ...(input.completion ? { completion: input.completion } : {}),
    pending: input.pending,
    ...(input.drift && input.drift.unknownEvents > 0
      ? {
          drift: {
            unknownEvents: input.drift.unknownEvents,
            unknownKinds: [...input.drift.unknownKinds].sort(),
          },
        }
      : {}),
    rows: messages.map((message) => normalizeRow(message as T & { role?: unknown })),
    liveTail: { startIndex: body.value.startIndex, revisedOutsideTail },
    ...(input.extra && Object.keys(input.extra).length > 0 ? { extra: input.extra } : {}),
  };
}
