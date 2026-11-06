/**
 * A loopback Anthropic Messages endpoint for credential-free qualification of
 * the real Claude CLI behind a `dev:test` profile.
 *
 * Point the profile's isolated Claude config at it (`fakeModelClaudeSettings`)
 * and every model call the CLI makes lands here instead of Anthropic. Each
 * call answers `Answer to: <last prompt>`, so a prompt the CLI delivered twice
 * shows as two calls carrying it. A prompt containing `[hold:<id>]` is parked
 * until `release(<id>)`, which places a turn at "provider is working" for as
 * long as a scenario needs (a restart, a disconnect). A parked call whose
 * client goes away is recorded as `aborted`.
 *
 * Runs under Node (the Playwright spec) as well as Bun: `node:http` only.
 * Prompts are kept in memory for the run; they are fixture strings, and never
 * written to test output.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeModelCall {
  /** Monotonic order of arrival. */
  index: number;
  /** The last user prompt the call carried, `""` when it had none. */
  prompt: string;
  /** The hold id from the prompt, when it asked to be parked. */
  hold?: string;
  /**
   * User prompts the call carried as context, so a continued conversation
   * shows its earlier prompts and a fresh one shows only the last.
   */
  userPrompts: number;
  /** In-memory fixture context; never write this to evidence. */
  context: string[];
  receivedAt: number;
  answeredAt?: number;
  aborted?: boolean;
}

export interface FakeAnthropicModel {
  origin: string;
  calls(): FakeModelCall[];
  /** Calls whose prompt contains `marker`. */
  callsWith(marker: string): FakeModelCall[];
  /** Ids currently parked. */
  held(): string[];
  /** Releases every parked call with this id; future calls with it pass. */
  release(id: string): void;
  stop(): Promise<void>;
}

const MAX_CALLS = 2_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const HOLD_PATTERN = /\[hold:([a-z0-9-]{1,64})\]/i;

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

/**
 * The prompt a Messages request is answering: the text of its last user
 * message, without the `<system-reminder>` blocks the CLI prepends.
 */
export function lastUserPrompt(body: unknown): string {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | null;
    if (message?.role !== "user") continue;
    return textOfContent(message.content)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
      .trim();
  }
  return "";
}

/** User messages that carry text (tool results alone are not prompts). */
export function userPromptCount(body: unknown): number {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return 0;
  return messages.filter((message) => {
    const entry = message as { role?: unknown; content?: unknown } | null;
    return entry?.role === "user" && textOfContent(entry.content).trim().length > 0;
  }).length;
}

export function holdIdOf(prompt: string): string | undefined {
  return HOLD_PATTERN.exec(prompt)?.[1]?.toLowerCase();
}

/** One assistant text message as the SSE frames the Messages API streams. */
export function messageStreamFrames(id: string, model: string, text: string): string {
  const message = {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const events: Array<{ type: string } & Record<string, unknown>> = [
    { type: "message_start", message },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

export function answerFor(prompt: string): string {
  return `Answer to: ${prompt}`;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export async function startFakeAnthropicModel(port = 0): Promise<FakeAnthropicModel> {
  const calls: FakeModelCall[] = [];
  const released = new Set<string>();
  const waiters = new Map<string, Set<() => void>>();
  let counter = 0;

  const waitForRelease = (id: string, response: ServerResponse) =>
    new Promise<boolean>((resolve) => {
      if (released.has(id)) return resolve(true);
      const set = waiters.get(id) ?? new Set();
      const wake = () => {
        set.delete(wake);
        resolve(true);
      };
      set.add(wake);
      waiters.set(id, set);
      response.once("close", () => {
        if (!set.has(wake)) return;
        set.delete(wake);
        resolve(false);
      });
    });

  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fake").pathname;
    try {
      if (request.method !== "POST") {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      const body = await readBody(request);
      if (pathname.endsWith("/count_tokens")) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      if (!pathname.endsWith("/messages")) {
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      const prompt = lastUserPrompt(body);
      const hold = holdIdOf(prompt);
      counter += 1;
      const call: FakeModelCall = {
        index: counter,
        prompt,
        ...(hold ? { hold } : {}),
        userPrompts: userPromptCount(body),
        context: (
          (body as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? []
        )
          .filter((message) => message.role === "user")
          .map((message) => lastUserPrompt({ messages: [message] })),
        receivedAt: Date.now(),
      };
      if (calls.length >= MAX_CALLS) calls.shift();
      calls.push(call);
      if (hold && !(await waitForRelease(hold, response))) {
        call.aborted = true;
        return;
      }
      const model = String((body as { model?: unknown }).model ?? "claude-haiku-4-5");
      const text = answerFor(prompt);
      call.answeredAt = Date.now();
      if ((body as { stream?: unknown }).stream === true) {
        response
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(messageStreamFrames(`msg_fake_${counter}`, model, text));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: `msg_fake_${counter}`,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    } catch {
      if (!response.headersSent) response.writeHead(400).end();
      else response.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const bound = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${bound}`,
    calls: () => calls.map((call) => ({ ...call })),
    callsWith: (marker) => calls.filter((call) => call.prompt.includes(marker)),
    held: () => [...waiters.entries()].filter(([, set]) => set.size > 0).map(([id]) => id),
    release(id) {
      const key = id.toLowerCase();
      released.add(key);
      for (const wake of Array.from(waiters.get(key) ?? [])) wake();
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const key of Array.from(waiters.keys())) released.add(key);
        for (const set of Array.from(waiters.values())) for (const wake of Array.from(set)) wake();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The `settings.json` that sends a profile's Claude CLI to this endpoint with
 * a fixture key. Written into the profile's isolated `CLAUDE_CONFIG_DIR`
 * only, never a real Claude home.
 */
export function fakeModelClaudeSettings(origin: string): Record<string, unknown> {
  return {
    env: {
      ANTHROPIC_BASE_URL: origin,
      ANTHROPIC_API_KEY: "fixture-only-not-a-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      DISABLE_AUTOUPDATER: "1",
    },
  };
}
