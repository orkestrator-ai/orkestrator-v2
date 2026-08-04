type ToolState = "success" | "failure" | "pending";

export interface TranscriptActionPart {
  type: "text" | "tool-invocation";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolState?: ToolState;
  toolTitle?: string;
  toolOutput?: string;
  toolError?: string;
}

export interface TranscriptSubagentPart {
  type: "subagent";
  content: string;
  subagentId?: string;
  subagentName?: string;
  subagentRole?: string;
  subagentPrompt?: string;
  subagentActions: TranscriptActionPart[];
  subagentActionCount: number;
  toolState: ToolState;
}

export interface TranscriptRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface SubAgentActivityRecord {
  callId: string;
  agentThreadId: string;
  agentPath?: string;
}

interface MergeablePart {
  type: string;
}

interface SpawnedSubagent {
  callId: string;
  agentId?: string;
  nickname?: string;
  role?: string;
  prompt?: string;
}

type SubagentOutcome = ToolState;

const COLLABORATION_MESSAGE_TOOLS = new Set([
  "followup_task",
  "send_message",
  "spawn_agent",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

// Multi-agent v2 rollouts persist inter-agent prompts as Fernet envelopes.
// Detect the binary layout instead of treating every long base64url-like task
// as encrypted: version + timestamp + IV + block ciphertext + HMAC.
function isOpaqueMessageEnvelope(text: string): boolean {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(text)) {
    return false;
  }

  const unpadded = text.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) {
    return false;
  }
  const suppliedPadding = text.slice(unpadded.length);
  const canonicalPadding = "=".repeat((4 - (unpadded.length % 4)) % 4);
  if (suppliedPadding && suppliedPadding !== canonicalPadding) {
    return false;
  }

  // The alphabet and padding checks above guarantee a canonical base64url
  // string, so Buffer.from cannot hit a recoverable decode-error branch here.
  const decoded = Buffer.from(unpadded, "base64url");
  return decoded.toString("base64url") === unpadded
    && decoded[0] === 0x80
    && decoded.length >= 73
    && (decoded.length - 57) % 16 === 0;
}

function asDisplayablePrompt(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) {
    return undefined;
  }

  return isOpaqueMessageEnvelope(text.trim()) ? undefined : text;
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Longest command preview retained. The preview travels in `toolArgs` next to
 * the full `input`, so an uncapped command would roughly double every SSE frame
 * carrying an exec call. The authoritative source stays in `input`.
 */
const MAX_EXEC_COMMAND_PREVIEW_CHARS = 200;

/** Distinct commands tracked before the preview degrades to a bare count. */
const MAX_EXEC_COMMANDS_TRACKED = 20;

/**
 * Hard bound on the scan. `itemToParts` runs on the bridge's read loop, and
 * AGENTS.md is explicit that stalling it stalls every thread's SSE.
 */
const MAX_EXEC_SCAN_CHARS = 262_144;

/**
 * Longest literal body decoded. Comfortably above the preview cap so a long
 * command still yields a full-length preview, while a megabyte of file content
 * handed to some other tool is skipped over rather than decoded.
 */
const MAX_DECODED_LITERAL_CHARS = 2048;

const SIMPLE_ESCAPES = new Map([
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["0", "\0"],
]);

function decodeJavascriptStringBody(body: string): string {
  return body.replace(
    // The trailing `[\s\S]` branch must stay last: it is the catch-all that
    // makes unrecognized escapes collapse to the escaped character, the way
    // JavaScript itself treats `\a`.
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g,
    (
      _match,
      codePoint: string | undefined,
      unicode: string | undefined,
      hex: string | undefined,
      lineContinuation: string | undefined,
      simple: string | undefined,
    ) => {
      if (codePoint) {
        const value = Number.parseInt(codePoint, 16);
        return Number.isSafeInteger(value) && value <= 0x10ffff
          ? String.fromCodePoint(value)
          : _match;
      }
      if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      // A backslash before a line terminator continues the line; it contributes
      // nothing to the string value.
      if (lineContinuation) return "";
      return simple === undefined ? _match : SIMPLE_ESCAPES.get(simple) ?? simple;
    },
  );
}

/**
 * Cuts a literal body to the decodable bound without splitting an escape: a
 * trailing run of backslashes is dropped whole so the decoder never sees a
 * dangling `\` and mistakes the closing character for an escaped one.
 */
