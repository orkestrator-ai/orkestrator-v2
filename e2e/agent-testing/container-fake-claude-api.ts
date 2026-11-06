/**
 * QA stand-in for the Anthropic Messages API, run inside a disposable fixture
 * container on its loopback so the image's real `claude` CLI can take a turn
 * with no login and no billed request (todo 0020, task 2). The spec copies
 * this file into the container, starts it with the container's own `bun`, and
 * points Claude Code at it through `~/.claude/settings.json` `env`
 * (`ANTHROPIC_BASE_URL`, a fixture `ANTHROPIC_AUTH_TOKEN`).
 *
 *   bun container-fake-claude-api.ts --port 47123 [--reply-delay-ms 3000]
 *
 * `--reply-delay-ms` holds each reply back, so a turn lasts long enough for
 * its `working` state to be seen, as a real model's would. Without it the
 * whole turn can fit between two reads of a 1 s poll.
 * Every `POST /v1/messages` gets one text reply. A prompt asking for "the word
 * PONG and then A plus B" is answered `PONG <A+B>`, so the spec's answer check
 * still cannot match its own echoed input; anything else (title or topic
 * requests the CLI makes on the side) gets `PONG`. It keeps no request body
 * and logs nothing. No imports: the file runs on its own inside the image.
 *
 * A Multi Review step (todo 0190 task 3) gets a scripted turn instead: a
 * read-only `Bash` command (`ls -la`), then a mutating one (`touch` under
 * `/tmp`), then its result, then a closing sentence. The result goes where
 * the turn asks for it: the SDK's `StructuredOutput` tool when offered (the
 * structured-output transport), otherwise the Orkestrator `submit_<kind>`
 * tool its result-tool instruction names, with that instruction's resultKey
 * and capability (the default tool transport). The CLI defers MCP tools, so
 * that turn first loads the tool with `ToolSearch` (`select:<name>`). The
 * result is the smallest instance of the tool's own schema. A
 * schema with a top-level `headRef` (the validation plan) reads
 * `git rev-parse HEAD` instead of `ls -la` and submits that commit with one
 * limitation, since a plan with neither commands nor limitations is refused. Each
 * tool result's `is_error` is counted, never its text, and served with the
 * request count at `GET /fixture/stats`, so a run can tell whether the
 * read-only hook let the read through and refused the write.
 */

type ContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
};
type JsonSchema = { [key: string]: unknown };
type MessageBody = {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: string | ContentBlock[] }>;
  tools?: Array<{ name?: string; input_schema?: JsonSchema }>;
};

/** The text of the last user message, or "" if there is none. */
function lastUserText(body: MessageBody): string {
  const user = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return (user.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** The fixture's reply to a Messages request. */
export function fakeReply(body: MessageBody): string {
  const sums = [...lastUserText(body).matchAll(/PONG and then (\d+) plus (\d+)/g)];
  const sum = sums.at(-1);
  return sum ? `PONG ${Number(sum[1]) + Number(sum[2])}` : "PONG";
}

/** The SDK's structured-output tool, offered when a turn passes `outputFormat`. */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
/** The scripted turn's commands: one the read-only hook admits, one it refuses. */
export const SCRIPTED_COMMANDS = {
  read: "ls -la",
  head: "git rev-parse HEAD",
  write: "touch /tmp/orkestrator-qa-read-only-probe",
} as const;
type ScriptedStep = "read" | "write" | "load" | "output";
const SCRIPTED_TOOL_ID = /^toolu_fixture_(read|write|load|output)_/;

/** Content-free counters a run reads back from `GET /fixture/stats`. */
export interface FakeClaudeApiStats {
  requests: number;
  /** One entry per scripted tool result, in arrival order. */
  results: Array<{ step: ScriptedStep; isError: boolean }>;
}

export function createFakeClaudeApiStats(): FakeClaudeApiStats & { seen: Set<string> } {
  return { requests: 0, results: [], seen: new Set() };
}

export type FakeAction =
  { kind: "text"; text: string } | { kind: "tool"; id: string; name: string; input: unknown };

function resolveRef(ref: string, root: JsonSchema): JsonSchema {
  let node: unknown = root;
  for (const part of ref.replace(/^#\/?/, "").split("/").filter(Boolean)) {
    node = (node as Record<string, unknown> | undefined)?.[part.replaceAll("~1", "/")];
  }
  return (node as JsonSchema | undefined) ?? {};
}

/**
 * The smallest instance of a JSON schema: required properties only, the
 * first enum value or `anyOf` branch that is not `null`, empty arrays (or
 * `minItems` entries), zero (or the minimum) and a short non-empty string.
 */
export function minimalInstance(schema: JsonSchema, root: JsonSchema = schema, depth = 0): unknown {
  if (depth > 32) return null;
  if (typeof schema.$ref === "string") {
    return minimalInstance(resolveRef(schema.$ref, root), root, depth + 1);
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum.find((value) => value !== null) ?? null;
  const branches = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(branches) && branches.length > 0) {
    const branch = branches.find((candidate) => candidate.type !== "null") ?? branches[0]!;
    return minimalInstance(branch, root, depth + 1);
  }
  const type = Array.isArray(schema.type)
    ? (schema.type.find((candidate) => candidate !== "null") ?? "null")
    : schema.type;
  if (type === "object" || (type === undefined && schema.properties)) {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = (schema.required ?? []) as string[];
    return Object.fromEntries(
      required.map((key) => [key, minimalInstance(properties[key] ?? {}, root, depth + 1)]),
    );
  }
  if (type === "array") {
    const count = typeof schema.minItems === "number" ? schema.minItems : 0;
    const items = (schema.items ?? {}) as JsonSchema;
    return Array.from({ length: count }, (_, index) => {
      const item = minimalInstance(items, root, depth + 1);
      return typeof item === "string" ? `${item}-${index + 1}` : item;
    });
  }
  if (type === "integer" || type === "number") {
    if (typeof schema.minimum === "number") return schema.minimum;
    if (typeof schema.exclusiveMinimum === "number") return schema.exclusiveMinimum + 1;
    return 0;
  }
  if (type === "boolean") return false;
  if (type === "string") {
    if (schema.format === "date-time") return "2026-01-01T00:00:00.000Z";
    const length = typeof schema.minLength === "number" ? schema.minLength : 1;
    return "fixture".padEnd(length, "x");
  }
  return null;
}

const RESULT_TOOL_INSTRUCTION = /call the Orkestrator `(submit_[a-z0-9_]+)` tool/g;
const RESULT_KEY = /resultKey "([0-9a-f-]{36})"(?: and capability "([^"]+)")?/;

/** Every user text block of the conversation, the turn's prompt included. */
function userTexts(body: MessageBody): string[] {
  return (body.messages ?? [])
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : (message.content ?? [])
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text!),
    );
}

