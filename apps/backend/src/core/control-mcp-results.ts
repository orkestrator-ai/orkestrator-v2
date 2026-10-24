import {
  CONTROL_MCP_VOICE_TEXT_MAX_BYTES,
  type ControlMcpProfile,
} from "@orkestrator/protocol/control-mcp";
import {
  exitCodeForError,
  isPublicErrorCode,
  PUBLIC_API_SCHEMA_VERSION,
  PUBLIC_EXIT,
  type PublicActionResponse,
  type PublicErrorCode,
} from "@orkestrator/protocol/public-api";

/**
 * From a public envelope to an MCP tool result.
 *
 * `structuredContent` is the envelope unchanged (`ok`, `error.code`,
 * `exitCode`, `receipt`, `warnings`), so an MCP client sees the same codes
 * and classes as `orkestrator … --json`, and `isError` is set exactly when
 * `ok` is false. Only the text block depends on the profile:
 *
 * - voice: a short speakable `say` sentence built from structured fields,
 *   the IDs the next call needs, and a `next` hint on errors; at most 2 KB.
 * - every other profile: compact JSON, as the operator tools always returned.
 *
 * `say` never quotes transcript or prompt content beyond what a tool already
 * bounded (the `read_session` excerpt).
 */

/** Codes only this adapter produces; they are never public error codes. */
export type ControlMcpAdapterErrorCode = "confirmation-required";

export type ControlMcpErrorCode = PublicErrorCode | ControlMcpAdapterErrorCode;

export interface ControlMcpErrorEnvelope {
  schemaVersion: typeof PUBLIC_API_SCHEMA_VERSION;
  action: string;
  ok: false;
  error: {
    code: ControlMcpErrorCode;
    message: string;
    exitCode: number;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
  receipt?: PublicActionResponse["receipt"];
}

export type ControlMcpEnvelope = PublicActionResponse | ControlMcpErrorEnvelope;

export interface SpokenParts {
  /** One or two sentences a voice agent can read aloud. */
  say?: string;
  /** IDs needed for the next call. */
  ids?: Record<string, string | number | null | undefined>;
  /** Which tool to call next. */
  next?: string;
}

export function adapterError(
  action: string,
  code: ControlMcpErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ControlMcpErrorEnvelope {
  return {
    schemaVersion: PUBLIC_API_SCHEMA_VERSION,
    action,
    ok: false,
    error: {
      code,
      message,
      // Confirmation is an interaction the caller must complete, the same
      // class a pending question has.
      exitCode: isPublicErrorCode(code) ? exitCodeForError(code) : PUBLIC_EXIT.interactionRequired,
      ...(details ? { details } : {}),
    },
  };
}

/** Next-tool hints for the error codes a voice agent can act on. */
const NEXT_FOR_ERROR: Partial<Record<ControlMcpErrorCode, string>> = {
  busy: "The session is working: use steer_session to add guidance, or run_status to wait.",
  "interaction-required": "Answer the pending question or approval with answer_question.",
  "not-ready": "The environment is not ready yet: check again with run_status or overview.",
  "dispatch-unknown":
    "Delivery is unconfirmed: check with run_status, then run_action run.retry (same operation) or run.discard.",
  "dispatch-parked":
    "An earlier message is unconfirmed: run_action run.retry or run.discard on it first.",
  "ambiguous-target": "Ask which one was meant, then call resolve_target with the exact name.",
  "not-found": "Look the target up again with resolve_target.",
  "interaction-stale":
    "The question changed: read it again with overview or run_action session.interactions.",
  "confirmation-required":
    "Read the description aloud, get an explicit yes, then repeat the identical call with confirmToken.",
  "request-conflict": "That requestId was used for a different request: use a new requestId.",
  "capability-unavailable": "This credential cannot do that; say so instead of retrying.",
};

export function nextHint(code: ControlMcpErrorCode, action?: string): string | undefined {
  if (code === "busy" && action !== "session.prompt") {
    return "It is still in progress: check again later with run_status.";
  }
  return NEXT_FOR_ERROR[code];
}

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let cut = text.slice(0, maxBytes);
  while (Buffer.byteLength(`${cut}…`, "utf8") > maxBytes) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function defaultSay(envelope: ControlMcpEnvelope): string {
  if (!envelope.ok) return envelope.error.message;
  const receipt = envelope.receipt;
  if (receipt) {
    const state =
      receipt.state === "running" || receipt.state === "admitted" ? "started" : receipt.state;
    return `${envelope.action} ${state}.`;
  }
  return "Done.";
}

/** The speakable text block of a voice-profile result. */
export function voiceText(envelope: ControlMcpEnvelope, parts: SpokenParts = {}): string {
  const lines = [parts.say ?? defaultSay(envelope)];
  const ids: Record<string, string | number | null | undefined> = {
    ...(envelope.receipt ? { operationId: envelope.receipt.operationId } : {}),
    ...parts.ids,
  };
  const idText = Object.entries(ids)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  if (idText) lines.push(`ids: ${idText}`);
  const next =
    parts.next ?? (envelope.ok ? undefined : nextHint(envelope.error.code, envelope.action));
  if (next) lines.push(`next: ${next}`);
  return truncateBytes(lines.join("\n"), CONTROL_MCP_VOICE_TEXT_MAX_BYTES);
}

export function envelopeToolResult(
  envelope: ControlMcpEnvelope,
  profile: ControlMcpProfile,
  parts: SpokenParts = {},
  structured: Record<string, unknown> = envelope as unknown as Record<string, unknown>,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: profile === "voice" ? voiceText(envelope, parts) : JSON.stringify(structured),
      },
    ],
    structuredContent: structured,
    ...(envelope.ok ? {} : { isError: true }),
  };
}

/** A voice-sized list: the first `limit` items, how many more, and where to continue. */
export function voiceList<T>(items: readonly T[], limit = 5): { items: T[]; more: number } {
  return { items: items.slice(0, limit), more: Math.max(0, items.length - limit) };
}
