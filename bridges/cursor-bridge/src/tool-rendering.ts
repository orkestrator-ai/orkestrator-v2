/**
 * Rendering one Cursor SDK tool call as a provider-neutral tool card.
 *
 * This is where the SDK's typed tool vocabulary stops being Cursor-shaped.
 * Everything downstream — the renderer's diff view, its todo list, its
 * sub-agent cards — reads the same fields it reads for Claude, Codex and
 * OpenCode, so the look and feel of a Cursor turn is a property of this file
 * rather than of the frontend.
 *
 * Every branch is defensive about shape. The SDK is a fast-moving dependency
 * and a tool variant added upstream must degrade to a plain card, not throw on
 * the event loop that is streaming a live turn.
 */
import { MAX_TOOL_ARGUMENT_BYTES, MAX_TOOL_DIFF_BYTES, MAX_TOOL_OUTPUT_BYTES } from "./config.js";
import { boundText } from "./transcript.js";
import {
  isObject,
  nonBlank,
  TODO_STATUSES,
  type BridgeToolDiff,
  type JsonObject,
  type TodoItem,
  type TodoStatus,
} from "./state.js";

export interface RenderedToolCall {
  toolName: string;
  toolTitle?: string;
  toolArgs?: JsonObject;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: BridgeToolDiff;
  /** Present only for `task`, which launches a sub-agent. */
  subagent?: {
    description?: string;
    prompt?: string;
    subagentType?: string;
    agentId?: string;
    isBackground?: boolean;
    durationMs?: number;
  };
  /** Present only for `updateTodos`, whose list is session-wide. */
  todos?: TodoItem[];
}

/** The result half of every SDK tool call, before we know which tool it is. */
type ToolResult =
  | { status: "success"; value?: unknown }
  | { status: "error"; error?: unknown }
  | undefined;

export function renderToolCall(call: unknown): RenderedToolCall {
  const record = isObject(call) ? call : {};
  const toolName = nonBlank(record.type) ? record.type : "tool";
  const args = isObject(record.args) ? record.args : {};
  const result = readResult(record.result);
  const rendered: RenderedToolCall = { toolName };

  switch (toolName) {
    case "shell":
      renderShell(rendered, args, result);
      break;
    case "read":
      renderRead(rendered, args, result);
      break;
    case "edit":
      renderEdit(rendered, args, result);
      break;
    case "write":
      renderWrite(rendered, args, result);
      break;
    case "delete":
      renderDelete(rendered, args, result);
      break;
    case "glob":
      renderGlob(rendered, args, result);
      break;
    case "grep":
      renderGrep(rendered, args, result);
      break;
    case "ls":
      renderLs(rendered, args, result);
      break;
    case "readLints":
      renderReadLints(rendered, args, result);
      break;
    case "semSearch":
      renderSemSearch(rendered, args, result);
      break;
    case "mcp":
      renderMcp(rendered, args, result);
      break;
    case "createPlan":
      renderCreatePlan(rendered, args, result);
      break;
    case "updateTodos":
      renderUpdateTodos(rendered, args, result);
      break;
    case "task":
      renderTask(rendered, args, result);
      break;
    case "generateImage":
      renderGenerateImage(rendered, args, result);
      break;
    default:
      renderGeneric(rendered, args, result);
      break;
  }

  // The error branch is uniform across every tool, so applying it once here
  // means a new SDK tool variant still reports its failure correctly through
  // the generic path above.
  if (result?.status === "error" && !rendered.toolError) {
    rendered.toolError = boundText(errorMessage(result.error), MAX_TOOL_OUTPUT_BYTES);
  }
  return rendered;
}

