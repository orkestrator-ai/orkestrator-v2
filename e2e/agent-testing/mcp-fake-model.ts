/**
 * A scripted loopback model for the MCP qualification specs (todo 0039 tasks
 * 5, 6, 7 and 13), so the real pinned Claude CLI, Codex app-server and Pi SDK
 * take real turns, start and call real MCP servers, with no login and nothing
 * billed. One Bun process serves all three wire protocols on 127.0.0.1:
 *
 * - Anthropic Messages (`POST /v1/messages`) for Claude;
 * - OpenAI Responses over a WebSocket (`/v1/responses`) for Codex;
 * - OpenAI chat completions (`POST /v1/chat/completions`) for Pi, and for
 *   OpenCode through a custom provider (`opencode-fake-provider.ts`).
 *
 *   bun mcp-fake-model.ts
 *
 * prints its origin (`http://127.0.0.1:<port>`) as the first stdout line.
 * What it answers is `mcp-fake-model-script.ts`. It keeps no request body and
 * logs nothing, except with `MCPQ_FAKE_SHAPES=1`: then each request's offered
 * tool names and the script's chosen step kind (never prompt or tool content)
 * go to stderr.
 */
import { codexOutputItem, offeredTools } from "./idle-observation-fake-codex";
import { streamFrames } from "./idle-observation-fake-claude";
import { scriptedStep, type FakeStep, type ToolResult } from "./mcp-fake-model-script";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const SHAPES = process.env.MCPQ_FAKE_SHAPES === "1";

function shapes(protocol: string, tools: readonly string[], step: FakeStep): void {
  if (!SHAPES) return;
  console.error(
    JSON.stringify({
      protocol,
      tools: tools.filter((name) => /^mcp|probe|search|exec|bash/i.test(name)).slice(0, 40),
      toolCount: tools.length,
      step: step.kind,
      ...(step.kind === "tool" ? { name: step.name } : {}),
    }),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withoutReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

// --- Anthropic Messages (Claude) ---

type AnthropicBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: string | AnthropicBlock[];
  is_error?: boolean;
};
type AnthropicMessage = { role?: string; content?: string | AnthropicBlock[] };
export type AnthropicBody = {
  model?: string;
  stream?: boolean;
  messages?: AnthropicMessage[];
  tools?: Array<{ name?: string }>;
};

function blocksText(content: string | AnthropicBlock[] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** The script's view of one Messages request. */
export function anthropicRequest(body: AnthropicBody) {
  const messages = body.messages ?? [];
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id && block.name) names.set(block.id, block.name);
    }
  }
  const isToolReturn = (message: AnthropicMessage) =>
    Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result");
  let promptIndex = -1;
  let prompt = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user" || isToolReturn(message)) continue;
    const raw = blocksText(message.content);
    const text = withoutReminders(raw) || raw.trim();
    if (!text) continue;
    promptIndex = index;
    prompt = text;
    break;
  }
  const results: ToolResult[] = [];
  for (const message of messages.slice(promptIndex + 1)) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      results.push({
        ...(block.tool_use_id && names.has(block.tool_use_id)
          ? { name: names.get(block.tool_use_id)! }
          : {}),
        text: blocksText(block.content),
        ...(block.is_error ? { isError: true } : {}),
      });
    }
  }
  const tools = (body.tools ?? []).map((tool) => tool.name ?? "").filter(Boolean);
  return { prompt, tools, results };
}

/** Response content blocks for one step. */
export function anthropicContent(step: FakeStep, id: number): Array<Record<string, unknown>> {
  if (step.kind === "text") return [{ type: "text", text: step.text }];
  if (step.kind === "code") return [{ type: "text", text: "Done." }];
  const input =
    step.kind === "shell" ? { command: step.command, description: "Run the command" } : step.input;
  return [
    {
      type: "tool_use",
      id: `toolu_mcpq_${id}`,
      name: step.kind === "shell" ? "Bash" : step.name,
      input,
    },
  ];
}

// --- OpenAI chat completions (Pi) ---