/**
 * Where the turn's result goes: `StructuredOutput` when offered, else the
 * MCP submit tool its result-tool instruction names. The capability is held
 * only for this reply.
 */
export function resultTarget(body: MessageBody): {
  name: string;
  schema: JsonSchema;
  wrap: (result: unknown) => unknown;
  /** Named in the conversation but not yet loaded into `tools`. */
  deferred?: boolean;
} | null {
  const tools = body.tools ?? [];
  const structured = tools.find((tool) => tool.name === STRUCTURED_OUTPUT_TOOL);
  if (structured) {
    return { name: STRUCTURED_OUTPUT_TOOL, schema: structured.input_schema ?? {}, wrap: (r) => r };
  }
  for (const text of userTexts(body).reverse()) {
    const submit = [...text.matchAll(RESULT_TOOL_INSTRUCTION)].at(-1)?.[1];
    const key = RESULT_KEY.exec(text);
    if (!submit || !key) continue;
    const tool = tools.find(
      (candidate) => candidate.name === submit || candidate.name?.endsWith(`__${submit}`),
    );
    const deferred = tool
      ? undefined
      : new RegExp(`mcp__[A-Za-z0-9_-]+__${submit}\\b`).exec(JSON.stringify(body))?.[0];
    if (!tool?.name && !deferred) return null;
    const properties = (tool?.input_schema?.properties ?? {}) as Record<string, JsonSchema>;
    return {
      name: tool?.name ?? deferred!,
      ...(deferred ? { deferred: true } : {}),
      schema: properties.result ?? {},
      wrap: (result) => ({
        resultKey: key[1],
        ...(key[2] ? { capability: key[2] } : {}),
        result,
      }),
    };
  }
  return null;
}

/**
 * The next scripted action for a Multi Review step's turn (see
 * {@link resultTarget}), or `null` for any other request. Records each
 * scripted tool result once.
 */
