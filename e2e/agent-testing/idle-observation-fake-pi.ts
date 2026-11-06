/**
 * A scripted loopback OpenAI chat-completions endpoint for
 * `idle-observation-live.spec.ts` (todo 0049 task 7), so the real pinned Pi
 * bridge and SDK take real turns with no login and nothing billed. Pi reaches
 * it through a provider in the profile's own Pi `models.json`
 * (`piFakeModelsConfig`), the way to-do 0048's soak reaches its fake.
 *
 *   bun idle-observation-fake-pi.ts
 *
 * prints its base URL (`http://127.0.0.1:<port>/v1`) as the first stdout
 * line. Turns follow the Claude fake's script (`scriptedStep`) with Pi's
 * `bash` tool: a prompt asking for a command gets one call, and its result
 * ends the turn with the reply. Pi has no sub-agent, background or question
 * tool, so those steps reply in text. It keeps no request body and logs
 * nothing.
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
  tools?: Array<{ function?: { name?: string } }>;
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

/** The assistant message for one request: a `bash` call only when Pi offers it. */
export function piAssistantMessage(
  body: ChatBody,
  id: number,
): { content: string | null; toolCall?: { id: string; name: string; arguments: string } } {
  const { prompt, afterTool } = piRequestState(body);
  const step = scriptedStep(prompt, afterTool);
  const bash = (body.tools ?? []).some((tool) => tool.function?.name === "bash");
  if (step.kind === "shell" && bash) {
    return {
      content: null,
      toolCall: {
        id: `call_idleqa_${id}`,
        name: "bash",
        arguments: JSON.stringify({ command: step.command }),
      },
    };
  }
  return { content: step.kind === "text" ? step.text : finalReply(prompt) };
}

function chunk(id: string, delta: Record<string, unknown>, finish: string | null, usage?: object) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: PI_FAKE_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
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
    chunk(id, delta, null) +
    chunk(id, {}, message.toolCall ? "tool_calls" : "stop", usage) +
    "data: [DONE]\n\n"
  );
}

/** The `models.json` provider that points Pi at this endpoint; its key is a placeholder. */
export function piFakeModelsConfig(baseUrl: string) {
  return {
    providers: {
      [PI_FAKE_PROVIDER]: {
        name: "Idle observation fake",
        baseUrl,
        api: "openai-completions",
        apiKey: "fixture-only-not-a-key",
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: true,
          maxTokensField: "max_tokens",
        },
        models: [
          {
            id: PI_FAKE_MODEL,
            name: "Idle observation 1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32_000,
            maxTokens: 256,
          },
        ],
      },
    },
  };
}

function serve(): void {
  let counter = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: PI_FAKE_MODEL, object: "model" }] });
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not served", { status: 404 });
      }
      let body: ChatBody;
      try {
        const text = await request.text();
        if (text.length > MAX_BODY_BYTES) throw new Error("too large");
        body = JSON.parse(text) as ChatBody;
      } catch {
        return new Response("bad request", { status: 400 });
      }
      counter += 1;
      const id = `chatcmpl-idleqa-${counter}`;
      const message = piAssistantMessage(body, counter);
      if (body.stream === true) {
        return new Response(piStreamFrames(id, message), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      return Response.json({
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
  console.log(`http://127.0.0.1:${server.port}/v1`);
}

if ((import.meta as { main?: boolean }).main) serve();