type ChatPart = { type?: string; text?: string };
type ChatMessage = {
  role?: string;
  content?: string | ChatPart[] | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
};
export type ChatBody = {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: Array<{
    function?: { name?: string; parameters?: { properties?: Record<string, unknown> } };
  }>;
};

function chatText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** The script's view of one chat-completions request. */
export function chatRequest(body: ChatBody) {
  const messages = body.messages ?? [];
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (call.id && call.function?.name) names.set(call.id, call.function.name);
    }
  }
  const promptIndex = messages.findLastIndex((message) => message.role === "user");
  const raw = promptIndex >= 0 ? chatText(messages[promptIndex]!.content) : "";
  const results: ToolResult[] = messages
    .slice(promptIndex + 1)
    .filter((message) => message.role === "tool")
    .map((message) => ({
      ...(message.tool_call_id && names.has(message.tool_call_id)
        ? { name: names.get(message.tool_call_id)! }
        : {}),
      text: chatText(message.content),
    }));
  const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? "").filter(Boolean);
  return { prompt: withoutReminders(raw) || raw.trim(), tools, results };
}

/** Whether the offered `bash` tool takes a description (OpenCode's does; Pi's does not). */
export function bashTakesDescription(body: ChatBody): boolean {
  const bash = (body.tools ?? []).find((tool) => tool.function?.name === "bash");
  return Boolean(bash?.function?.parameters?.properties?.description);
}

/** The assistant message (text or one tool call) for one step. */
export function chatMessage(step: FakeStep, id: number, options: { describeShell?: boolean } = {}) {
  if (step.kind === "text") return { content: step.text, toolCall: undefined };
  if (step.kind === "code") return { content: "Done.", toolCall: undefined };
  const input =
    step.kind === "shell"
      ? {
          command: step.command,
          ...(options.describeShell ? { description: "Run the requested command" } : {}),
        }
      : step.input;
  return {
    content: undefined,
    toolCall: {
      id: `call_mcpq_${id}`,
      type: "function" as const,
      function: {
        name: step.kind === "shell" ? "bash" : step.name,
        arguments: JSON.stringify(input),
      },
    },
  };
}

