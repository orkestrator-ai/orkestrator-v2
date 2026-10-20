/**
 * MCP tool calls a code-mode `exec` cell made, as a history reload sees them.
 *
 * Live, app-server reports each nested MCP call as an `mcpToolCall` item and
 * never streams the cell. The rollout keeps both: the cell as a
 * `custom_tool_call` named `exec`, and each call as an `event_msg`
 * `item_completed` record whose `item` is the core `McpToolCall` turn item:
 *
 * ```json
 * {"type":"event_msg","payload":{"type":"item_completed","turn_id":"…","item":{
 *   "type":"McpToolCall","id":"exec-…","server":"orkestrator","tool":"publish_artifact",
 *   "arguments":{…},"readOnlyHint":false,"status":"completed",
 *   "result":{"content":[…],"structuredContent":{…}},"duration":{"secs":0,"nanos":41000000}}}}
 * ```
 *
 * That record differs from the app-server item only in its `type` spelling and
 * its `duration`, so a reload renders it through the live adapter and renderer
 * ({@link rolloutMcpToolCallParts}). A rollout without the record keeps only
 * the cell's source, which {@link parseCodeModeMcpCalls} reads without ever
 * evaluating it.
 */
import { adaptAppServerItem } from "../app-server/item-adapter.js";
import { mcpToolCallParts } from "../messages/normalization.js";
import type { NormalizedPart } from "../messages/types.js";

/** The rollout's spelling of an MCP call item (`TurnItem::McpToolCall`). */
export const ROLLOUT_MCP_TOOL_CALL_ITEM_TYPE = "McpToolCall";

/** Largest JSON object argument the source fallback will parse, in characters. */
export const MAX_CODE_MODE_MCP_ARGUMENT_CHARS = 64 * 1024;
/**
 * Call sites examined in one cell's source, read or rejected; later ones are
 * ignored. Bounds the argument scans to this many times
 * {@link MAX_CODE_MODE_MCP_ARGUMENT_CHARS}, whatever the cell holds.
 */
export const MAX_CODE_MODE_MCP_CALLS_PER_CELL = 16;

