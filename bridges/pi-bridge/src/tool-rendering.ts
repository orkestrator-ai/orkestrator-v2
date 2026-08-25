/**
 * Turning one Pi tool call into the card the shared renderer draws.
 *
 * This and {@link ./translate.ts} are the engine boundary. Every Pi-specific
 * shape stops here: downstream sees a title, bounded arguments, bounded output
 * and an optional diff, and never learns that `edit` reports its diff under
 * `details.diff` while `bash` reports truncation under `details.truncation`.
 *
 * Nothing here throws. A tool variant Pi adds — or a custom tool from a
 * project extension, whose shape this bridge cannot know at all — must degrade
 * to a plain card, because these branches run mid-turn.
 */
import {
  MAX_TOOL_ARGUMENT_BYTES,
  MAX_TOOL_DIFF_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_TITLE_BYTES,
} from "./config.js";
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
  /** Present when this call carried a whole todo list, not a delta. */
  todos?: TodoItem[];
}

export interface ToolCallSource {
  toolName: string;
  input: unknown;
  /** Present once the call has settled, or on a streaming partial result. */
  result?: unknown;
  isError?: boolean;
}

/**
 * Render a tool call at whatever stage it has reached.
 *
 * Called for the start frame, every streaming update and the end frame, so it
 * must be stable: patching a card with a *worse* title than it already had is
 * a visible flicker, which is why an unresolvable title falls back to the tool
 * name rather than to an empty string.
 */
export function renderToolCall(source: ToolCallSource): RenderedToolCall {
  const toolName = nonBlank(source.toolName) ? source.toolName : "tool";
  const input = isObject(source.input) ? source.input : {};
  const rendered: RenderedToolCall = {
    toolName,
    toolTitle: boundText(toolTitle(toolName, input), MAX_TOOL_TITLE_BYTES),
    toolArgs: boundArguments(input),
  };

  const todos = readTodos(input.todos);
  if (todos.length > 0) rendered.todos = todos;

  const details = toolResultDetails(source.result);
  const text = toolResultText(source.result);
  if (source.isError) {
    // The model reads the same text as its tool result, so an error card must
    // carry it verbatim rather than a generic failure line.
    rendered.toolError = boundText(text || `The ${toolName} tool failed`, MAX_TOOL_OUTPUT_BYTES);
  } else if (text) {
    rendered.toolOutput = boundText(text, MAX_TOOL_OUTPUT_BYTES);
  }

  const diff = readDiff(toolName, input, details);
  if (diff) rendered.toolDiff = diff;
  return rendered;
}

/**
 * A one-line summary of what the call does.
 *
 * Built from the arguments rather than from the result, so a card is
 * meaningful the moment it appears and does not change when the call settles.
 */
function toolTitle(toolName: string, input: JsonObject): string {
  switch (toolName) {
    case "bash":
    case "powershell": {
      const command = readString(input.command);
      return command ? firstLine(command) : toolName;
    }
    case "read":
    case "write":
      return readString(input.path) || toolName;
    case "edit": {
      const path = readString(input.path);
      const edits = Array.isArray(input.edits) ? input.edits.length : 0;
      if (!path) return toolName;
      return edits > 1 ? `${path} (${edits} edits)` : path;
    }
    case "grep": {
      const pattern = readString(input.pattern);
      const path = readString(input.path);
      if (!pattern) return toolName;
      return path ? `${pattern} in ${path}` : pattern;
    }
    case "find": {
      const pattern = readString(input.pattern);
      const path = readString(input.path);
      if (!pattern) return toolName;
      return path ? `${pattern} in ${path}` : pattern;
    }
    case "ls":
      return readString(input.path) || ".";
    default: {
      // A custom tool from an extension. Prefer whichever conventional field it
      // happens to carry, and never invent one: a title guessed out of an
      // unknown payload is worse than the tool's own name.
      for (const key of ["title", "description", "name", "path", "command", "query"]) {
        const value = readString(input[key]);
        if (value) return firstLine(value);
      }
      return toolName;
    }
  }
}

/**
 * The diff a file-mutating call produced.
 *
 * `edit` reports one directly. `write` reports none, because it replaced the
 * file wholesale — its content is shown as the "after" side so the card is
 * still reviewable, with no "before" invented for it.
 */
function readDiff(
  toolName: string,
  input: JsonObject,
  details: JsonObject | undefined,
): BridgeToolDiff | undefined {
  if (toolName === "edit") {
    const diff = readString(details?.diff) || readString(details?.patch);
    if (!diff) return undefined;
    return {
      ...(readString(input.path) ? { filePath: readString(input.path) } : {}),
      diff: boundText(diff, MAX_TOOL_DIFF_BYTES),
    };
  }
  if (toolName === "write") {
    const content = readString(input.content);
    if (!content) return undefined;
    return {
      ...(readString(input.path) ? { filePath: readString(input.path) } : {}),
      after: boundText(content, MAX_TOOL_DIFF_BYTES),
    };
  }
  return undefined;
}

/**
 * Flatten a Pi tool result's content blocks into display text.
 *
 * Image blocks are named rather than inlined: a base64 screenshot would spend
 * a large share of the transcript budget on one card, and the renderer has no
 * way to show it inside a tool result anyway.
 */
export function toolResultText(result: unknown): string {
  if (nonBlank(result)) return result;
  if (!isObject(result)) return "";
  const content = result.content;
  if (nonBlank(content)) return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const block of content) {
    if (nonBlank(block)) {
      chunks.push(block);
      continue;
    }
    if (!isObject(block)) continue;
    if (nonBlank(block.text)) chunks.push(block.text);
    else if (block.type === "image") chunks.push("[image]");
  }
  return chunks.join("\n");
}

function toolResultDetails(result: unknown): JsonObject | undefined {
  if (!isObject(result)) return undefined;
  return isObject(result.details) ? result.details : undefined;
}

/**
 * Read a todo list out of tool arguments.
 *
 * Pi ships no todo tool of its own — this is for the extension ecosystem,
 * where a todo list is the one custom-tool payload the shared renderer already
 * has a control for. Exported because persistence rebuilds the session list
 * from the newest card that carried one.
 */
export function readTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const todos: TodoItem[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const content = readString(entry.content) || readString(entry.text) || readString(entry.title);
    if (!content) continue;
    todos.push({ content, status: readTodoStatus(entry.status) });
  }
  return todos;
}

function readTodoStatus(value: unknown): TodoStatus {
  return TODO_STATUSES.includes(value as TodoStatus) ? (value as TodoStatus) : "pending";
}

/**
 * Keep the arguments the card shows inside a byte budget.
 *
 * A single `write` call carries the whole new file in `content`, so an
 * unbounded copy would put the file in the transcript twice — once here and
 * once in the diff. Oversized values are replaced by a note rather than
 * truncated in place, because a half-serialized JSON value renders as garbage.
 */
function boundArguments(input: JsonObject): JsonObject | undefined {
  const entries = Object.entries(input);
  if (entries.length === 0) return undefined;
  const bounded: JsonObject = {};
  let budget = MAX_TOOL_ARGUMENT_BYTES;
  for (const [key, value] of entries) {
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(value) ?? "null");
    } catch {
      // A value with a cycle or a BigInt in it. Not renderable, and not worth
      // failing a live turn over.
      bounded[key] = "[unserializable]";
      continue;
    }
    if (size > budget) {
      bounded[key] = `[${size} bytes omitted]`;
      continue;
    }
    budget -= size;
    bounded[key] = value;
  }
  return bounded;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function firstLine(value: string): string {
  const line = value.split("\n", 1)[0] ?? "";
  return line.trim() || value.trim();
}