function truncateLiteralBody(body: string): string {
  if (body.length <= MAX_DECODED_LITERAL_CHARS) return body;
  const head = body.slice(0, MAX_DECODED_LITERAL_CHARS);
  return head.replace(/\\+$/, (run) => (run.length % 2 === 0 ? run : run.slice(0, -1)));
}

/**
 * Reads one JavaScript string literal starting at `start`.
 *
 * `end` is always the position just past the literal, so callers can skip a
 * literal even when its contents are not worth decoding. `value` is omitted
 * when the literal is not a usable static string: a template carrying a `${…}`
 * substitution whose runtime value we cannot know, or a literal still open when
 * the scan window ran out.
 *
 * `null` means the literal is malformed — a raw newline inside a quoted string,
 * which JavaScript forbids — so the opening quote was not really a literal at
 * all and the caller should resume scanning just past it.
 */
function readJavascriptStringLiteral(
  source: string,
  start: number,
  limit: number,
): { value?: string; end: number } | null {
  const quote = source[start];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return null;

  let escaped = false;
  for (let index = start + 1; index < limit; index += 1) {
    const character = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    // JavaScript forbids a raw newline inside a quoted literal, so an
    // unterminated quote must not swallow the rest of the snippet and present
    // unrelated prose as the command that ran.
    if (quote !== "`" && (character === "\n" || character === "\r")) return null;
    if (character !== quote) continue;

    const end = index + 1;
    const body = source.slice(start + 1, index);
    if (quote === "`" && body.includes("${")) return { end };
    if (body.length <= MAX_DECODED_LITERAL_CHARS && quote === "\"") {
      try {
        const value = JSON.parse(source.slice(start, end));
        if (typeof value === "string") return { value, end };
      } catch {
        // JavaScript permits a few escapes JSON does not; use the bounded
        // decoder below rather than evaluating transcript content.
      }
    }
    // Decode only a prefix. A long command still yields a full-length preview
    // once capped, while a megabyte of file content bound for another tool
    // costs a fixed slice instead of a full decode.
    return { value: decodeJavascriptStringBody(truncateLiteralBody(body)), end };
  }
  // Still open when the scan window ran out. Report the window as the end so
  // the caller stops rather than resuming *inside* the literal, where a `cmd:`
  // belonging to some other tool's string argument would look like code.
  return { end: limit };
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[\w$]/.test(character);
}

function capCommandPreview(command: string): string {
  return command.length > MAX_EXEC_COMMAND_PREVIEW_CHARS
    ? `${command.slice(0, MAX_EXEC_COMMAND_PREVIEW_CHARS - 1)}…`
    : command;
}

/** Advances past whitespace and comments, returning the next code position. */
function skipTrivia(source: string, from: number, limit: number): number {
  let index = from;
  while (index < limit) {
    const character = source[index]!;
    if (character === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 || newline >= limit ? limit : newline + 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 || end + 2 > limit ? limit : end + 2;
      continue;
    }
    if (!/\s/.test(character)) return index;
    index += 1;
  }
  return limit;
}

interface ExecCommandScan {
  commands: string[];
  /** Set when more distinct commands existed than the scan retains. */
  truncated: boolean;
}

/**
 * Single forward pass over the snippet that records `cmd:` property values
 * found in *code* position.
 *
 * Skipping string literals and comments wholesale is the point: a `cmd:` that
 * lives inside another tool's string argument — say the body of a file being
 * written — never ran, and promoting it would label the row with a command the
 * user's machine never executed.
 *
 * Regex literals are not tracked, since telling `/re/` from division needs a
 * full JavaScript lexer. A `cmd:"…"` inside a regex would still be picked up;
 * that is a knowingly accepted gap, far narrower than the string and comment
 * cases this scan does close.
 */
