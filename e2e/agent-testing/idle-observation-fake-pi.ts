import { piCompletionChunk, piProviderConfig } from "../../scripts/pi-fake-model-shared";
/**
 * A scripted loopback OpenAI chat-completions endpoint for
 * `idle-observation-live.spec.ts` (todo 0049 task 7), so the real pinned Pi
 * bridge and SDK take real turns with no login and nothing billed. Pi reaches
 * it through a provider in the profile's own Pi `models.json`
 * (`piFakeModelsConfig`), the way to-do 0048's soak reaches its fake.
 *
 *   bun idle-observation-fake-pi.ts [--port 0]
 *
 * prints its base URL (`http://127.0.0.1:<port>/v1`) as the first stdout
 * line. Turns follow the Claude fake's script (`scriptedStep`) with Pi's
 * `bash` tool: a prompt asking for a command gets one call, and its result
 * ends the turn with the reply. OpenCode reaches the same endpoint through a
 * custom provider (`idle-observation-fake-models.ts`, todo 0049 task 6); its
 * `bash` tool also takes a description, which the call adds when the offered
 * schema names one. OpenCode 2.x names the same tool `shell` (todo 0008 task 7),
 * so the call uses whichever of the two the request offers, and its schema
 * offers `background`, which a background step sets (todo 0049 task 8). Pi has no sub-agent,
 * background or question tool, so those steps reply in text or run in the
 * foreground. It keeps no request body and logs
 * nothing. A container OpenCode run (todo 0008 task 7) bundles it into one
 * file and serves it on the container's loopback on a fixed `--port`
 * (`installContainerFakeOpenCode`).
 */
import { finalReply, scriptedStep } from "./idle-observation-fake-claude";

export const PI_FAKE_PROVIDER = "idleqa-fake";
export const PI_FAKE_MODEL = "idleqa-1";
/** `provider/modelId`, as a Pi session takes its model. */
export const PI_FAKE_MODEL_REF = `${PI_FAKE_PROVIDER}/${PI_FAKE_MODEL}`;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

type Part = { type?: string; text?: string };
type ChatMessage = { role?: string; content?: string | Part[] | null };
type ChatBody = {
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: Array<{
    function?: { name?: string; parameters?: { properties?: Record<string, unknown> } };
  }>;
};

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** The prompt this request answers, and whether it returns a tool's result. */
export function piRequestState(body: ChatBody): { prompt: string; afterTool: boolean } {
  const messages = body.messages ?? [];
  const afterTool = messages.at(-1)?.role === "tool";
  const prompt = textOf(messages.findLast((message) => message.role === "user")?.content).trim();
  return { prompt, afterTool };
}

/** Shell tools by name: Pi's and OpenCode 1.x's `bash`, OpenCode 2's `shell`. */
const SHELL_TOOLS = ["bash", "shell"];

/** The assistant message for one request: a shell call only when the agent offers one. */
export function piAssistantMessage(
  body: ChatBody,
  id: number,
): { content: string | null; toolCall?: { id: string; name: string; arguments: string } } {
  const { prompt, afterTool } = piRequestState(body);
  const step = scriptedStep(prompt, afterTool);
  const shell = (body.tools ?? []).find((tool) => SHELL_TOOLS.includes(tool.function?.name ?? ""));
  if (step.kind === "shell" && shell) {
    // OpenCode's shell tool also requires a description; Pi's takes the command alone.
    const properties = shell.function?.parameters?.properties;
    const describe = Boolean(properties?.description);
    // OpenCode 2.x's `shell` backgrounds a command itself (`background: true`);
    // Pi's and OpenCode 1.19.5's `bash` offer no such parameter, so they run
    // it in the foreground (todo 0049 task 8).
    const background = step.background && Boolean(properties?.background);
    return {
      content: null,
      toolCall: {
        id: `call_idleqa_${id}`,
        name: shell.function!.name!,
        arguments: JSON.stringify({
          command: step.command,
          ...(describe ? { description: "Run the requested command" } : {}),
          ...(background ? { background: true } : {}),
        }),
      },
    };
  }
  return { content: step.kind === "text" ? step.text : finalReply(prompt) };
}

/** The streamed frames for one assistant message. */
export function piStreamFrames(id: string, message: ReturnType<typeof piAssistantMessage>): string {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const delta = message.toolCall
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            index: 0,
            id: message.toolCall.id,
            type: "function",
            function: { name: message.toolCall.name, arguments: message.toolCall.arguments },
          },
        ],
      }
    : { role: "assistant", content: message.content };
  return (
    piCompletionChunk(PI_FAKE_MODEL, id, delta, null) +
    piCompletionChunk(PI_FAKE_MODEL, id, {}, message.toolCall ? "tool_calls" : "stop", usage) +
    "data: [DONE]\n\n"
  );
}

/** The `models.json` provider that points Pi at this endpoint; its key is a placeholder. */
export function piFakeModelsConfig(baseUrl: string) {
  return piProviderConfig({
    provider: PI_FAKE_PROVIDER,
    providerName: "Idle observation fake",
    baseUrl,
    apiKey: "fixture-only-not-a-key",
    model: PI_FAKE_MODEL,
    modelName: "Idle observation 1",
  });
}

export function startPiFakeModel(platform = { Response: globalThis.Response }, port = 0) {
  const Reply = platform.Response;
  let counter = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        return Reply.json({ object: "list", data: [{ id: PI_FAKE_MODEL, object: "model" }] });
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Reply("not served", { status: 404 });
      }
      let body: ChatBody;
      try {
        if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES)
          throw new Error("too large");
        const text = await request.text();
        if (text.length > MAX_BODY_BYTES) throw new Error("too large");
        body = JSON.parse(text) as ChatBody;
      } catch {
        return new Reply("bad request", { status: 400 });
      }
      counter += 1;
      const id = `chatcmpl-idleqa-${counter}`;
      const message = piAssistantMessage(body, counter);
      if (body.stream === true) {
        return new Reply(piStreamFrames(id, message), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      return Reply.json({
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: PI_FAKE_MODEL,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: message.content,
              ...(message.toolCall
                ? {
                    tool_calls: [
                      {
                        id: message.toolCall.id,
                        type: "function",
                        function: {
                          name: message.toolCall.name,
                          arguments: message.toolCall.arguments,
                        },
                      },
                    ],
                  }
                : {}),
            },
            finish_reason: message.toolCall ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  return server;
}

/** `--port <n>`, or 0 (any free port) when absent or not a port number. */
export function fakePortArgument(argv: readonly string[]): number {
  const index = argv.indexOf("--port");
  const value = index >= 0 ? Number(argv[index + 1]) : 0;
  return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : 0;
}

if ((import.meta as { main?: boolean }).main) {
  const server = startPiFakeModel(undefined, fakePortArgument(process.argv));
  console.log(`http://127.0.0.1:${server.port}/v1`);
}
