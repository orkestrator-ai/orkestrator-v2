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
 * Nothing is logged, except with `IDLEQA_FAKE_CODEX_SHAPES=1`: then each
 * request's key names, item types and tool names (never content) go to
 * stderr, which is how the shapes above were found.
 */
import { scriptedStep, type ScriptedStep } from "./idle-observation-fake-claude";

type ContentPart = { type?: string; text?: string };
type Tool = { type?: string; name?: string; tools?: Tool[] };
type InputItem = {
  type?: string;
  role?: string;
  content?: string | ContentPart[];
  tools?: Tool[];
};
type CreateFrame = { type?: string; generate?: boolean; input?: InputItem[]; tools?: Tool[] };

/** Text of a Responses input message. */
function itemText(item: InputItem): string {
  if (typeof item.content === "string") return item.content;
  return (item.content ?? [])
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * The spec prompt this request answers, and whether it returns a command's
 * output. Codex also sends its own context as user messages (environment,
 * instructions); those never match the script, so the latest user message
 * the script recognises wins, else `remembered` (an incremental request that
 * carries only the tool output).
 */
export function codexRequestState(
  input: readonly InputItem[],
  remembered: string,
): { prompt: string; afterTool: boolean } {
  const last = input.at(-1);
  const afterTool = typeof last?.type === "string" && last.type.endsWith("_output");
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]!;
    if (item.role !== "user") continue;
    const text = itemText(item).trim();
    if (/reply with exactly|uppercase form of this text|shell command/i.test(text)) {
      return { prompt: text, afterTool };
    }
  }
  return { prompt: remembered, afterTool };
}

/**
 * Every tool the request offers. Codex 0.166 sends them as an
 * `additional_tools` input item, grouped in namespaces (`functions` holds the
 * code-mode `exec`); a request may also carry a top-level `tools` list.
 */
export function offeredTools(frame: CreateFrame): Tool[] {
  const flatten = (tools: readonly Tool[] = []): Tool[] =>
    tools.flatMap((tool) => (tool.type === "namespace" ? flatten(tool.tools) : [tool]));
  return [
    ...flatten(frame.tools),
    ...(frame.input ?? [])
      .filter((item) => item.type === "additional_tools")
      .flatMap((item) => flatten(item.tools)),
  ];
}

/** One output item for a step, using whichever command tool the request offers. */
export function codexOutputItem(
  step: ScriptedStep,
  tools: readonly Tool[],
  id: number,
): Record<string, unknown> {
  if (step.kind === "shell") {
    const args = { cmd: step.command };
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
    if (tools.some((tool) => tool.name === "exec_command")) {
      return {
        type: "function_call",
        id: `fc_idleqa_${id}`,
        call_id: `call_idleqa_${id}`,
        name: "exec_command",
        arguments: JSON.stringify(args),
        status: "completed",
      };
    }
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

function serve(): void {
  let sampled = 0;
  const server = Bun.serve<{ prompt: string; tools: Tool[] }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      if (
        request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        bun.upgrade(request, { data: { prompt: "", tools: [] } })
      ) {
        return undefined;
      }
      return new Response("not served", { status: 404 });
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
        if (frame.type !== "response.create") return;
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
          const item = codexOutputItem(
            scriptedStep(state.prompt, state.afterTool),
            socket.data.tools,
            sampled,
          );
          send({ type: "response.output_item.done", output_index: 0, item });
        }
        send({
          type: "response.completed",
          response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
        });
      },
    },
  });
  console.log(`http://127.0.0.1:${server.port}/v1`);
}

if ((import.meta as { main?: boolean }).main) serve();