function scanExecCommands(source: string): ExecCommandScan {
  const limit = Math.min(source.length, MAX_EXEC_SCAN_CHARS);
  const seen = new Set<string>();
  const commands: string[] = [];
  let truncated = false;
  let index = 0;

  const record = (raw: string | undefined): void => {
    const command = raw?.trim();
    if (!command || seen.has(command)) return;
    if (commands.length >= MAX_EXEC_COMMANDS_TRACKED) {
      truncated = true;
      return;
    }
    seen.add(command);
    commands.push(capCommandPreview(command));
  };

  const readValueAfterKey = (afterKey: number): number => {
    const colon = skipTrivia(source, afterKey, limit);
    if (source[colon] !== ":") return afterKey;
    const valueStart = skipTrivia(source, colon + 1, limit);
    const literal = readJavascriptStringLiteral(source, valueStart, limit);
    if (!literal) return colon + 1;
    record(literal.value);
    return literal.end;
  };

  while (index < limit) {
    index = skipTrivia(source, index, limit);
    if (index >= limit) break;
    const character = source[index]!;

    if (character === "\"" || character === "'" || character === "`") {
      const literal = readJavascriptStringLiteral(source, index, limit);
      if (!literal) {
        index += 1;
        continue;
      }
      // A quoted `cmd` is still a property key: `{"cmd": "ls"}`.
      index = literal.value === "cmd" ? readValueAfterKey(literal.end) : literal.end;
      continue;
    }

    if (
      source.startsWith("cmd", index)
      && !isIdentifierPart(source[index - 1])
      && !isIdentifierPart(source[index + 3])
    ) {
      index = readValueAfterKey(index + 3);
      continue;
    }

    index += 1;
  }

  return { commands, truncated };
}

/**
 * Pulls a useful shell-command preview out of the raw JavaScript accepted by
 * Codex's custom `exec` tool. This deliberately recognizes only static string
 * literals in `cmd` object properties and never evaluates rollout content.
 *
 * Snippets that run several commands report a count rather than promoting one:
 * the scan sees source order, not execution order, and a command inside an
 * untaken `if`/`catch` branch is indistinguishable from one that ran.
 */
export function extractExecCommandPreview(input: string): string | undefined {
  const { commands, truncated } = scanExecCommands(input);
  if (commands.length === 0) return undefined;
  if (commands.length === 1 && !truncated) return commands[0];
  return `${commands.length}${truncated ? "+" : ""} commands`;
}

export function normalizeTranscriptToolArgs(
  toolName: string,
  rawArgs: unknown,
): Record<string, unknown> | undefined {
  const parsed = typeof rawArgs === "string" ? parseJson<Record<string, unknown>>(rawArgs) : rawArgs;

  if (!isRecord(parsed)) {
    if (typeof rawArgs !== "string" || rawArgs.trim().length === 0) {
      return undefined;
    }
    const command = toolName === "exec"
      ? extractExecCommandPreview(rawArgs)
      : undefined;
    return {
      input: rawArgs,
      ...(command ? { command } : {}),
    };
  }

  let normalized = parsed;

  // Multi-agent v2 marks message-bearing collaboration parameters as
  // encrypted. Rollouts retain the Fernet envelope rather than plaintext, so
  // never expose that opaque implementation detail as thousands of characters
  // of tool input. The readable final_answer event is added as a text action by
  // parseChildTranscript below.
  if (
    COLLABORATION_MESSAGE_TOOLS.has(toolName)
    && typeof parsed.message === "string"
    && isOpaqueMessageEnvelope(parsed.message.trim())
  ) {
    normalized = { ...parsed };
    delete normalized.message;
  }

  if (toolName === "exec_command" && typeof normalized.cmd === "string") {
    return {
      ...normalized,
      command: normalized.cmd,
    };
  }

  if (toolName === "exec") {
    // Only `input` carries exec source. Falling back to the serialized args
    // would scan the whole JSON and promote an unrelated nested `cmd` key —
    // say `{"meta":{"cmd":"…"}}` — into the command label.
    const command = typeof normalized.input === "string"
      ? extractExecCommandPreview(normalized.input)
      // app-server types `arguments` as JsonValue, so a pre-parsed object with
      // a plain `cmd` reaches here without ever having been a source snippet.
      : typeof normalized.cmd === "string"
        ? capCommandPreview(normalized.cmd.trim()) || undefined
        : undefined;
    if (command) return { ...normalized, command };
  }

  return normalized;
}

function appendTextAction(
  actions: TranscriptActionPart[],
  value: unknown,
): void {
  const content = asString(value);
  if (!content) return;
  if (actions.some((action) => action.type === "text" && action.content === content)) {
    return;
  }
  actions.push({ type: "text", content });
}

function messageContentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;

  const text = value
    .filter(isRecord)
    .filter((part) => part.type === "output_text")
    .map((part) => asString(part.text))
    .filter((part): part is string => part !== undefined)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

/**
 * Cap for a single sub-agent action's serialized output. Mirrors the parent
 * items' `DEFAULT_MAX_COMMAND_OUTPUT_CHARS`: these parts are re-derived on
 * every transcript probe and retained in the thread's messages, so an
 * unbounded tool result here multiplies across renders and sub-agents.
 */
export const MAX_SUBAGENT_ACTION_OUTPUT_CHARS = 256 * 1024;
export const SUBAGENT_OUTPUT_TRUNCATION_NOTICE = "\n… output truncated";

export function capActionOutput(text: string): string {
  if (text.length <= MAX_SUBAGENT_ACTION_OUTPUT_CHARS) return text;
  return (
    text.slice(0, MAX_SUBAGENT_ACTION_OUTPUT_CHARS) + SUBAGENT_OUTPUT_TRUNCATION_NOTICE
  );
}

export function stringifyTranscriptToolOutput(value: unknown): string | undefined {
  if (typeof value === "string") {
    return capActionOutput(value);
  }

  if (value === undefined) {
    return undefined;
  }

  try {
    return capActionOutput(JSON.stringify(value, null, 2));
  } catch {
    return capActionOutput(String(value));
  }
}

function transcriptToolOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(isRecord)
    .filter((item) => item.type === "input_text")
    .map((item) => typeof item.text === "string" ? item.text : "")
    .join("\n");
}

/**
 * A custom-tool call's `status: "completed"` means the model finished emitting
 * the call, not that the tool operation succeeded. `apply_patch` reports its
 * execution failure only in the paired output, so correct that one known shape
 * without guessing outcomes for arbitrary tools.
 */
export function resolveTranscriptToolOutputState(
  toolName: string | undefined,
  output: unknown,
  claimedState: ToolState | null,
): ToolState | null {
  if (claimedState === "failure") return "failure";
  if (toolName?.trim().toLowerCase() !== "apply_patch") return claimedState;

  const text = transcriptToolOutputText(output) || (typeof output === "string" ? output : "");
  if (
    /^apply_patch verification failed\b/im.test(text)
    || /^failed to find (?:expected )?(?:lines|context)\b/im.test(text)
    || /^invalid (?:patch|context)(?:\b| \d)/im.test(text)
    || /^patch (?:application )?(?:failed|did not apply)\b/im.test(text)
    || /^(?:unable|failed) to apply (?:the )?patch\b/im.test(text)
    || /^error applying (?:the )?patch\b/im.test(text)
    || /^failed to read file to (?:update|delete)\b/im.test(text)
    || /^failed to (?:write|delete|move) file\b/im.test(text)
    || /^failed to create parent directories for\b/im.test(text)
    || /^invalid (?:add|delete|update) file line\b/im.test(text)
    || /^invalid (?:eof )?context line\b/im.test(text)
    || /^(?:missing end of file|duplicate path|move target already exists)\b/im.test(text)
  ) {
    return "failure";
  }
  return claimedState;
}

function createActionPart(
  toolName: string,
  rawArgs: unknown,
  state: ToolState,
): TranscriptActionPart {
  const toolArgs = normalizeTranscriptToolArgs(toolName, rawArgs);

  return {
    type: "tool-invocation",
    content: toolName,
    toolName,
    toolArgs,
    toolState: state,
    toolTitle: toolName,
  };
}

/**
 * Folds a `*_call_output` rollout record into the tool part it belongs to.
 *
 * `state` is the outcome the *call* record claimed, or `null` when the rollout
 * carries no outcome at all. `null` deliberately clears `toolState` rather than
 * defaulting to success: a `function_call_output` is written whether the command
 * succeeded or failed, so treating its mere presence as success paints a green
 * badge on failed commands. Measured across this repo's full Codex history —
 * 92,495 `function_call` records — `status` was absent from every one, and no
 * exit code or error marker appears in the output text either. "Unknown" is the
 * only honest state, and the UI renders a missing `toolState` as no badge.
 *
 * Generic over the part shape so the parent rollout parser
 * (`history/rollout.ts`) and this sub-agent parser share one implementation and
 * cannot drift into disagreeing about what a persisted tool result means.
 */