function renderShell(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const command = readString(args.command) ?? "";
  rendered.toolTitle = command || "shell";
  rendered.toolArgs = compact({
    command,
    workingDirectory: readString(args.workingDirectory),
    timeout: readNumber(args.timeout),
  });
  const value = successValue(result);
  if (!value) return;
  const stdout = readRawText(value.stdout) ?? "";
  const stderr = readRawText(value.stderr) ?? "";
  const exitCode = readNumber(value.exitCode);
  // Interleaving is lost by the time the SDK reports a completed call, so
  // label the streams rather than concatenating them into something that
  // reads like one transcript.
  const sections = [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join("\n");
  rendered.toolOutput = boundText(sections, MAX_TOOL_OUTPUT_BYTES);
  if (exitCode !== undefined && exitCode !== 0) {
    rendered.toolError = `Command exited with status ${exitCode}`;
  }
}

function renderRead(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const path = readString(args.path);
  rendered.toolTitle = path ?? "read";
  rendered.toolArgs = compact({ path });
  const value = successValue(result);
  if (!value) return;
  rendered.toolOutput = boundText(readRawText(value.content) ?? "", MAX_TOOL_OUTPUT_BYTES);
}

function renderEdit(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const path = readString(args.path);
  rendered.toolTitle = path ?? "edit";
  rendered.toolArgs = compact({ path });
  const value = successValue(result);
  if (!value) return;
  const diff = readRawText(value.diffString);
  rendered.toolDiff = compactDiff({
    filePath: path,
    additions: readNumber(value.linesAdded),
    deletions: readNumber(value.linesRemoved),
    diff: diff ? boundText(diff, MAX_TOOL_DIFF_BYTES) : undefined,
  });
}

function renderWrite(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const path = readString(args.path);
  rendered.toolTitle = path ?? "write";
  rendered.toolArgs = compact({ path });
  const value = successValue(result);
  if (!value) return;
  const after = readRawText(value.fileContentAfterWrite) ?? readRawText(args.fileText);
  rendered.toolDiff = compactDiff({
    filePath: path,
    additions: readNumber(value.linesCreated),
    // A write replaces the file wholesale, so the post-image is the diff the
    // renderer can show. `before` is deliberately absent rather than empty:
    // an empty string would render as "the file was blank", which is a claim
    // the SDK never made.
    after: after ? boundText(after, MAX_TOOL_DIFF_BYTES) : undefined,
  });
}

function renderDelete(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const path = readString(args.path);
  rendered.toolTitle = path ?? "delete";
  rendered.toolArgs = compact({ path });
  const value = successValue(result);
  if (value) rendered.toolOutput = `Deleted ${path ?? "file"}`;
}

function renderGlob(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const pattern = readString(args.globPattern);
  rendered.toolTitle = pattern ?? "glob";
  rendered.toolArgs = compact({
    globPattern: pattern,
    targetDirectory: readString(args.targetDirectory),
  });
  const value = successValue(result);
  if (!value) return;
  const files = Array.isArray(value.files) ? value.files.filter(nonBlank) : [];
  const total = readNumber(value.totalFiles) ?? files.length;
  const truncated = value.clientTruncated === true || value.ripgrepTruncated === true;
  rendered.toolOutput = boundText(
    [files.join("\n"), truncated ? `\n[${total} matches, list truncated]` : ""]
      .filter(Boolean)
      .join(""),
    MAX_TOOL_OUTPUT_BYTES,
  );
}

function renderGrep(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const pattern = readString(args.pattern);
  rendered.toolTitle = pattern ?? "grep";
  rendered.toolArgs = compact({
    pattern,
    path: readString(args.path),
    glob: readString(args.glob),
    outputMode: readString(args.outputMode),
    caseInsensitive: readBoolean(args.caseInsensitive),
    type: readString(args.type),
  });
  const value = successValue(result);
  if (!value) return;
  // The grep payload is a nested per-file union whose exact shape varies by
  // output mode. Serialize it rather than pretending to know every variant;
  // the renderer shows it as preformatted output either way.
  rendered.toolOutput = boundText(stringify(value), MAX_TOOL_OUTPUT_BYTES);
}

function renderLs(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const path = readString(args.path);
  rendered.toolTitle = path ?? "ls";
  rendered.toolArgs = compact({ path, ignore: readStringArray(args.ignore) });
  const value = successValue(result);
  if (!value) return;
  rendered.toolOutput = boundText(
    flattenDirectoryTree(value.directoryTreeRoot).join("\n"),
    MAX_TOOL_OUTPUT_BYTES,
  );
}

function renderReadLints(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const paths = readStringArray(args.paths) ?? [];
  rendered.toolTitle = paths.length === 1 ? paths[0] : `${paths.length} files`;
  rendered.toolArgs = compact({ paths });
  const value = successValue(result);
  if (!value) return;
  const total = readNumber(value.totalDiagnostics) ?? 0;
  rendered.toolOutput = boundText(
    total === 0 ? "No diagnostics" : stringify(value.fileDiagnostics),
    MAX_TOOL_OUTPUT_BYTES,
  );
}

function renderSemSearch(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const query = readString(args.query);
  rendered.toolTitle = query ?? "search";
  rendered.toolArgs = compact({
    query,
    targetDirectories: readStringArray(args.targetDirectories),
  });
  const value = successValue(result);
  if (!value) return;
  rendered.toolOutput = boundText(readRawText(value.results) ?? "", MAX_TOOL_OUTPUT_BYTES);
}

function renderMcp(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const provider = readString(args.providerIdentifier);
  const tool = readString(args.toolName);
  // Name the card after the MCP tool rather than "mcp": a session with several
  // servers attached is otherwise a column of identical cards.
  rendered.toolName = tool ? `mcp__${provider ?? "server"}__${tool}` : "mcp";
  rendered.toolTitle = tool ? `${provider ? `${provider}: ` : ""}${tool}` : "mcp";
  rendered.toolArgs = isObject(args.args) ? boundArgs(args.args) : undefined;
  const value = successValue(result);
  if (!value) return;
  const content = Array.isArray(value.content) ? value.content : [];
  const text = content
    .map((entry) =>
      isObject(entry) ? (readRawText(entry.text) ?? stringify(entry)) : String(entry),
    )
    .join("\n");
  if (value.isError === true) rendered.toolError = boundText(text, MAX_TOOL_OUTPUT_BYTES);
  else rendered.toolOutput = boundText(text, MAX_TOOL_OUTPUT_BYTES);
}

function renderCreatePlan(rendered: RenderedToolCall, args: JsonObject, _result: ToolResult): void {
  const plan = readRawText(args.plan) ?? "";
  rendered.toolTitle = "Plan";
  rendered.toolArgs = compact({ plan: boundText(plan, MAX_TOOL_ARGUMENT_BYTES) });
  rendered.toolOutput = boundText(plan, MAX_TOOL_OUTPUT_BYTES);
}

function renderUpdateTodos(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  // Prefer the result list: it is the post-merge state the agent actually
  // holds, whereas the arguments are only the requested change.
  const value = successValue(result);
  const source = Array.isArray(value?.todos) ? value.todos : args.todos;
  const todos = readTodos(source);
  rendered.toolTitle = "Todos";
  rendered.todos = todos;
  rendered.toolArgs = { todos: todos as unknown as JsonObject[] };
}

function renderTask(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  const description = readString(args.description);
  const subagentType = isObject(args.subagentType)
    ? (readString(args.subagentType.name) ?? readString(args.subagentType.kind))
    : readString(args.subagentType);
  rendered.toolName = "task";
  rendered.toolTitle = description ?? subagentType ?? "Task";
  rendered.toolArgs = compact({
    description,
    prompt: boundTextOrUndefined(readRawText(args.prompt), MAX_TOOL_ARGUMENT_BYTES),
    subagent_type: subagentType,
    model: readString(args.model),
  });
  const value = successValue(result);
  rendered.subagent = {
    description,
    prompt: readRawText(args.prompt),
    subagentType,
    agentId: readString(value?.agentId) ?? readString(args.agentId),
    isBackground: value?.isBackground === true,
    durationMs: readNumber(value?.durationMs),
  };
  if (value) {
    const suffix = readRawText(value.resultSuffix);
    if (suffix) rendered.toolOutput = boundText(suffix, MAX_TOOL_OUTPUT_BYTES);
  }
}

function renderGenerateImage(
  rendered: RenderedToolCall,
  args: JsonObject,
  result: ToolResult,
): void {
  rendered.toolTitle = readString(args.description) ?? "Generate image";
  rendered.toolArgs = compact({
    description: readString(args.description),
    filePath: readString(args.filePath),
  });
  const value = successValue(result);
  // `imageData` is a base64 payload. Report where it landed and never inline
  // it: one generated image would otherwise consume the transcript budget.
  if (value) rendered.toolOutput = readString(value.filePath) ?? "Image generated";
}

function renderGeneric(rendered: RenderedToolCall, args: JsonObject, result: ToolResult): void {
  rendered.toolArgs = boundArgs(args);
  const value = successValue(result);
  if (value) rendered.toolOutput = boundText(stringify(value), MAX_TOOL_OUTPUT_BYTES);
}

function readResult(value: unknown): ToolResult {
  if (!isObject(value)) return undefined;
  if (value.status === "success") return { status: "success", value: value.value };
  if (value.status === "error") return { status: "error", error: value.error };
  return undefined;
}

function successValue(result: ToolResult): JsonObject | undefined {
  if (result?.status !== "success") return undefined;
  return isObject(result.value) ? result.value : undefined;
}

function errorMessage(error: unknown): string {
  if (nonBlank(error)) return error;
  if (isObject(error)) {
    // `generateImage` spells its failure `error`; everything else uses
    // `message`. Read both rather than losing the text on one tool.
    return readString(error.message) ?? readString(error.error) ?? stringify(error);
  }
  return "The tool call failed";
}

/**
 * Normalize the SDK's todo statuses to the vocabulary the shared renderer
 * parses. `inProgress` is the one that would otherwise be dropped: the
 * renderer normalizes separators and case, so it reads that as "inprogress"
 * and rejects the item rather than showing it as running.
 */
export function readTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const todos: TodoItem[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const content = readString(entry.content);
    const status = normalizeTodoStatus(entry.status);
    if (!content || !status) continue;
    todos.push({ content, status });
  }
  return todos;
}

