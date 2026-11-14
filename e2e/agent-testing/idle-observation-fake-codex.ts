/**
 * A scripted loopback stand-in for OpenAI's Responses WebSocket, for
 * `idle-observation-live.spec.ts` (todo 0049 task 1), so the real pinned
 * Codex app-server and bridge take real turns with no login and nothing
 * billed. Run with Bun (specs run under Node, which has no WebSocket server):
 *
 *   bun idle-observation-fake-codex.ts
 *
 * prints its base URL (`http://127.0.0.1:<port>/v1`) as the first stdout
 * line; the spec writes it to the profile's own Codex `openai_base_url`.
 * Turns follow the same script as the Claude fake (`scriptedStep`): a prompt
 * asking for a shell command gets one command call, and its output ends the
 * turn with the reply. Codex 0.166 offers its tools once per connection, in
 * an `additional_tools` input item, and continues later requests with
 * `previous_response_id`, so the tools are remembered per connection.
 *
 * Beyond commands (todo 0049 tasks 3, 5 and 8): an async question is one
 * `request_user_input_async` call, which returns at once, so the turn goes on
 * to its reply; a sub-agent is a `spawn_agent` call (no parent history) and,
 * once it returns, one `wait_agent` call before the reply; and a background
 * command runs through `exec_command` with a 1 s yield, so it is still running
 * when the turn ends. A call's name is remembered by its id per connection to
 * tell those outputs apart.
 *
 * Nothing is logged, except with `IDLEQA_FAKE_CODEX_SHAPES=1`: then each
 * request's key names, item types and tool names (never content) go to
 * stderr, which is how the shapes above were found. `IDLEQA_FAKE_CODEX_SHAPES=schemas`
 * prints Codex's own tool definitions and their namespace layout instead
 * (still no request content), which is how the multi-agent tools were found.
 * It serves the Claude fake's marker watch (`MARKER_WATCH_PATH`) over plain
 * HTTP, counting each `response.create` frame.
 */
import {
  MARKER_WATCH_PATH,
  NO_SUBAGENT_REPLY,
  createMarkerWatch,
  markerWatchResponse,
  scriptedStep,
  type ScriptedStep,
} from "./idle-observation-fake-claude";

type ContentPart = { type?: string; text?: string; encrypted_content?: string };
type Tool = { type?: string; name?: string; tools?: Tool[]; namespace?: string };
type InputItem = {
  type?: string;
  role?: string;
  content?: string | ContentPart[];
  tools?: Tool[];
  call_id?: string;
};
type CreateFrame = { type?: string; generate?: boolean; input?: InputItem[]; tools?: Tool[] };

/**
 * Text of a Responses input message. A multi-agent message's task travels as
 * `encrypted_content`, which a local app-server leaves as plain text.
 */
function itemText(item: InputItem): string {
  if (typeof item.content === "string") return item.content;
  return (item.content ?? [])
    .map((part) => part.text ?? part.encrypted_content)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/**
 * Multi-agent v2 mail between threads: a child's task arrives as a
 * `NEW_TASK` agent message, and a child's answer reaches its parent as a
 * `FINAL_ANSWER` one. The kind, and the payload after its header.
 */
function agentMail(item: InputItem): { kind: string; payload: string } | null {
  if (item.type !== "agent_message") return null;
  const text = itemText(item);
  const kind = /^Message Type: (\w+)/m.exec(text)?.[1];
  if (!kind) return null;
  return { kind, payload: text.replace(/^[\s\S]*?^Payload:\n?/m, "").trim() };
}

/**
 * The spec prompt this request answers, and whether it returns a tool's
 * outcome: a call's output, or a sub-agent's final answer. Codex also sends
 * its own context as user messages (environment, instructions); those never
 * match the script, so the latest user message (or a child's task) the
 * script recognises wins, else `remembered` (an incremental request that
 * carries only the tool output).
 */
export function codexRequestState(
  input: readonly InputItem[],
  remembered: string,
): { prompt: string; afterTool: boolean } {
  const last = input.at(-1);
  const afterTool =
    (typeof last?.type === "string" && last.type.endsWith("_output")) ||
    (last !== undefined && agentMail(last)?.kind === "FINAL_ANSWER");
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]!;
    const mail = agentMail(item);
    if (item.role !== "user" && mail?.kind !== "NEW_TASK") continue;
    const text = mail ? mail.payload : itemText(item).trim();
    if (
      /reply with exactly|uppercase form of this text|shell command|^Answers to your questions:/im.test(
        text,
      )
    ) {
      return { prompt: text, afterTool };
    }
  }
  return { prompt: remembered, afterTool };
}