export function applyTranscriptToolOutput<
  Part extends {
    toolState?: ToolState;
    toolOutput?: string;
    toolError?: string;
  },
>(
  part: Part,
  output: unknown,
  state: ToolState | null = null,
): Part {
  const serializedOutput = stringifyTranscriptToolOutput(output);
  const nextState = state === null ? undefined : state;

  return {
    ...part,
    toolState: nextState,
    toolOutput: nextState === "failure" ? undefined : serializedOutput,
    toolError: nextState === "failure" ? serializedOutput ?? "Tool failed" : undefined,
  };
}

function isExplicitSubagentFailureEvent(eventType: string | undefined): boolean {
  if (!eventType) {
    return false;
  }

  return (
    eventType === "task_failed"
    || eventType === "task_error"
    || eventType === "task_aborted"
    || eventType === "task_cancelled"
  );
}

function resolveSubagentOutcome(
  childOutcome: SubagentOutcome,
  parentOutcome?: SubagentOutcome,
): SubagentOutcome {
  if (parentOutcome === "success" || childOutcome === "success") {
    return "success";
  }

  if (parentOutcome === "failure" || childOutcome === "failure") {
    return "failure";
  }

  return "pending";
}

function parseChildTranscript(
  records: TranscriptRecord[],
  base: SpawnedSubagent,
): TranscriptSubagentPart {
  const actions: TranscriptActionPart[] = [];
  const actionIndexByCallId = new Map<string, number>();

  let name = base.nickname;
  let role = base.role;
  let prompt = base.prompt;
  let state: ToolState = "pending";

  for (const record of records) {
    const payload = record.payload;
    if (!payload) {
      continue;
    }

    // A Codex child thread is reusable. Its rollout therefore contains all of
    // its turns, including an earlier final_answer followed by a later
    // follow-up. Starting a new turn must reopen the row; otherwise the old
    // terminal marker remains sticky while new actions stream underneath it.
    if (
      record.type === "turn_context"
      || (
        record.type === "event_msg"
        && (payload.type === "task_started" || payload.type === "user_message")
      )
    ) {
      state = "pending";
      continue;
    }

    if (record.type === "session_meta") {
      name = asString(payload.agent_nickname) ?? name;
      role = asString(payload.agent_role) ?? role;
      continue;
    }

    if (record.type === "event_msg" && payload.type === "task_complete") {
      state = "success";
      continue;
    }

    if (record.type === "event_msg" && isExplicitSubagentFailureEvent(asString(payload.type))) {
      state = "failure";
      continue;
    }

    if (record.type === "event_msg" && payload.type === "agent_message") {
      const phase = asString(payload.phase);
      if (phase === "commentary") {
        state = "pending";
        const content = asString(payload.message);
        if (content) actions.push({ type: "text", content });
      } else if (phase === "final_answer") {
        appendTextAction(actions, payload.message);
      }
      if (phase === "final_answer") {
        state = "success";
      }
      continue;
    }

    if (record.type !== "response_item") {
      continue;
    }

    const payloadType = asString(payload.type);
    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      state = "pending";
      const toolName = asString(payload.name) ?? "tool";
      const callId = asString(payload.call_id);
      const input = payloadType === "custom_tool_call" ? payload.input : payload.arguments;
      const status = asString(payload.status);
      const initialState: ToolState =
        status === "failed"
          ? "failure"
          : status === "completed"
            ? "success"
            : "pending";
      const part = createActionPart(toolName, input, initialState);

      if (payloadType === "custom_tool_call" && (initialState === "success" || initialState === "failure")) {
        const output = payload.output;
        actions.push(applyTranscriptToolOutput(
          part,
          output,
          resolveTranscriptToolOutputState(toolName, output, initialState),
        ));
      } else {
        actions.push(part);
      }

      if (callId) {
        actionIndexByCallId.set(callId, actions.length - 1);
      }
      continue;
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const callId = asString(payload.call_id);
      if (!callId) {
        continue;
      }

      const actionIndex = actionIndexByCallId.get(callId);
      if (actionIndex === undefined) {
        continue;
      }

      const existing = actions[actionIndex] as TranscriptActionPart;
      actions[actionIndex] = applyTranscriptToolOutput(
        existing,
        payload.output,
        payloadType === "custom_tool_call_output"
          ? resolveTranscriptToolOutputState(
              existing.toolName,
              payload.output,
              existing.toolState ?? null,
            )
          : null,
      );
      continue;
    }

    if (payloadType === "message" && asString(payload.phase) === "final_answer") {
      appendTextAction(actions, messageContentText(payload.content));
      state = "success";
    }
  }

  const actionCount = actions.filter((action) => action.type === "tool-invocation").length;
  const displayName = name ?? role ?? base.agentId ?? "subagent";

  return {
    type: "subagent",
    content: displayName,
    subagentId: base.agentId,
    subagentName: name,
    subagentRole: role,
    subagentPrompt: prompt,
    subagentActions: actions,
    subagentActionCount: actionCount,
    toolState: state,
  };
}