function normalizeTodoStatus(value: unknown): TodoStatus | undefined {
  if (!nonBlank(value)) return undefined;
  const normalized = value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  return TODO_STATUSES.includes(normalized as TodoStatus) ? (normalized as TodoStatus) : undefined;
}

function flattenDirectoryTree(root: unknown, depth = 0, out: string[] = []): string[] {
  if (!isObject(root) || depth > 32 || out.length >= 4_096) return out;
  const name = readString(root.name) ?? readString(root.path);
  if (name) out.push(`${"  ".repeat(depth)}${name}`);
  const children = root.children ?? root.entries;
  if (Array.isArray(children)) {
    for (const child of children) flattenDirectoryTree(child, depth + 1, out);
  }
  return out;
}

/** For labels and identifiers, where surrounding whitespace is never meaningful. */
function readString(value: unknown): string | undefined {
  return nonBlank(value) ? value.trim() : undefined;
}

/**
 * For payloads the user reads verbatim.
 *
 * Command output, file contents and search results carry meaningful leading
 * and trailing whitespace — trimming them silently rewrites what the tool
 * actually produced.
 */
function readRawText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter(nonBlank);
  return entries.length > 0 ? entries : undefined;
}

function boundTextOrUndefined(value: string | undefined, limit: number): string | undefined {
  return value === undefined ? undefined : boundText(value, limit);
}

/** Drop undefined fields so a tool card never renders an empty argument row. */
function compact(record: Record<string, unknown>): JsonObject | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactDiff(diff: BridgeToolDiff): BridgeToolDiff | undefined {
  const entries = Object.entries(diff).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as BridgeToolDiff) : undefined;
}

/**
 * Bound an arbitrary argument object by re-parsing its serialized form.
 *
 * Trimming individual fields would need to know which ones matter; capping the
 * whole object keeps the memory bound without that judgement, and an
 * over-budget payload degrades to a single readable note instead of a
 * half-serialized object the renderer cannot parse.
 */
function boundArgs(args: JsonObject): JsonObject | undefined {
  const serialized = stringify(args);
  if (!serialized) return undefined;
  if (Buffer.byteLength(serialized) <= MAX_TOOL_ARGUMENT_BYTES) return args;
  return { truncated: `Arguments omitted (${Buffer.byteLength(serialized)} bytes)` };
}

function stringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  } catch {
    // A cyclic or unserializable payload is a rendering problem, never a
    // reason to fail the turn that produced it.
    return "";
  }
}
