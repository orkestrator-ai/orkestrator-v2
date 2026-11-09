/**
 * OpenCode 2.x history rows (`Session.Message.Info`) as the shared normalized
 * transcript rows (docs/todo/agent-engines/0008-opencode-v2.md, build plan
 * phase 4).
 *
 * A 2.x assistant row is one model response (one step of the agent loop), so
 * it maps to exactly one transcript row (AGENTS.md invariant 14); a long turn
 * is many rows, never one growing row. Every 2.x row kind has a declared fate
 * in {@link OPENCODE2_ROW_FATES}:
 *
 * - `user` → the user's bubble (text and attachments).
 * - `assistant` → text, reasoning, tool, edit and sub-agent parts
 *   (`transcript-tools.ts`), a `retry` part while a retry is scheduled, and an
 *   inline error row after it when the response itself failed.
 * - `compaction` → a compaction part (its summary, or why it failed).
 * - `shell` → the user's own shell command as a tool card with its output.
 * - `idle` → nothing when the run succeeded, the run's error as an inline
 *   error row when it failed, and an "Interrupted by user" status row when it
 *   was stopped, so a failed or stopped run reads honestly after a reload.
 * - `synthetic`, `system`, `skill`, `agent-switched`, `model-switched` →
 *   compact status rows. A `system` row is OpenCode reloading its
 *   instructions; only its description is shown, never the instruction text.
 * - `location-switched` → dropped (no user-facing content).
 *
 * A kind the table does not name (a newer server) is dropped and reported
 * through `onUnknown`, never guessed at, so a newer row degrades instead of
 * throwing. Rows are grouped per 2.x row because history pages by whole rows.
 */
import { providerInlineErrorMessageId } from "@orkestrator/protocol/native-agent";
import { asRecord, nonEmptyString } from "../agent-provider-runtime.js";
import { OPENCODE2_TOOL_VALUE_LIMIT, openCode2ToolPart } from "./transcript-tools.js";
import type { OpenCode2Message } from "./types.js";

const UNKNOWN_CREATED_AT = "1970-01-01T00:00:00.000Z";
const MAX_PARTS = 2_048;
/** Longest status text (a synthetic notice, a compaction summary) kept inline. */
const MAX_NOTICE_CHARS = 16_384;
/** Text shown for a stopped run, as the Claude bridge shows it. */
export const OPENCODE2_INTERRUPTED_TEXT = "Interrupted by user";

export type OpenCode2RowFate = "rendered" | "status" | "dropped";

/** Every 2.x row kind (2.2.6 `Session.Message.Info`) and what the transcript does with it. */
export const OPENCODE2_ROW_FATES: Record<string, OpenCode2RowFate> = {
  user: "rendered",
  assistant: "rendered",
  compaction: "rendered",
  shell: "rendered",
  idle: "rendered",
  synthetic: "status",
  system: "status",
  skill: "status",
  "agent-switched": "status",
  "model-switched": "status",
  "location-switched": "dropped",
};