export function parseTranscriptRecords(lines: string[]): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        timestamp?: unknown;
        type?: unknown;
        payload?: unknown;
      };

      records.push({
        timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
        type: typeof parsed.type === "string" ? parsed.type : undefined,
        payload: isRecord(parsed.payload) ? parsed.payload : undefined,
      });
    } catch {
      continue;
    }
  }

  return records;
}

/**
 * Multi-agent v2 spawn outputs no longer expose the child thread ID; it is
 * published through sub_agent_activity event records whose event_id matches
 * the originating collaboration tool call_id.
 */
export function parseSubAgentActivityRecords(
  records: TranscriptRecord[],
): SubAgentActivityRecord[] {
  const activities: SubAgentActivityRecord[] = [];

  for (const record of records) {
    const payload = record.payload;
    if (!payload || record.type !== "event_msg" || payload.type !== "sub_agent_activity") {
      continue;
    }

    const callId = asString(payload.event_id);
    const agentThreadId = asString(payload.agent_thread_id);
    if (!callId || !agentThreadId) {
      continue;
    }

    activities.push({
      callId,
      agentThreadId,
      agentPath: asString(payload.agent_path),
    });
  }

  return activities;
}

function outcomeFromAgentStatus(status: unknown): SubagentOutcome | undefined {
  if (typeof status === "string") {
    if (status === "completed" || status === "shutdown") {
      return "success";
    }
    if (status === "errored" || status === "interrupted" || status === "not_found") {
      return "failure";
    }
    return undefined;
  }

  if (!isRecord(status)) {
    return undefined;
  }

  if (typeof status.completed === "string") {
    return "success";
  }

  if (
    typeof status.failed === "string"
    || typeof status.error === "string"
    || typeof status.errored === "string"
    || status.cancelled === true
    || status.aborted === true
  ) {
    return "failure";
  }

  return undefined;
}

function parseCollabOutcomeByAgentId(
  parentRecords: TranscriptRecord[],
  agentIdByPath: ReadonlyMap<string, string>,
): Map<string, SubagentOutcome> {
  const outcomeByAgentId = new Map<string, SubagentOutcome>();
  const waitAgentCallIds = new Set<string>();
  const listAgentsCallIds = new Set<string>();

  const recordOutcome = (agentKey: string, status: unknown): void => {
    const outcome = outcomeFromAgentStatus(status);
    if (!outcome) {
      return;
    }
    outcomeByAgentId.set(agentIdByPath.get(agentKey) ?? agentKey, outcome);
  };

  for (const record of parentRecords) {
    const payload = record.payload;
    if (!payload || record.type !== "response_item") {
      continue;
    }

    const payloadType = asString(payload.type);
    if (payloadType === "function_call") {
      const callId = asString(payload.call_id);
      if (!callId) {
        continue;
      }
      const name = asString(payload.name);
      if (name === "wait_agent") {
        waitAgentCallIds.add(callId);
      } else if (name === "list_agents") {
        listAgentsCallIds.add(callId);
      }
      continue;
    }

    if (payloadType !== "function_call_output" || typeof payload.output !== "string") {
      continue;
    }

    const callId = asString(payload.call_id);
    if (!callId) {
      continue;
    }

    if (waitAgentCallIds.has(callId)) {
      const output = parseJson<Record<string, unknown>>(payload.output);
      if (!isRecord(output?.status)) {
        continue;
      }

      for (const [agentKey, status] of Object.entries(output.status)) {
        recordOutcome(agentKey, status);
      }
      continue;
    }

    // Multi-agent v2 wait_agent outputs carry no per-agent status; the
    // authoritative terminal states appear in list_agents outputs keyed by
    // agent path.
    if (listAgentsCallIds.has(callId)) {
      const output = parseJson<Record<string, unknown>>(payload.output);
      if (!Array.isArray(output?.agents)) {
        continue;
      }

      for (const agent of output.agents) {
        if (!isRecord(agent)) {
          continue;
        }
        const agentName = asString(agent.agent_name);
        if (!agentName) {
          continue;
        }
        recordOutcome(agentName, agent.agent_status);
      }
    }
  }

  return outcomeByAgentId;
}