function chatResponse(
  body: ChatBody,
  id: number,
  step: FakeStep,
  ResponseType = Response,
): Response {
  const Response = ResponseType;
  const model = String(body.model ?? "mcpq-1");
  const message = chatMessage(step, id, { describeShell: bashTakesDescription(body) });
  const finish = message.toolCall ? "tool_calls" : "stop";
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const created = Math.floor(Date.now() / 1000);
  if (body.stream !== true) {
    return Response.json({
      id: `chatcmpl-mcpq-${id}`,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: message.content ?? null,
            ...(message.toolCall ? { tool_calls: [message.toolCall] } : {}),
          },
          finish_reason: finish,
        },
      ],
      usage,
    });
  }
  const chunk = (delta: Record<string, unknown>, finishReason: string | null, extra = {}) =>
    `data: ${JSON.stringify({
      id: `chatcmpl-mcpq-${id}`,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra,
    })}\n\n`;
  const delta = message.toolCall
    ? { role: "assistant", tool_calls: [{ index: 0, ...message.toolCall }] }
    : { role: "assistant", content: message.content };
  return new Response(`${chunk(delta, null)}${chunk({}, finish, { usage })}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

// --- OpenAI Responses over WebSocket (Codex) ---

type ResponsesItem = {
  type?: string;
  role?: string;
  name?: string;
  namespace?: string;
  call_id?: string;
  output?: unknown;
  content?: string | Array<{ type?: string; text?: string }>;
  tools?: unknown[];
};
type ResponsesFrame = {
  type?: string;
  generate?: boolean;
  input?: ResponsesItem[];
  tools?: unknown[];
};
/** The same frame, typed for the idle fake's helpers. */
const asCodexFrame = (frame: ResponsesFrame) => frame as Parameters<typeof offeredTools>[0];

function responsesText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: unknown })?.text === "string"
            ? (part as { text: string }).text
            : JSON.stringify(part),
      )
      .join("\n");
  }
  return value === undefined ? "" : JSON.stringify(value);
}

/** Names of every offered tool, a namespaced one as `<namespace><name>` too. */
export function responsesToolNames(frame: ResponsesFrame): string[] {
  const names: string[] = [];
  const walk = (tools: readonly unknown[] = [], prefix = "") => {
    for (const raw of tools) {
      const tool = raw as { type?: string; name?: string; tools?: unknown[] };
      if (tool.type === "namespace") walk(tool.tools, `${prefix}${tool.name ?? ""}`);
      else if (tool.name) names.push(prefix ? `${prefix}${tool.name}` : tool.name);
    }
  };
  walk((frame as { tools?: unknown[] }).tools);
  for (const item of frame.input ?? []) {
    if (item.type === "additional_tools") walk(item.tools);
  }
  return names;
}

/** True for the prompts the script answers, so Codex's own context messages are skipped. */
const SCRIPTED =
  /Call the MCP tool|If a tool named|run the command `|reply with exactly|Write every whole number/i;

/**
 * The script's view of one Responses request. `remembered` is the
 * connection's last prompt, for an incremental request carrying only outputs.
 */
export function responsesRequest(
  frame: ResponsesFrame,
  remembered: { prompt: string; tools: string[]; names: Map<string, string> },
  toolsFrame: ResponsesFrame = frame,
) {
  const input = frame.input ?? [];
  for (const item of input) {
    if (item.call_id && item.name) {
      remembered.names.set(item.call_id, `${item.namespace ?? ""}${item.name}`);
    }
  }
  let promptIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]!;
    if (item.role !== "user") continue;
    const text = responsesText(item.content).trim();
    if (SCRIPTED.test(text)) {
      promptIndex = index;
      remembered.prompt = withoutReminders(text) || text;
      break;
    }
  }
  const results: ToolResult[] = input
    .slice(promptIndex + 1)
    .filter((item) => typeof item.type === "string" && item.type.endsWith("_output"))
    .map((item) => ({
      ...(item.call_id && remembered.names.has(item.call_id)
        ? { name: remembered.names.get(item.call_id)! }
        : {}),
      text: responsesText(item.output),
    }));
  const tools = responsesToolNames(toolsFrame);
  if (tools.length > 0) remembered.tools = tools;
  return {
    prompt: remembered.prompt,
    tools: remembered.tools,
    results,
    codeMode: offeredTools(asCodexFrame(toolsFrame)).some(
      (tool) => tool.type === "custom" && tool.name === "exec",
    ),
  };
}

/**
 * The output item for a step. An MCP call goes out as a function call under
 * its namespace when Codex offered one; a shell step reuses the idle fake's
 * command call.
 */
export function responsesOutputItem(
  step: FakeStep,
  frame: ResponsesFrame,
  id: number,
): Record<string, unknown> {
  if (step.kind === "code") {
    return {
      type: "custom_tool_call",
      id: `ctc_mcpq_${id}`,
      call_id: `call_mcpq_${id}`,
      name: "exec",
      input: step.source,
      status: "completed",
    };
  }
  if (step.kind === "tool") {
    let namespace: string | undefined;
    let name = step.name;
    const walk = (tools: readonly unknown[] = [], prefix = "") => {
      for (const raw of tools) {
        const tool = raw as { type?: string; name?: string; tools?: unknown[] };
        if (tool.type === "namespace") walk(tool.tools, `${prefix}${tool.name ?? ""}`);
        else if (prefix && `${prefix}${tool.name}` === step.name) {
          namespace = prefix;
          name = tool.name!;
        }
      }
    };
    walk((frame as { tools?: unknown[] }).tools);
    for (const item of frame.input ?? []) if (item.type === "additional_tools") walk(item.tools);
    return {
      type: "function_call",
      id: `fc_mcpq_${id}`,
      call_id: `call_mcpq_${id}`,
      name,
      ...(namespace ? { namespace } : {}),
      arguments: JSON.stringify(step.input),
      status: "completed",
    };
  }
  return codexOutputItem(
    step.kind === "shell"
      ? { kind: "shell", command: step.command, background: false }
      : { kind: "text", text: step.text },
    offeredTools(asCodexFrame(frame)),
    id,
  );
}

