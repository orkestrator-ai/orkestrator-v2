/**
 * Recording and scoring for Control MCP voice qualification.
 *
 * A recording is one JSON line per `tools/list` or `tools/call` a voice
 * runtime made, written by `voice-mcp-relay.ts` (a real runtime) or by
 * `voice-qualify.ts` (the scripted run). It keeps only what scoring needs:
 * the tool, its latency and outcome, the IDs it targeted and the IDs its
 * result returned. Prompts, answers, result text and the token are never
 * written.
 *
 * Scoring assumes the qualification script: one disposable environment, one
 * session started in it, nothing else addressed. A targeted ID the server
 * never returned (and the run was not given) is a session-handle copy error;
 * an ID it did return, but not the one the script is about, is a misresolved
 * target.
 */

import {
  decodePublicSessionId,
  encodePublicSessionId,
} from "@orkestrator/protocol/public-api-resources";

export interface ToolCall {
  tool: string;
  ms: number;
  textBytes: number;
  ok: boolean;
  code?: string;
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function summarize(calls: readonly ToolCall[]) {
  const byTool = new Map<string, ToolCall[]>();
  for (const call of calls) byTool.set(call.tool, [...(byTool.get(call.tool) ?? []), call]);
  return Object.fromEntries(
    [...byTool.entries()].map(([tool, entries]) => {
      const times = entries.map((entry) => entry.ms);
      return [
        tool,
        {
          calls: entries.length,
          p50Ms: percentile(times, 0.5),
          p95Ms: percentile(times, 0.95),
          maxTextBytes: Math.max(...entries.map((entry) => entry.textBytes)),
          failures: entries.filter((entry) => !entry.ok).map((entry) => entry.code ?? "error"),
        },
      ];
    }),
  );
}

/** The JSON-RPC message in a Control MCP response, plain JSON or one SSE event. */
export function payloadOf(text: string, contentType: string | null): unknown {
  const payload = contentType?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  return JSON.parse(payload ?? "{}");
}

export interface Envelope extends Record<string, unknown> {
  ok?: boolean;
  error?: { code?: string; details?: Record<string, unknown> };
}

/**
 * The outcome of one `tools/call` response: the speakable text and the public
 * envelope, or a failed envelope naming what went wrong (a JSON-RPC error, an
 * MCP tool error, or a result that is not a public envelope).
 */
export function classifyToolResult(body: unknown): {
  text: string;
  structured: Envelope;
  ok: boolean;
  code?: string;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  const payload = body as { error?: { code?: number | string } };
  const result = (
    body as {
      result?: {
        isError?: boolean;
        content?: Array<{ text?: string }>;
        structuredContent?: Envelope;
      };
    }
  ).result;
  const text = Array.isArray(result?.content)
    ? result.content.map((entry) => (typeof entry?.text === "string" ? entry.text : "")).join("\n")
    : "";
  const rawEnvelope = result?.structuredContent;
  const envelope =
    rawEnvelope && typeof rawEnvelope === "object" && !Array.isArray(rawEnvelope)
      ? rawEnvelope
      : undefined;
  const valid =
    !payload.error &&
    result?.isError !== true &&
    envelope?.ok === true &&
    envelope.schemaVersion === 1 &&
    typeof envelope.action === "string" &&
    "result" in envelope;
  const code = payload.error
    ? `json-rpc:${payload.error.code ?? "error"}`
    : result?.isError
      ? (envelope?.error?.code ?? "mcp-tool-error")
      : (envelope?.error?.code ?? "invalid-envelope");
  const structured: Envelope = valid
    ? envelope!
    : { ok: false, error: { ...envelope?.error, code } };
  return {
    text,
    structured,
    ok: valid,
    ...(structured.error?.code ? { code: structured.error.code } : {}),
  };
}

export type TargetKind = "project" | "environment" | "session" | "operation" | "interaction";

export interface RecordedCall {
  type: "call";
  at: string;
  tool: string;
  /** The public action, for `run_action` and `describe_action`. */
  action?: string;
  ms: number;
  ok: boolean;
  code?: string;
  textBytes: number;
  targets: Partial<Record<TargetKind, string>>;
  resultIds: string[];
}

export interface RecordedToolList {
  type: "tools/list";
  at: string;
  tools: number;
  bytes: number;
}

export type RecordingEntry = RecordedCall | RecordedToolList;

const MAX_ID_LENGTH = 700;
const MAX_RESULT_IDS = 200;
// These containers hold public resource metadata. Never descend into transcript,
// question, schema/example, file, or other arbitrary content objects.
const RESOURCE_CONTAINERS = new Set([
  "receipt",
  "resources",
  "result",
  "items",
  "target",
  "candidates",
  "ids",
  "execution",
  "interactions",
  "attention",
  "running",
  "projects",
  "environments",
  "sessions",
]);
const INVALID_SESSION = "invalid-session-identity";
const ID_KEYS = new Set([
  "id",
  "projectId",
  "environmentId",
  "sessionId",
  "operationId",
  "interactionId",
]);

function idValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_ID_LENGTH) : undefined;
}

