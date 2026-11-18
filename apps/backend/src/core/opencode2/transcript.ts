/**
 * OpenCode 2.x history rows (`Session.Message.Info`) as the shared normalized
 * transcript rows (to-do 0008, retired (`git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`), build plan
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
 *   A `synthetic` row that reports a finished background shell (a
 *   `background: true` command, or since 2.3.1 one whose timeout expired)
 *   shows the command and the output it emitted (`backgroundShellNotice`).
 * - A `synthetic` row that reports a background sub-agent (`<subagent …>`,
 *   `metadata.source: "subagent"`) is folded onto the `subagent` call that
 *   launched it, as the Claude bridge folds a `<task-notification>` onto its
 *   launch: the report's body becomes the card's output and its state the
 *   card's `agentState`, and the row itself shows nothing. A report whose
 *   launch is not among the rows read shows as a status row of its own
 *   ({@link applyOpenCode2SubagentReports}).
 * - `location-switched` → dropped (no user-facing content).
 *
 * A kind the table does not name (a newer server) is dropped and reported
 * through `onUnknown`, never guessed at, so a newer row degrades instead of
 * throwing. Rows are grouped per 2.x row because history pages by whole rows.
 */
import { providerInlineErrorMessageId } from "@orkestrator/protocol/native-agent";
import { asRecord, nonEmptyString } from "../agent-provider-runtime.js";
import {
  OPENCODE2_TOOL_VALUE_LIMIT,
  openCode2BackgroundSubagentLaunch,
  openCode2ToolPart,
} from "./transcript-tools.js";
import type { OpenCode2Message } from "./types.js";

const UNKNOWN_CREATED_AT = "1970-01-01T00:00:00.000Z";
const MAX_PARTS = 2_048;
/** Longest status text (a synthetic notice, a compaction summary) kept inline. */
const MAX_NOTICE_CHARS = 16_384;
/** Text shown for a stopped run, as the Claude bridge shows it. */
export const OPENCODE2_INTERRUPTED_TEXT = "Interrupted by user";
/** Bound on a sub-agent report shown as a row of its own, as the Claude bridge bounds one. */
const MAX_SUBAGENT_NOTICE_CHARS = 4_000;
/**
 * How long after its call returned a background sub-agent with no report
 * reads Active although its child is not (yet) listed as running: the child
 * is admitted before it starts draining (2.3.0 `subagent.ts`).
 */
export const OPENCODE2_SUBAGENT_START_GRACE_MS = 15_000;
/** What OpenCode appends to a report whose child still has background work (2.3.0). */
const SUBAGENT_STILL_RUNNING = "\n\nBackground work still running:\n";

/**
 * What a read knows beyond its rows. `liveSessions` (the server's running
 * sessions) is given only to a read that ends at the session's newest row:
 * there, a background sub-agent with no report yet reads Active while its
 * child runs (or within {@link OPENCODE2_SUBAGENT_START_GRACE_MS} of its
 * launch) and Ended once it does not, as after a server restart that did not
 * resume it. Without it (an older page), such a launch reads Ended: its
 * report, if any, lies in newer rows.
 */
export interface OpenCode2TranscriptContext {
  /** `unknown`: the read is at the head but the running sessions could not be read; Active. */
  liveSessions?: ReadonlySet<string> | "unknown";
  now?: number;
}

/** Whether any row is a background sub-agent launch, so a head read needs the running sessions. */
export function openCode2HasBackgroundSubagents(messages: readonly OpenCode2Message[]): boolean {
  return messages.some((message) => {
    const row = asRecord(message);
    return (
      row?.type === "assistant" &&
      Array.isArray(row.content) &&
      row.content.some((entry) => openCode2BackgroundSubagentLaunch(entry) !== undefined)
    );
  });
}

/**
 * The context of a read that ends at the session's newest row: the running
 * sessions, read only when a row needs them, `unknown` when that read failed.
 */