export function scriptedAction(
  body: MessageBody,
  stats: FakeClaudeApiStats & { seen: Set<string> } = createFakeClaudeApiStats(),
): FakeAction | null {
  // Tool-result messages continue a turn; a new user prompt starts fresh execution.
  // Keep result-target lookup on the full history so a correction can reuse its key.
  const messages = body.messages ?? [];
  const start = messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      (typeof message.content === "string" ||
        ((message.content ?? []).some((block) => block.type === "text") &&
          !(message.content ?? []).some((block) => block.type === "tool_result"))),
  );
  const target = resultTarget(body);
  if (!target) return null;
  const tools = body.tools ?? [];
  const schema = target.schema;
  const wantsHead = Object.hasOwn((schema.properties ?? {}) as object, "headRef");
  const calls: Array<{ id: string; step: ScriptedStep }> = [];
  const errors = new Map<string, boolean>();
  const outputs = new Map<string, string>();
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const step = block.type === "tool_use" ? SCRIPTED_TOOL_ID.exec(block.id ?? "")?.[1] : null;
      if (step) calls.push({ id: block.id!, step: step as ScriptedStep });
      if (block.type === "tool_result" && block.tool_use_id) {
        errors.set(block.tool_use_id, block.is_error === true);
        const text =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((part) => part.text ?? "").join("\n");
        outputs.set(block.tool_use_id, text);
      }
    }
  }
  for (const call of calls) {
    if (!errors.has(call.id) || stats.seen.has(call.id)) continue;
    stats.seen.add(call.id);
    stats.results.push({ step: call.step, isError: errors.get(call.id)! });
  }
  const turnIds = new Set(
    messages
      .slice(Math.max(0, start))
      .flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "tool_use").map((block) => block.id)
          : [],
      ),
  );
  // Stats span the session, but only this prompt's calls decide its next action.
  const turnCalls = calls.filter((call) => turnIds.has(call.id));
  const tool = (step: ScriptedStep): FakeAction => {
    const id = `toolu_fixture_${step}_${crypto.randomUUID().replaceAll("-", "")}`;
    if (step === "output") {
      const input = minimalInstance(schema) as Record<string, unknown>;
      // The commit the read step printed; held only for this reply.
      const read = turnCalls.find((call) => call.step === "read");
      const head = read ? /\b[0-9a-f]{40}\b/.exec(outputs.get(read.id) ?? "")?.[0] : undefined;
      if (wantsHead && head) input.headRef = head;
      // A plan with no commands must say why (`isReviewValidationPlan`).
      if (wantsHead && Array.isArray(input.limitations) && input.limitations.length === 0) {
        input.limitations = ["Fixture plan: no validation commands."];
      }
      return { kind: "tool", id, name: target.name, input: target.wrap(input) };
    }
    if (step === "load") {
      return { kind: "tool", id, name: "ToolSearch", input: { query: `select:${target.name}` } };
    }
    const command = step === "read" && wantsHead ? SCRIPTED_COMMANDS.head : SCRIPTED_COMMANDS[step];
    return { kind: "tool", id, name: "Bash", input: { command } };
  };
  // Load a deferred tool first: only then is its schema known.
  const done = new Set(turnCalls.map((call) => call.step));
  if (target.deferred) {
    return done.has("load")
      ? { kind: "text", text: "The result tool could not be loaded." }
      : tool("load");
  }
  const hasBash = tools.some((candidate) => candidate.name === "Bash");
  if (hasBash && !done.has("read")) return tool("read");
  if (hasBash && !done.has("write")) return tool("write");
  if (!done.has("output")) return tool("output");
  const submitted = turnCalls.findLast((call) => call.step === "output")!;
  return {
    kind: "text",
    text: errors.get(submitted.id) ? "The result was refused." : "Done.",
  };
}

function message(id: string, model: string, action: FakeAction | string) {
  const step: FakeAction = typeof action === "string" ? { kind: "text", text: action } : action;
  const content =
    step.kind === "tool"
      ? [{ type: "tool_use", id: step.id, name: step.name, input: step.input }]
      : step.text
        ? [{ type: "text", text: step.text }]
        : [];
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: step.kind === "tool" ? "tool_use" : step.text ? "end_turn" : null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: content.length > 0 ? 2 : 1 },
  };
}

/** The server-sent event stream the API answers `stream: true` with. */
export function messageStream(id: string, model: string, action: FakeAction | string): string {
  const step: FakeAction = typeof action === "string" ? { kind: "text", text: action } : action;
  const block =
    step.kind === "tool"
      ? [
          { type: "tool_use", id: step.id, name: step.name, input: {} },
          { type: "input_json_delta", partial_json: JSON.stringify(step.input) },
        ]
      : [
          { type: "text", text: "" },
          { type: "text_delta", text: step.text },
        ];
  const frames: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: message(id, model, "") }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: block[0] }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: block[1] }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: {
          stop_reason: step.kind === "tool" ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 2 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

const defaultStats = createFakeClaudeApiStats();

export async function handleFakeClaudeApi(
  request: Request,
  replyDelayMs = 0,
  stats = defaultStats,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/fixture/stats") {
    return Response.json({ requests: stats.requests, results: stats.results });
  }
  if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
    return Response.json({ input_tokens: 1 });
  }
  if (request.method !== "POST" || url.pathname !== "/v1/messages") {
    return Response.json(
      { type: "error", error: { type: "not_found_error", message: "fixture" } },
      { status: 404 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as MessageBody;
  stats.requests += 1;
  const model = body.model ?? "claude-fixture";
  const id = `msg_fixture_${crypto.randomUUID().replaceAll("-", "")}`;
  const action = scriptedAction(body, stats) ?? fakeReply(body);
  if (replyDelayMs > 0) await Bun.sleep(replyDelayMs);
  if (!body.stream) return Response.json(message(id, model, action));
  return new Response(messageStream(id, model, action), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

if (import.meta.main) {
  const index = process.argv.indexOf("--port");
  const port = Number(index === -1 ? NaN : process.argv[index + 1]);
  if (!Number.isInteger(port) || port <= 0) throw new Error("--port is required");
  const delayIndex = process.argv.indexOf("--reply-delay-ms");
  const replyDelayMs = delayIndex === -1 ? 0 : Number(process.argv[delayIndex + 1]);
  if (!Number.isFinite(replyDelayMs) || replyDelayMs < 0) {
    throw new Error("--reply-delay-ms must be a non-negative number");
  }
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch: (request) => handleFakeClaudeApi(request, replyDelayMs),
  });
}