export function deriveSubagentPartsFromTranscriptRecords(
  parentRecords: TranscriptRecord[],
  childRecordsByAgentId: Map<string, TranscriptRecord[]>,
  resolvedAgentIdBySpawnCallId: ReadonlyMap<string, string> = new Map(),
): TranscriptSubagentPart[] {
  const spawnedSubagents: SpawnedSubagent[] = [];
  const spawnedSubagentByCallId = new Map<string, SpawnedSubagent>();

  const activityAgentIdByCallId = new Map<string, string>();
  const agentIdByPath = new Map<string, string>();
  for (const activity of parseSubAgentActivityRecords(parentRecords)) {
    if (!activityAgentIdByCallId.has(activity.callId)) {
      activityAgentIdByCallId.set(activity.callId, activity.agentThreadId);
    }
    if (activity.agentPath && !agentIdByPath.has(activity.agentPath)) {
      agentIdByPath.set(activity.agentPath, activity.agentThreadId);
    }
  }

  const collabOutcomeByAgentId = parseCollabOutcomeByAgentId(parentRecords, agentIdByPath);

  for (const record of parentRecords) {
    const payload = record.payload;
    if (!payload || record.type !== "response_item") {
      continue;
    }

    const payloadType = asString(payload.type);
    if (payloadType === "function_call" && asString(payload.name) === "spawn_agent") {
      const callId = asString(payload.call_id);
      if (!callId) {
        continue;
      }

      const args = parseJson<Record<string, unknown>>(payload.arguments);
      const spawned: SpawnedSubagent = {
        callId,
        agentId: resolvedAgentIdBySpawnCallId.get(callId)
          ?? activityAgentIdByCallId.get(callId),
        role: asString(args?.agent_type) ?? asString(args?.task_name),
        prompt: asDisplayablePrompt(args?.message),
      };
      spawnedSubagents.push(spawned);
      spawnedSubagentByCallId.set(callId, spawned);
      continue;
    }

    if (payloadType === "function_call_output") {
      const callId = asString(payload.call_id);
      if (!callId) {
        continue;
      }

      const spawned = spawnedSubagentByCallId.get(callId);
      if (!spawned) {
        continue;
      }

      const output = parseJson<Record<string, unknown>>(payload.output);
      spawned.agentId = asString(output?.agent_id)
        ?? resolvedAgentIdBySpawnCallId.get(callId)
        ?? activityAgentIdByCallId.get(callId)
        ?? spawned.agentId;
      spawned.nickname = asString(output?.nickname) ?? spawned.nickname;
    }
  }

  return spawnedSubagents.map((spawned) => {
    const childRecords = spawned.agentId ? childRecordsByAgentId.get(spawned.agentId) ?? [] : [];
    const part = parseChildTranscript(childRecords, spawned);
    const parentOutcome = spawned.agentId
      ? collabOutcomeByAgentId.get(spawned.agentId)
      : undefined;

    return {
      ...part,
      toolState: resolveSubagentOutcome(part.toolState, parentOutcome),
    };
  });
}

export function mergeSubagentPartsIntoMessageParts<T extends MergeablePart>(
  parts: T[],
  subagentParts: T[],
): T[] {
  if (subagentParts.length === 0) {
    return parts;
  }

  let insertIndex = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type !== "text") {
      insertIndex = index + 1;
      break;
    }
  }

  return [
    ...parts.slice(0, insertIndex),
    ...subagentParts,
    ...parts.slice(insertIndex),
  ];
}