export async function openCode2HeadContext(
  messages: readonly OpenCode2Message[],
  liveSessions: (() => Promise<ReadonlySet<string>>) | undefined,
): Promise<OpenCode2TranscriptContext> {
  if (!liveSessions || !openCode2HasBackgroundSubagents(messages)) return {};
  return { liveSessions: await liveSessions().catch(() => "unknown" as const) };
}

/** A sub-agent's report to its parent (2.3.0 `subagent-completion.ts`). */
interface OpenCode2SubagentReport {
  childId: string;
  /** `completed`, `error` or `cancelled` (a job status). */
  state: string;
  body: string;
  description?: string;
}

/** The report a `synthetic` row carries, or undefined for any other row. */
export function openCode2SubagentReport(message: unknown): OpenCode2SubagentReport | undefined {
  const row = asRecord(message);
  if (row?.type !== "synthetic") return undefined;
  const meta = asRecord(row.metadata);
  const childId = nonEmptyString(meta?.childID);
  if (meta?.source !== "subagent" || !childId) return undefined;
  const text = typeof row.text === "string" ? row.text : "";
  // Attributes are quoted; the body sits between the tag's lines.
  const wrapped = /^\s*<subagent\b(?:[^>"]|"[^"]*")*>\r?\n?([\s\S]*?)\r?\n?<\/subagent>\s*$/.exec(
    text,
  );
  const description = nonEmptyString(row.description);
  return {
    childId,
    state: nonEmptyString(meta.state) ?? "completed",
    body: (wrapped ? (wrapped[1] ?? "") : text).trim(),
    ...(description ? { description } : {}),
  };
}

function subagentReportState(report: OpenCode2SubagentReport): "active" | "finished" | "failed" {
  if (report.state === "error" || report.state === "cancelled") return "failed";
  // A child that went idle with its own background work still running reports
  // again when that work ends.
  return report.body.includes(SUBAGENT_STILL_RUNNING.trim()) ? "active" : "finished";
}

/** The status row for a report with no launch among the rows read. */
function subagentReportRow(id: string, createdAt: string, report: OpenCode2SubagentReport) {
  const verb =
    report.state === "error" ? "failed" : report.state === "cancelled" ? "stopped" : "reported";
  const heading = `Sub-agent ${verb}${report.description ? `: ${report.description}` : ""}`;
  const text = report.body ? `${heading}\n${report.body}` : heading;
  return statusRow(
    id,
    createdAt,
    clip(text, MAX_SUBAGENT_NOTICE_CHARS),
    report.state === "error" ? "error" : "info",
  );
}

export type OpenCode2RowFate = "rendered" | "status" | "dropped";

/** Every 2.x row kind (`Session.Message.Info`, unchanged 2.2.6 to 2.3.1) and what the transcript does with it. */
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

/**
 * Whether a `synthetic` row is a background shell's report to its session: a
 * command run with `background: true`, or (since 2.3.1, in every build) a
 * foreground command still running when its timeout expired, which moved to
 * the background instead of being killed. 2.3.1 `shell/result.ts`
 * `notification` writes `metadata: { source: "shell", shellID, jobID, state }`
 * and admits the row to the session's inbox, waking it into a run Orkestrator
 * never prompted. A command the user ran themselves is reported with the same
 * `source` but no `jobID`, and wakes nothing, so it is not one.
 */
export function openCode2BackgroundShellReport(message: unknown): boolean {
  return openCode2ShellReportMetadata(message) !== undefined;
}

export function openCode2ShellReportMetadata(
  message: unknown,
): Record<string, unknown> | undefined {
  const row = asRecord(message);
  const meta = asRecord(row?.metadata);
  return row?.type === "synthetic" && meta?.source === "shell" && nonEmptyString(meta.jobID)
    ? meta
    : undefined;
}

/**
 * Whether a row reports background work to the session it wakes: a
 * sub-agent's report (2.3.0) or a background shell's (2.3.1). The run such a
 * report wakes continues the request whose run launched the work.
 */
export function openCode2BackgroundReport(message: unknown): boolean {
  return openCode2SubagentReport(message) !== undefined || openCode2BackgroundShellReport(message);
}

/** The whole report body of a background command that was removed while it ran (2.3.1). */
const OPENCODE2_REMOVED_SHELL_ERROR = "Shell.NotFoundError";

/**
 * The output inside a `<shell …>` report. OpenCode writes the command into
 * the tag without escaping it (2.3.1 `shell/result.ts`), so a command with an
 * unbalanced quote or a newline, common in a long test run that timed out, is
 * found by its known text (the row's description) before the tag is parsed.
 */
function shellReportBody(text: string, command: string | undefined): string | undefined {
  const close = /<\/shell>\s*$/.exec(text);
  if (!/^\s*<shell\b/.test(text) || !close) return undefined;
  let start: number | undefined;
  if (command) {
    const marker = ` command="${command}">`;
    const at = text.indexOf(marker);
    if (at >= 0 && at + marker.length <= close.index) start = at + marker.length;
  }
  if (start === undefined) {
    // Attributes are quoted, and a quoted command may itself contain `>`.
    const tag = /^\s*<shell\b(?:[^>"]|"[^"]*")*>/.exec(text);
    if (!tag || tag[0].length > close.index) return undefined;
    start = tag[0].length;
  }
  return text.slice(start, close.index).replace(/^\r?\n/, "");
}

/**
 * A finished background shell, as 2.x reports it: a `synthetic` row whose
 * metadata names `source: "shell"`, whose description is the command line
 * and whose text wraps the command's output in a `<shell …>` element (2.2.6,
 * unchanged in 2.3.1). The output is what the command emitted, so the row
 * shows it under the command rather than the command alone; null when the
 * row is not one.
 */
function backgroundShellNotice(
  metadata: unknown,
  description: string | null | undefined,
  text: string,
): string | null {
  const meta = asRecord(metadata);
  if (meta?.source !== "shell") return null;
  const body = shellReportBody(text, description ?? undefined);
  if (body === undefined) return null;
  // A command terminated through `DELETE /api/shell/{id}` (a stop) fails its
  // job, and 2.3.1 reports the failure by its error tag alone.
  if (meta.state === "error" && body.trim() === OPENCODE2_REMOVED_SHELL_ERROR) {
    return `Background command stopped${description ? `: ${description}` : ""}`;
  }
  const state = nonEmptyString(meta.state) ?? "finished";
  const exit = typeof meta.exit === "number" && meta.exit !== 0 ? ` (exit ${meta.exit})` : "";
  const heading = `Background command ${state}${exit}${description ? `: ${description}` : ""}`;
  const output = body.replace(/\s+$/, "");
  const truncated = meta.truncated === true ? "\n(output truncated)" : "";
  return output ? `${heading}\n${output}${truncated}` : heading;
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
      const report = openCode2SubagentReport(row);
      if (report) return [subagentReportRow(id, createdAt, report)];
      const description = nonEmptyString(row.description);
      const text = typeof row.text === "string" ? row.text : "";
      const shell = backgroundShellNotice(row.metadata, description, text);
      if (shell) return [statusRow(id, createdAt, shell)];
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
  context: OpenCode2TranscriptContext = {},
): Record<string, unknown>[][] {
  let lastResponseError: string | undefined;
  const groups = messages.map((message) => {
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
  return applyOpenCode2SubagentReports(messages, groups, context);
}

/**
 * Fold each background sub-agent's reports onto the `subagent` calls that
 * launched it, within one read (`messages` oldest first, `groups` their rows).
 *
 * A report answers every launch of its child since the previous report: a
 * follow-up to a running child joins its run, so one report settles both
 * calls. A report with no launch since then is a later round of the same
 * child (it went idle again after its own background work) and replaces the
 * previous report on those launches. The newest report wins: its body is the
 * card's output (an error report its error) and its state the card's
 * `agentState`; the report row then shows nothing. A report whose child has no
 * launch among the rows read keeps its own status row.
 *
 * A launch with no report reads by {@link OpenCode2TranscriptContext}.
 */
export function applyOpenCode2SubagentReports(
  messages: readonly OpenCode2Message[],
  groups: Record<string, unknown>[][],
  context: OpenCode2TranscriptContext = {},
): Record<string, unknown>[][] {
  type Launch = { group: number; callId: string; childId: string; launchedAt?: number };
  const pending = new Map<string, Launch[]>();
  const previous = new Map<string, Launch[]>();
  const answered = new Map<Launch, OpenCode2SubagentReport>();
  const folded = new Set<number>();
  const launches: Launch[] = [];
  messages.forEach((message, index) => {
    const row = asRecord(message);
    if (row?.type === "assistant" && Array.isArray(row.content)) {
      for (const entry of row.content.slice(0, MAX_PARTS)) {
        const launch = openCode2BackgroundSubagentLaunch(entry);
        if (!launch) continue;
        const record: Launch = { group: index, ...launch };
        launches.push(record);
        pending.set(launch.childId, [...(pending.get(launch.childId) ?? []), record]);
      }
      return;
    }
    const report = openCode2SubagentReport(message);
    if (!report) return;
    const since = pending.get(report.childId) ?? [];
    const targets = since.length > 0 ? since : (previous.get(report.childId) ?? []);
    pending.delete(report.childId);
    if (targets.length === 0) return;
    previous.set(report.childId, targets);
    for (const launch of targets) answered.set(launch, report);
    folded.add(index);
  });
  if (launches.length === 0) return groups;
  const now = context.now ?? Date.now();
  const next = groups.map((group) => group);
  for (const launch of launches) {
    const report = answered.get(launch);
    const live = context.liveSessions;
    const agentState = report
      ? subagentReportState(report)
      : live === "unknown" ||
          (live !== undefined &&
            (live.has(launch.childId) ||
              (launch.launchedAt !== undefined &&
                now - launch.launchedAt < OPENCODE2_SUBAGENT_START_GRACE_MS)))
        ? "active"
        : "ended";
    next[launch.group] = (next[launch.group] ?? []).map((row) => {
      if (!Array.isArray(row.parts)) return row;
      let changed = false;
      const parts = row.parts.map((candidate) => {
        const part = asRecord(candidate);
        if (part?.type !== "subagent" || part.toolUseId !== launch.callId) return candidate;
        // A retained folded result is authoritative when its report has
        // already left the head window. A new report still replaces it.
        if (!report && (part.agentState === "finished" || part.agentState === "failed"))
          return candidate;
        changed = true;
        const settled: Record<string, unknown> = { ...part, agentState };
        if (report && report.state !== "error" && report.state !== "cancelled") {
          if (report.body) settled.toolOutput = clip(report.body, OPENCODE2_TOOL_VALUE_LIMIT);
        } else if (report) {
          settled.toolError = clip(
            report.body ||
              (report.state === "cancelled" ? "Subagent cancelled" : "Subagent failed"),
            OPENCODE2_TOOL_VALUE_LIMIT,
          );
        }
        return settled;
      });
      return changed ? { ...row, parts } : row;
    });
  }
  for (const index of folded) next[index] = [];
  return next;
}

/** Oldest first in, oldest first out; rows the tab does not show are dropped. */
export function normalizeOpenCode2Transcript(
  messages: readonly OpenCode2Message[],
  onUnknown?: (type: string) => void,
  context?: OpenCode2TranscriptContext,
): Record<string, unknown>[] {
  return normalizeOpenCode2Groups(messages, onUnknown, context).flat();
}