// --- Server ---

async function readJson<T>(request: Request): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new Error("request body too large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("request body too large");
  return (text ? JSON.parse(text) : {}) as T;
}

type SocketData = {
  prompt: string;
  tools: string[];
  frameTools: ResponsesFrame | null;
  names: Map<string, string>;
};

/** The caller owns shutdown. Tests pass Bun's native Response under the DOM preload. */
export function serveMcpFakeModel(ResponseType = Response) {
  const Response = ResponseType;
  let counter = 0;
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, bun) {
      if (
        request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        bun.upgrade(request, {
          data: { prompt: "", tools: [], frameTools: null, names: new Map() },
        })
      ) {
        return undefined;
      }
      const pathname = new URL(request.url).pathname;
      try {
        if (request.method !== "POST") return Response.json({});
        if (pathname.endsWith("/count_tokens")) return Response.json({ input_tokens: 1 });
        if (pathname.endsWith("/chat/completions")) {
          const body = await readJson<ChatBody>(request);
          counter += 1;
          const state = chatRequest(body);
          const step = scriptedStep(state);
          shapes("chat", state.tools, step);
          if (step.kind === "text" && step.delayMs) await sleep(step.delayMs);
          return chatResponse(body, counter, step, ResponseType);
        }
        if (pathname.endsWith("/messages")) {
          const body = await readJson<AnthropicBody>(request);
          counter += 1;
          const state = anthropicRequest(body);
          const step = scriptedStep(state);
          shapes("anthropic", state.tools, step);
          if (step.kind === "text" && step.delayMs) await sleep(step.delayMs);
          const content = anthropicContent(step, counter);
          const id = `msg_mcpq_${counter}`;
          const model = String(body.model ?? "claude-haiku-4-5");
          if (body.stream === true) {
            return new Response(streamFrames(id, model, content), {
              headers: { "content-type": "text/event-stream" },
            });
          }
          const toolCall = content.some((block) => block.type === "tool_use");
          return Response.json({
            id,
            type: "message",
            role: "assistant",
            model,
            content,
            stop_reason: toolCall ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }
        return Response.json({});
      } catch {
        return new Response("bad request", { status: 400 });
      }
    },
    websocket: {
      async message(socket, message) {
        let frame: ResponsesFrame & { type?: string; generate?: boolean };
        try {
          frame = JSON.parse(String(message)) as typeof frame;
        } catch {
          return;
        }
        if (frame.type !== "response.create") return;
        // A continuation does not repeat the tools; keep the connection's last offer.
        // Codex offers them on a prewarm frame (`generate: false`) that is not answered.
        const offered = responsesToolNames(frame);
        if (offered.length > 0) {
          socket.data.frameTools = frame;
          socket.data.tools = offered;
        }
        const id = `resp_${crypto.randomUUID()}`;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        send({ type: "response.created", response: { id } });
        if (frame.generate !== false) {
          counter += 1;
          // The tools come from the connection's last offer, not this frame.
          const state = responsesRequest(frame, socket.data, socket.data.frameTools ?? frame);
          const step = scriptedStep(state);
          shapes("responses", state.tools, step);
          if (step.kind === "text" && step.delayMs) await sleep(step.delayMs);
          const item = responsesOutputItem(step, socket.data.frameTools ?? frame, counter);
          if (item.call_id && (step.kind === "tool" || step.kind === "code")) {
            socket.data.names.set(String(item.call_id), step.kind === "tool" ? step.name : "exec");
          }
          send({ type: "response.output_item.done", output_index: 0, item });
        }
        send({
          type: "response.completed",
          response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        });
      },
    },
  });
  return server;
}

if ((import.meta as { main?: boolean }).main) {
  const server = serveMcpFakeModel();
  console.log(`http://127.0.0.1:${server.port}`);
}