/**
 * Every tool the request offers. Codex 0.166 sends them as an
 * `additional_tools` input item, grouped in namespaces (`functions` holds the
 * code-mode `exec` and the question tools, `collaboration` the sub-agent
 * tools); a request may also carry a top-level `tools` list. Each tool keeps
 * its namespace, which a call outside `functions` must name.
 */
export function offeredTools(frame: CreateFrame): Tool[] {
  const flatten = (tools: readonly Tool[] = [], namespace?: string): Tool[] =>
    tools.flatMap((tool) =>
      tool.type === "namespace"
        ? flatten(tool.tools, tool.name)
        : [namespace ? { ...tool, namespace } : tool],
    );
  return [
    ...flatten(frame.tools),
    ...(frame.input ?? [])
      .filter((item) => item.type === "additional_tools")
      .flatMap((item) => flatten(item.tools)),
  ];
}

function functionCall(
  name: string,
  args: unknown,
  id: number,
  tools: readonly Tool[],
): Record<string, unknown> {
  // Codex answers "unsupported call" to a tool outside `functions` named bare.
  const namespace = tools.find((tool) => tool.name === name)?.namespace;
  return {
    type: "function_call",
    id: `fc_idleqa_${id}`,
    call_id: `call_idleqa_${id}`,
    name,
    ...(namespace && namespace !== "functions" ? { namespace } : {}),
    arguments: JSON.stringify(args),
    status: "completed",
  };
}

/**
 * The step after a tool's output: a spawned sub-agent is waited for once,
 * every other output ends the turn with the reply.
 */
export function codexFollowUp(
  prompt: string,
  finishedTool: string | undefined,
): ScriptedStep | "wait" {
  if (finishedTool === "spawn_agent") return "wait";
  return scriptedStep(prompt, true);
}

/** One output item for a step, using whichever tool the request offers for it. */
export function codexOutputItem(
  step: ScriptedStep | "wait",
  tools: readonly Tool[],
  id: number,
): Record<string, unknown> {
  const offers = (name: string) => tools.some((tool) => tool.name === name);
  if (step === "wait") return functionCall("wait_agent", { timeout_ms: 30_000 }, id, tools);
  if (step.kind === "question" && offers("request_user_input_async")) {
    return functionCall(
      "request_user_input_async",
      { questions: [{ title: step.title, options: step.options }] },
      id,
      tools,
    );
  }
  if (step.kind === "subagent") {
    if (!offers("spawn_agent"))
      return codexOutputItem({ kind: "text", text: NO_SUBAGENT_REPLY }, tools, id);
    return functionCall(
      "spawn_agent",
      { task_name: `idleqa_child_${id}`, message: step.task, fork_turns: "none" },
      id,
      tools,
    );
  }
  if (step.kind === "shell") {
    // A background command yields after 1 s, so it outlives the turn.
    const args = step.background
      ? { cmd: step.command, yield_time_ms: 1_000 }
      : { cmd: step.command };
    if (tools.some((tool) => tool.type === "custom" && tool.name === "exec")) {
      return {
        type: "custom_tool_call",
        id: `ctc_idleqa_${id}`,
        call_id: `call_idleqa_${id}`,
        name: "exec",
        input: `text(JSON.stringify(await tools.exec_command(${JSON.stringify(args)})));`,
        status: "completed",
      };
    }
    if (offers("exec_command")) return functionCall("exec_command", args, id, tools);
  }
  const text = step.kind === "text" ? step.text : "Done.";
  return {
    type: "message",
    id: `msg_idleqa_${id}`,
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
    status: "completed",
  };
}