/** The IDs a call addressed. `run_action` targets come from its `input`. */
export function targetsOf(args: Record<string, unknown>): Partial<Record<TargetKind, string>> {
  const nested =
    args.input && typeof args.input === "object" && !Array.isArray(args.input)
      ? (args.input as Record<string, unknown>)
      : undefined;
  const source = nested ?? args;
  const targets: Partial<Record<TargetKind, string>> = {};
  const project = idValue(source.projectId);
  const environment = idValue(source.environmentId);
  const tab = source.tabId;
  let session = idValue(source.sessionId);
  if (!session && source.environmentId !== undefined && tab !== undefined) {
    try {
      if (typeof source.environmentId !== "string" || typeof tab !== "string") throw new Error();
      session = encodePublicSessionId(source.environmentId, tab);
    } catch {
      // Keep the attempted session target without persisting malformed text.
      session = INVALID_SESSION;
    }
  }
  const operation = idValue(source.operationId) ?? idValue(source.expectedOperationId);
  const interaction = idValue(source.interactionId);
  if (project) targets.project = project;
  if (environment) targets.environment = environment;
  if (session) targets.session = session;
  if (operation) targets.operation = operation;
  if (interaction) targets.interaction = interaction;
  return targets;
}

/** Resource IDs in allowlisted result fields (bounded), excluding free text. */
export function idsInResult(structured: unknown): string[] {
  const found = new Set<string>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: structured, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && found.size < MAX_RESULT_IDS && visited < 10_000) {
    const { value, depth } = stack.pop()!;
    visited += 1;
    if (!value || typeof value !== "object" || depth > 8) continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const id =
        ID_KEYS.has(key) &&
        typeof child === "string" &&
        (child.startsWith("ses_")
          ? decodePublicSessionId(child) !== null
          : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(child))
          ? child
          : undefined;
      if (id) found.add(id);
      else if (
        (Array.isArray(value) || RESOURCE_CONTAINERS.has(key)) &&
        child &&
        typeof child === "object"
      ) {
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return [...found].slice(0, MAX_RESULT_IDS);
}

/** One recording line for a `tools/call`, from its arguments and JSON-RPC response. */
export function recordCall(
  tool: string,
  args: Record<string, unknown>,
  body: unknown,
  ms: number,
  at = new Date(),
): { entry: RecordedCall; text: string; structured: Envelope } {
  const { text, structured, ok, code } = classifyToolResult(body);
  const action =
    (tool === "run_action" || tool === "describe_action") && typeof args.action === "string"
      ? args.action
      : undefined;
  return {
    text,
    structured,
    entry: {
      type: "call",
      at: at.toISOString(),
      tool,
      ...(action ? { action } : {}),
      ms,
      ok,
      ...(code ? { code } : {}),
      textBytes: Buffer.byteLength(text),
      targets: targetsOf(args),
      resultIds: idsInResult(structured),
    },
  };
}

/** Content-free transport failure for a recognized call attempt. */
export function recordFailure(
  tool: string,
  args: Record<string, unknown>,
  code: string,
  ms: number,
): RecordedCall {
  return { ...recordCall(tool, args, {}, ms).entry, code };
}

export function parseRecording(text: string): RecordingEntry[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordingEntry)
    .filter((entry) => entry.type === "call" || entry.type === "tools/list");
}

export interface ScoredCall {
  index: number;
  tool: string;
  action?: string;
  kinds: TargetKind[];
}