export interface CodeModeMcpCall {
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The rollout writes a Rust `Duration` (`{secs, nanos}`); app-server reports
 * the same measurement as whole milliseconds, truncated.
 */
function rolloutDurationMs(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const secs = nonNegativeInteger(value.secs);
  const nanos = nonNegativeInteger(value.nanos);
  if (secs === undefined || nanos === undefined || nanos >= 1_000_000_000) return undefined;
  const ms = secs * 1000 + Math.floor(nanos / 1_000_000);
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/**
 * The normalized part for a rollout `McpToolCall` item, exactly as the live
 * path renders the matching app-server `mcpToolCall` item. Null for anything
 * else.
 */
export function rolloutMcpToolCallParts(item: unknown): NormalizedPart[] | null {
  if (!isRecord(item) || item.type !== ROLLOUT_MCP_TOOL_CALL_ITEM_TYPE) return null;
  const durationMs = rolloutDurationMs(item.duration);
  const { item: adapted } = adaptAppServerItem({
    ...item,
    type: "mcpToolCall",
    durationMs: durationMs ?? null,
  });
  return adapted?.type === "mcp_tool_call" ? mcpToolCallParts(adapted) : null;
}

/** `tools.mcp__<server>__<tool>(` — a server name has no `__` in it. */
const CALLEE = /tools\.mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__([A-Za-z0-9_-]+)\(/y;
const CALLEE_PREFIX = "tools.mcp__";
/** A character that would make `tools` part of a longer name or member chain. */
const NAME_OR_MEMBER_CHAR = /[A-Za-z0-9_$.]/;

/** The `server`/`tool` pairs a cell's source names, called or not. Bounded. */
export function codeModeMcpCallees(source: string): Set<string> {
  const callees = new Set<string>();
  const pattern = new RegExp(CALLEE.source, "g");
  for (const match of source.matchAll(pattern)) {
    callees.add(codeModeMcpCalleeKey(match[1]!, match[2]!));
    if (callees.size >= MAX_CODE_MODE_MCP_CALLS_PER_CELL) break;
  }
  return callees;
}

export function codeModeMcpCalleeKey(server: string, tool: string): string {
  return `${server}\u0000${tool}`;
}

function isJsonWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function skipJsonWhitespace(source: string, index: number): number {
  let cursor = index;
  while (isJsonWhitespace(source[cursor])) cursor += 1;
  return cursor;
}

/** Index after a JS string starting at `start` (its quote), or the end of input. */
function skipQuoted(source: string, start: number): number {
  const quote = source[start];
  let cursor = start + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    cursor += 1;
    if (char === quote) return cursor;
    // A newline ends an unterminated '…' or "…" literal; only a template spans lines.
    if (char === "\n" && quote !== "`") return cursor;
  }
  return source.length;
}

/**
 * A single strict-JSON object argument starting at `start` (just after the
 * call's `(`), closed by `)`. Null for anything else: a second argument, an
 * expression, a JS object literal, a template literal, or an object longer
 * than {@link MAX_CODE_MODE_MCP_ARGUMENT_CHARS}. Never evaluates anything.
 */
function readJsonObjectArgument(
  source: string,
  start: number,
): { value: Record<string, unknown>; end: number } | null {
  const open = skipJsonWhitespace(source, start);
  if (source[open] !== "{") return null;
  const limit = Math.min(source.length, open + MAX_CODE_MODE_MCP_ARGUMENT_CHARS);
  let depth = 0;
  let inString = false;
  let close = -1;
  for (let cursor = open; cursor < limit; cursor += 1) {
    const char = source[cursor];
    if (inString) {
      if (char === "\\") cursor += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        close = cursor;
        break;
      }
    }
  }
  if (close < 0) return null;
  const after = skipJsonWhitespace(source, close + 1);
  if (source[after] !== ")") return null;
  let value: unknown;
  try {
    value = JSON.parse(source.slice(open, close + 1));
  } catch {
    return null;
  }
  return isRecord(value) ? { value, end: after + 1 } : null;
}

/**
 * MCP calls read from a code-mode cell's JavaScript source, for a rollout
 * that recorded the cell but no `McpToolCall` item for it.
 *
 * Deliberately narrow: only `tools.mcp__<server>__<tool>(` in code (not in a
 * string or comment), whose only argument is one strict-JSON object of at
 * most {@link MAX_CODE_MODE_MCP_ARGUMENT_CHARS} characters, parsed with
 * `JSON.parse`. Unquoted keys, expressions, template literals, spreads and
 * further arguments all yield nothing, never a guess. At most
 * {@link MAX_CODE_MODE_MCP_CALLS_PER_CELL} call sites are examined.
 */
export function parseCodeModeMcpCalls(source: string): CodeModeMcpCall[] {
  const calls: CodeModeMcpCall[] = [];
  let callSites = 0;
  let cursor = 0;
  while (cursor < source.length && callSites < MAX_CODE_MODE_MCP_CALLS_PER_CELL) {
    const char = source[cursor];
    if (char === '"' || char === "'" || char === "`") {
      cursor = skipQuoted(source, cursor);
      continue;
    }
    if (char === "/" && source[cursor + 1] === "/") {
      const newline = source.indexOf("\n", cursor + 2);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (char === "/" && source[cursor + 1] === "*") {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end < 0 ? source.length : end + 2;
      continue;
    }
    if (
      char === "t" &&
      source.startsWith(CALLEE_PREFIX, cursor) &&
      !NAME_OR_MEMBER_CHAR.test(source[cursor - 1] ?? "")
    ) {
      CALLEE.lastIndex = cursor;
      const callee = CALLEE.exec(source);
      if (callee) {
        callSites += 1;
        const argument = readJsonObjectArgument(source, CALLEE.lastIndex);
        if (argument) {
          calls.push({ server: callee[1]!, tool: callee[2]!, arguments: argument.value });
          cursor = argument.end;
        } else {
          cursor = CALLEE.lastIndex;
        }
        continue;
      }
    }
    cursor += 1;
  }
  return calls;
}

/**
 * The part for a call read from a cell's source: the live renderer's part for
 * an MCP call still in flight. The source says nothing about how the call
 * ended, so the reload settles it from the cell's outcome only.
 */
export function codeModeMcpCallPart(call: CodeModeMcpCall, toolUseId: string): NormalizedPart {
  return mcpToolCallParts({
    id: toolUseId,
    type: "mcp_tool_call",
    server: call.server,
    tool: call.tool,
    arguments: call.arguments,
    status: "in_progress",
  })[0]!;
}