/** `platform` supplies `Response`, which a test's DOM preload replaces globally. */
export function startCodexFakeModel(
  onCalls?: (calls: ReadonlyMap<string, string>) => void,
  platform = { Response: globalThis.Response },
) {
  const Reply = platform.Response;
  let sampled = 0;
  const markers = createMarkerWatch();
  const server = Bun.serve<{
    prompt: string;
    tools: Tool[];
    calls: Map<string, string>;
    spawned: number;
  }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      const url = new URL(request.url);
      if (url.pathname === MARKER_WATCH_PATH) {
        const answer = markerWatchResponse(markers, request.method, url.searchParams);
        return Reply.json(answer.body, { status: answer.status });
      }
      if (
        request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        bun.upgrade(request, { data: { prompt: "", tools: [], calls: new Map(), spawned: 0 } })
      ) {
        return undefined;
      }
      return new Reply("not served", { status: 404 });
    },
    websocket: {
      message(socket, message) {
        let frame: CreateFrame;
        try {
          frame = JSON.parse(String(message)) as CreateFrame;
        } catch {
          return;
        }
        if (process.env.IDLEQA_FAKE_CODEX_SHAPES === "1") {
          // Shape only, never content: key names and item types.
          console.error(
            JSON.stringify({
              keys: Object.keys(frame),
              items: (frame.input ?? []).map((item) => `${item.type ?? "?"}:${item.role ?? "-"}`),
              tools: offeredTools(frame).map((tool) => `${tool.type ?? "?"}:${tool.name ?? "?"}`),
              recognised: Boolean(codexRequestState(frame.input ?? [], socket.data.prompt).prompt),
            }),
          );
        }
        if (process.env.IDLEQA_FAKE_CODEX_SHAPES === "schemas") {
          for (const tool of offeredTools(frame)) console.error(JSON.stringify(tool));
          const layout = (tools: readonly Tool[] = []): unknown[] =>
            tools.map((tool) =>
              tool.type === "namespace" ? { [tool.name ?? "?"]: layout(tool.tools) } : tool.name,
            );
          console.error(
            JSON.stringify({
              layout: [
                ...layout(frame.tools),
                ...(frame.input ?? []).flatMap((item) => layout(item.tools)),
              ],
            }),
          );
        }
        if (frame.type !== "response.create") return;
        markers.observe(frame);
        // A request continuing an earlier response (`previous_response_id`)
        // does not repeat the tools; the connection's first request offered them.
        const offered = offeredTools(frame);
        if (offered.length > 0) socket.data.tools = offered;
        const id = `resp_${crypto.randomUUID()}`;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        send({ type: "response.created", response: { id } });
        if (frame.generate !== false) {
          sampled += 1;
          const state = codexRequestState(frame.input ?? [], socket.data.prompt);
          socket.data.prompt = state.prompt;
          const finished = frame.input?.at(-1)?.call_id;
          let step = state.afterTool
            ? codexFollowUp(state.prompt, finished ? socket.data.calls.get(finished) : undefined)
            : scriptedStep(state.prompt, false);
          // A script mistake must never fork children without end.
          if (step !== "wait" && step.kind === "subagent" && ++socket.data.spawned > 2) {
            step = { kind: "text", text: NO_SUBAGENT_REPLY };
          }
          const item = codexOutputItem(step, socket.data.tools, sampled);
          if (typeof item.call_id === "string" && typeof item.name === "string") {
            socket.data.calls.set(item.call_id, item.name);
            // Bounded: only the latest calls are ever looked up.
            if (socket.data.calls.size > 64) {
              socket.data.calls.delete(socket.data.calls.keys().next().value!);
            }
          }
          onCalls?.(socket.data.calls);
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
  const server = startCodexFakeModel();
  console.log(`http://127.0.0.1:${server.port}/v1`);
}