export interface RecordingScore {
  /** Each session `start_work` returned in the environment, in order; the last is current. */
  sessionIds: string[];
  targetedCalls: number;
  misresolvedTargets: ScoredCall[];
  handleCopyErrors: ScoredCall[];
  misresolvedRate: number | null;
  copyErrorRate: number | null;
}

/**
 * Misresolved targets and handle copy errors in a recording of the script.
 *
 * Each targeted call is judged once per kind: an ID that is not a valid
 * handle, or that nothing before it returned, is a copy error; a returned ID
 * that differs from the script's environment, project or session is a
 * misresolution. The expected session is the latest one `start_work` started
 * in the environment, so one recording can hold several repeats of the
 * script. Operation and interaction IDs have no single expected value, so
 * they are checked for copy errors only.
 */
export function scoreRecording(
  entries: readonly RecordingEntry[],
  expected: { environmentId: string; projectId?: string },
): RecordingScore {
  const seen = new Set<string>([
    expected.environmentId,
    ...(expected.projectId ? [expected.projectId] : []),
  ]);
  const sessionIds: string[] = [];
  let targetedCalls = 0;
  const misresolvedTargets: ScoredCall[] = [];
  const handleCopyErrors: ScoredCall[] = [];
  entries.forEach((entry, index) => {
    if (entry.type !== "call") return;
    const kinds = Object.entries(entry.targets) as Array<[TargetKind, string]>;
    if (kinds.length > 0) targetedCalls += 1;
    const copied: TargetKind[] = [];
    const misresolved: TargetKind[] = [];
    for (const [kind, value] of kinds) {
      if ((kind === "session" && !decodePublicSessionId(value)) || !seen.has(value)) {
        copied.push(kind);
        continue;
      }
      const want =
        kind === "environment"
          ? expected.environmentId
          : kind === "project"
            ? expected.projectId
            : kind === "session"
              ? (sessionIds.at(-1) ?? null)
              : undefined;
      if (want !== undefined && value !== want) misresolved.push(kind);
    }
    const scored = {
      index,
      tool: entry.tool,
      ...(entry.action ? { action: entry.action } : {}),
    };
    if (copied.length > 0) handleCopyErrors.push({ ...scored, kinds: copied });
    if (misresolved.length > 0) misresolvedTargets.push({ ...scored, kinds: misresolved });
    for (const id of entry.resultIds) seen.add(id);
    const started =
      entry.tool === "start_work" && entry.ok
        ? entry.resultIds.find(
            (id) => decodePublicSessionId(id)?.environmentId === expected.environmentId,
          )
        : undefined;
    if (started && started !== sessionIds.at(-1)) sessionIds.push(started);
  });
  const rate = (count: number) => (targetedCalls > 0 ? count / targetedCalls : null);
  return {
    sessionIds,
    targetedCalls,
    misresolvedTargets,
    handleCopyErrors,
    misresolvedRate: rate(misresolvedTargets.length),
    copyErrorRate: rate(handleCopyErrors.length),
  };
}

const READ_TOOLS = ["overview", "read_session", "run_status", "resolve_target", "find_actions"];

/** The qualification report for a recording: latency, sizes and the two model-dependent counts. */
export function recordingReport(
  entries: readonly RecordingEntry[],
  expected: { environmentId: string; projectId?: string },
) {
  const calls = entries.filter((entry): entry is RecordedCall => entry.type === "call");
  const lists = entries.filter((entry): entry is RecordedToolList => entry.type === "tools/list");
  const reads = calls.filter((call) => READ_TOOLS.includes(call.tool)).map((call) => call.ms);
  const readsP95Ms = percentile(reads, 0.95);
  const maxTextBytes = Math.max(0, ...calls.map((call) => call.textBytes));
  const listBytes = lists.at(-1)?.bytes ?? null;
  return {
    tools: lists.at(-1)
      ? {
          count: lists.at(-1)!.tools,
          bytes: listBytes,
          approxTokens: Math.ceil(listBytes! / 4),
        }
      : null,
    calls: calls.length,
    latency: {
      readsP50Ms: percentile(reads, 0.5),
      readsP95Ms,
      readsP95UnderOneSecond: readsP95Ms === null ? null : readsP95Ms < 1_000,
      byTool: summarize(calls),
    },
    resultText: {
      maxBytes: maxTextBytes,
      approxMaxTokens: Math.ceil(maxTextBytes / 4),
    },
    score: scoreRecording(entries, expected),
  };
}