function isoTime(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function clip(value: string, limit = MAX_NOTICE_CHARS): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function modelRef(value: unknown): { modelId?: string; reasoningId?: string } {
  const model = asRecord(value);
  const provider = nonEmptyString(model?.providerID);
  const id = nonEmptyString(model?.id);
  const variant = nonEmptyString(model?.variant);
  return {
    ...(provider && id ? { modelId: `${provider}/${id}` } : {}),
    ...(variant ? { reasoningId: variant } : {}),
  };
}

function statusRow(
  id: string,
  createdAt: string,
  content: string,
  severity: "info" | "warning" | "error" = "info",
): Record<string, unknown> {
  const text = clip(content);
  return {
    id,
    role: "system",
    content: text,
    parts: [{ type: "status", content: text, severity, createdAt }],
    createdAt,
  };
}

function errorText(value: unknown, fallback: string): string {
  const error = asRecord(value);
  return clip(nonEmptyString(error?.message) ?? nonEmptyString(error?.type) ?? fallback, 4_096);
}

/** An inline error row (`error-opencode-<id>`): rendered as an alert, not a reply. */
function inlineErrorRow(
  rowId: string,
  createdAt: string,
  message: string,
  model?: string,
): Record<string, unknown> {
  return {
    id: providerInlineErrorMessageId("opencode", rowId),
    role: "assistant",
    content: message,
    parts: [{ type: "text", content: message }],
    createdAt,
    ...(model ? { modelId: model } : {}),
  };
}

function userRow(row: Record<string, unknown>, id: string, createdAt: string) {
  const text = typeof row.text === "string" ? row.text : "";
  const parts: Record<string, unknown>[] = text ? [{ type: "text", content: text }] : [];
  for (const entry of Array.isArray(row.files) ? row.files.slice(0, 64) : []) {
    const file = asRecord(entry);
    const uri = nonEmptyString(file?.uri);
    const name = nonEmptyString(file?.name) ?? uri ?? "Attached file";
    const mime = nonEmptyString(file?.mime);
    const image = mime?.startsWith("image/") === true;
    parts.push({
      type: image ? "image" : "file",
      content: name,
      ...(image ? { imageSource: "attachment" } : {}),
      ...(mime ? { mime } : {}),
      ...(uri ? { fileUrl: uri } : {}),
    });
  }
  return { id, role: "user", content: text, parts, createdAt };
}

function assistantRows(row: Record<string, unknown>, id: string, createdAt: string) {
  const content = Array.isArray(row.content) ? row.content : [];
  const parts: Record<string, unknown>[] = [];
  let text = "";
  for (const entry of content.slice(0, MAX_PARTS)) {
    const part = asRecord(entry);
    if (part?.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", content: part.text });
      text += part.text;
    } else if (part?.type === "reasoning" && typeof part.text === "string") {
      if (part.text.trim()) parts.push({ type: "thinking", content: part.text });
    } else if (part?.type === "tool") {
      const tool = openCode2ToolPart(part);
      if (tool) parts.push(tool);
    }
  }
  const retry = asRecord(row.retry);
  if (retry) {
    parts.push({
      type: "retry",
      content: errorText(retry.error, "The model request failed"),
      // A response that later completed carries no `retry`, so one present
      // here is still waiting to be retried.
      toolState: "pending",
      ...(typeof retry.attempt === "number" ? { retryAttempt: retry.attempt } : {}),
    });
  }
  const model = modelRef(row.model);
  const rows: Record<string, unknown>[] = [
    {
      id,
      role: "assistant",
      content: text,
      parts,
      createdAt,
      ...model,
    },
  ];
  if (row.error !== undefined && row.error !== null) {
    const completed = isoTime(asRecord(row.time)?.completed) ?? createdAt;
    rows.push(
      inlineErrorRow(
        id,
        completed,
        `Model request failed: ${errorText(row.error, "OpenCode reported an error")}`,
        model.modelId,
      ),
    );
  }
  return rows;
}

function shellRow(row: Record<string, unknown>, id: string, createdAt: string) {
  const command = typeof row.command === "string" ? row.command : "";
  const output = asRecord(row.output);
  const body = typeof output?.output === "string" ? output.output : undefined;
  const status = row.status;
  const exit = typeof row.exit === "number" ? row.exit : undefined;
  const failed = status === "timeout" || status === "killed" || (exit !== undefined && exit !== 0);
  const started = asRecord(row.time)?.created;
  const ended = asRecord(row.time)?.completed;
  return {
    id,
    role: "assistant",
    content: "",
    parts: [
      {
        type: "tool-invocation",
        content: "shell",
        toolName: "shell",
        toolUseId: id,
        toolArgs: { command: clip(command, 64 * 1024) },
        toolState: status === "running" ? "pending" : failed ? "failure" : "success",
        ...(body === undefined
          ? {}
          : {
              toolOutput:
                body.length > OPENCODE2_TOOL_VALUE_LIMIT
                  ? `${body.slice(0, OPENCODE2_TOOL_VALUE_LIMIT)}\n… (output cut)`
                  : body,
            }),
        ...(failed
          ? {
              toolError:
                status === "timeout"
                  ? "Timed out"
                  : status === "killed"
                    ? "Killed"
                    : `Exit ${exit}`,
            }
          : {}),
        ...(typeof started === "number" && typeof ended === "number" && ended >= started
          ? { toolDurationMs: Math.round(ended - started) }
          : {}),
      },
    ],
    createdAt,
  };
}

function compactionRow(row: Record<string, unknown>, id: string, createdAt: string) {
  if (row.status === "failed") {
    return statusRow(
      id,
      createdAt,
      `Compaction failed: ${errorText(row.error, "unknown error")}`,
      "error",
    );
  }
  const summary = typeof row.summary === "string" ? clip(row.summary) : "";
  return {
    id,
    role: "assistant",
    content: "",
    parts: [
      {
        type: "compaction",
        content: summary,
        ...(row.status === "running" ? { toolState: "pending" } : {}),
      },
    ],
    createdAt,
    ...modelRef(row.model),
  };
}

/**
 * The rows of one 2.x history row: usually one, two for a failed response
 * (the response and its error), none for a row the transcript does not show.
 */
export function normalizeOpenCode2Group(
  message: OpenCode2Message,
  onUnknown?: (type: string) => void,
): Record<string, unknown>[] {
  const row = asRecord(message);
  const id = nonEmptyString(row?.id);
  const type = typeof row?.type === "string" ? row.type : undefined;
  if (!row || !id || !type) return [];
  const createdAt = isoTime(asRecord(row.time)?.created) ?? UNKNOWN_CREATED_AT;
  switch (type) {
    case "user":
      return typeof row.text === "string" ? [userRow(row, id, createdAt)] : [];
    case "assistant":
      return Array.isArray(row.content) ? assistantRows(row, id, createdAt) : [];
    case "shell":
      return [shellRow(row, id, createdAt)];
    case "compaction":
      return [compactionRow(row, id, createdAt)];
    case "idle":
      if (row.outcome === "failed") {
        return [
          inlineErrorRow(
            id,
            createdAt,
            errorText(row.error, "OpenCode 2 reported that the turn failed"),
          ),
        ];
      }
      if (row.outcome === "interrupted") {
        return [statusRow(id, createdAt, OPENCODE2_INTERRUPTED_TEXT)];
      }
      return [];
    case "synthetic": {
      const description = nonEmptyString(row.description);
      const text = typeof row.text === "string" ? row.text : "";
      return [statusRow(id, createdAt, description ?? (text || "OpenCode added a note"))];
    }
    case "system":
      return [statusRow(id, createdAt, nonEmptyString(row.description) ?? "Instructions updated")];
    case "skill":
      return [statusRow(id, createdAt, `Skill loaded: ${nonEmptyString(row.name) ?? "skill"}`)];
    case "agent-switched":
      return [statusRow(id, createdAt, `Agent: ${nonEmptyString(row.agent) ?? "changed"}`)];
    case "model-switched": {
      const model = modelRef(row.model).modelId;
      return [statusRow(id, createdAt, `Model: ${model ?? "changed"}`)];
    }
    default:
      if (!(type in OPENCODE2_ROW_FATES)) onUnknown?.(type);
      return [];
  }
}

/** One 2.x row as its first transcript row, or null for a row the tab does not show. */
export function normalizeOpenCode2Message(
  message: OpenCode2Message,
): Record<string, unknown> | null {
  return normalizeOpenCode2Group(message)[0] ?? null;
}

/**
 * Rows grouped per input row, oldest first in and out. A failed run's `idle`
 * row usually repeats the error of the response that failed it; that copy is
 * dropped so one failure reads as one alert.
 */
export function normalizeOpenCode2Groups(
  messages: readonly OpenCode2Message[],
  onUnknown?: (type: string) => void,
): Record<string, unknown>[][] {
  let lastResponseError: string | undefined;
  return messages.map((message) => {
    const row = asRecord(message);
    const group = normalizeOpenCode2Group(message, onUnknown);
    if (row?.type === "assistant") {
      lastResponseError =
        row.error === undefined || row.error === null
          ? undefined
          : errorText(row.error, "OpenCode reported an error");
    } else if (row?.type === "idle") {
      const repeated =
        row.outcome === "failed" &&
        lastResponseError !== undefined &&
        errorText(row.error, "") === lastResponseError;
      lastResponseError = undefined;
      if (repeated) return [];
    }
    return group;
  });
}

/** Oldest first in, oldest first out; rows the tab does not show are dropped. */
export function normalizeOpenCode2Transcript(
  messages: readonly OpenCode2Message[],
  onUnknown?: (type: string) => void,
): Record<string, unknown>[] {
  return normalizeOpenCode2Groups(messages, onUnknown).flat();
}
