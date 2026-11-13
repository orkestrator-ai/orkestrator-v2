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
 * client goes away is recorded as `aborted`, as is a stream it leaves. A prompt containing
 * `[stream:<n>]` is answered as `n` further fixture lines, one text delta
 * every `STREAM_DELTA_INTERVAL_MS`, so a turn streams for a while and the
 * transcript is patched many times (`remote-bandwidth-live.spec.ts` measures
 * those bytes).
 * A prompt containing `[bash:<word>]` is answered with one `Bash` tool call
 * that writes `<word>.txt` in the working directory (a write, because Claude
 * Code runs a read-only command such as a bare `printf` without asking), so a
 * session in an "ask" mode parks an approval; the CLI's follow-up with the
 * tool result is answered like any other call.
 *
 * Three more behaviours serve specs that need the CLI to produce particular
 * transcript parts (`transcript-parts-live.spec.ts`, the `graph-profiles`
 * scenario's credential-free run):
 *
 * - `[script:<id>]` plays the tool calls registered under `<id>` in
 *   {@link FakeAnthropicModelOptions.toolScripts}, one per model call: step
 *   `n` answers the call that carries `n` tool results after the prompt, and
 *   once the steps run out the turn ends with `answerFor(<prompt>)`. A step
 *   whose tool starts with `*` names the offered tool ending in the rest (a
 *   workflow result tool's server prefix is not known in advance); when no
 *   offered tool matches, the bare rest is called, so the CLI's refusal of an
 *   absent tool becomes part of the evidence.
 * - `[retry:<id>:<n>]` answers the first `n` calls of that prompt with HTTP
 *   500, so the CLI retries and reports each retry.
 * - Every call records how many image blocks its user messages carried and
 *   which tools it offered, so an image round trip and a turn's tool surface
 *   can be checked without reading content.
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
  /** When a `[stream:<n>]` answer wrote its last frame; absent when it never did. */
  streamedAt?: number;
  /** The client went away while the call was held or still streaming. */
  aborted?: boolean;
  /** Image blocks in the call's user messages, tool results included. */
  images: number;
  /** Names of the tools the call offered, at most {@link MAX_RECORDED_TOOLS}. */
  tools: string[];
  /** The `[script:<id>]` the call belonged to, the step it got and the tool that step called. */
  script?: { id: string; step: number; tool?: string };
  /** The HTTP status of an error answer (a `[retry:…]` failure). */
  failedWith?: number;
}

/** One scripted tool call of a `[script:<id>]` turn. */
export interface FakeToolStep {
  /** The tool's exact name, or `*<suffix>` for the offered tool ending in `<suffix>`. */
  tool: string;
  /** Called instead of the bare suffix when no offered tool ends in it (a deferred MCP tool). */
  fallback?: string;
  /**
   * The call's input. The string `{{resultKey}}` anywhere in it becomes the
   * workflow result key the turn's instructions quote, so a script can submit
   * a result the way a model following those instructions would.
   */
  input: Record<string, unknown>;
}

export interface FakeAnthropicModelOptions {
  /** The scripts `[script:<id>]` prompts play, keyed by lower-case id. */
  toolScripts?: Readonly<Record<string, readonly FakeToolStep[]>>;
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
const STREAM_PATTERN = /\[stream:(\d{1,5})\]/i;
const BASH_PATTERN = /\[bash:([a-z0-9-]{1,64})\]/i;
const SCRIPT_PATTERN = /\[script:([a-z0-9-]{1,64})\]/i;
const RETRY_PATTERN = /\[retry:([a-z0-9-]{1,64}):(\d{1,2})\]/i;
/** Tool names one call records at most. */
export const MAX_RECORDED_TOOLS = 256;
/** The most failures one `[retry:<id>:<n>]` asks for. */
export const MAX_RETRY_FAILURES = 5;
/** The most deltas one `[stream:<n>]` answer sends. */
export const MAX_STREAM_DELTAS = 2_000;
/** The pause between two deltas of a streamed answer. */
export const STREAM_DELTA_INTERVAL_MS = 25;

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

/** The word a `[bash:<word>]` prompt asks the `Bash` tool to print, if any. */
export function bashWordOf(prompt: string): string | undefined {
  return BASH_PATTERN.exec(prompt)?.[1];
}

/** Whether the request's last user message carries a tool result (a follow-up). */
export function endsWithToolResult(body: unknown): boolean {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return false;
  const last = messages.at(-1) as { role?: unknown; content?: unknown } | undefined;
  return (
    last?.role === "user" &&
    Array.isArray(last.content) &&
    last.content.some((block) => (block as { type?: unknown } | null)?.type === "tool_result")
  );
}

/** One assistant message that calls `Bash` once, as streamed SSE frames. */
export function toolUseStreamFrames(id: string, model: string, command: string): string {
  return toolCallStreamFrames(id, model, "Bash", {
    command,
    description: "Print a fixture word",
  });
}

/** One assistant message that calls `name` once with `input`, as streamed SSE frames. */
export function toolCallStreamFrames(
  id: string,
  model: string,
  name: string,
  input: Record<string, unknown>,
): string {
  const events: Array<{ type: string } & Record<string, unknown>> = [
    messageStart(id, model),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: `toolu_${id}`, name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return events.map(frame).join("");
}

function userMessages(body: unknown): Array<{ content?: unknown }> {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (message): message is { role: string; content?: unknown } =>
      (message as { role?: unknown } | null)?.role === "user",
  );
}

function blocksOf(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> => !!block && typeof block === "object",
      )
    : [];
}

/**
 * The prompt that started the current turn: the last user message with text
 * (a follow-up carrying only tool results is not one), without reminders.
 */
export function turnPrompt(body: unknown): string {
  for (const message of userMessages(body).reverse()) {
    const text = lastUserPrompt({ messages: [{ role: "user", content: message.content }] });
    if (text) return text;
  }
  return "";
}

/** Tool results the conversation carries after {@link turnPrompt}: the step a script is on. */
export function toolResultsSinceTurnPrompt(body: unknown): number {
  let count = 0;
  for (const message of userMessages(body).reverse()) {
    if (lastUserPrompt({ messages: [{ role: "user", content: message.content }] })) break;
    count += blocksOf(message.content).filter((block) => block.type === "tool_result").length;
  }
  return count;
}

/** Image blocks in every user message, inside tool results too. */
export function imageBlockCount(body: unknown): number {
  let count = 0;
  const visit = (content: unknown) => {
    for (const block of blocksOf(content)) {
      if (block.type === "image") count += 1;
      else if (block.type === "tool_result") visit(block.content);
    }
  };
  for (const message of userMessages(body)) visit(message.content);
  return count;
}

/** The names of the tools a request offered, bounded. */
export function offeredToolNames(body: unknown): string[] {
  const tools = (body as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => (tool as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === "string")
    .slice(0, MAX_RECORDED_TOOLS);
}

/** The script id a `[script:<id>]` prompt plays, lower-cased. */
export function scriptIdOf(prompt: string): string | undefined {
  return SCRIPT_PATTERN.exec(prompt)?.[1]?.toLowerCase();
}

/** The retry id and failure count (at most {@link MAX_RETRY_FAILURES}) of a `[retry:<id>:<n>]` prompt. */
export function retryOf(prompt: string): { id: string; failures: number } | undefined {
  const match = RETRY_PATTERN.exec(prompt);
  if (!match) return undefined;
  return { id: match[1]!.toLowerCase(), failures: Math.min(MAX_RETRY_FAILURES, Number(match[2])) };
}

/**
 * The tool a script step calls: its exact name, or for `*<suffix>` the first
 * offered tool ending in `<suffix>`, else the bare suffix.
 */
export function resolveStepTool(step: FakeToolStep, offered: readonly string[]): string {
  if (!step.tool.startsWith("*")) return step.tool;
  const suffix = step.tool.slice(1);
  return offered.find((name) => name.endsWith(suffix)) ?? step.fallback ?? suffix;
}

const RESULT_KEY_PATTERN =
  /resultKey\W{1,4}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** The workflow result key a request's instructions quote, if any. */
export function quotedResultKey(body: unknown): string | undefined {
  return RESULT_KEY_PATTERN.exec(JSON.stringify(body ?? null))?.[1];
}

/** A step's input with `{{resultKey}}` replaced by the key the request quotes. */
export function resolveStepInput(step: FakeToolStep, body: unknown): Record<string, unknown> {
  const raw = JSON.stringify(step.input);
  if (!raw.includes("{{resultKey}}")) return step.input;
  const key = quotedResultKey(body);
  return key
    ? (JSON.parse(raw.replaceAll("{{resultKey}}", key)) as Record<string, unknown>)
    : step.input;
}

/** The number of extra lines a `[stream:<n>]` prompt asks for, bounded. */
export function streamDeltaCountOf(prompt: string): number {
  const match = STREAM_PATTERN.exec(prompt);
  return match ? Math.min(MAX_STREAM_DELTAS, Number(match[1])) : 0;
}

/**
 * The text deltas of a streamed answer: `answerFor(prompt)` first, then one
 * build-log-like fixture line per delta (repetitive, as real output is), so
 * the joined answer still starts with `answerFor(prompt)`.
 */
export function streamedAnswerDeltas(prompt: string, count: number): string[] {
  const deltas = [answerFor(prompt)];
  for (let index = 1; index <= count; index += 1) {
    deltas.push(
      `\n- step ${index} of ${count}: compiled module-${index % 37} in ${(index * 7) % 113} ms, ` +
        `all checks passed for package-${index % 11}`,
    );
  }
  return deltas;
}

function frame(event: { type: string } & Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function messageStart(id: string, model: string) {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

const MESSAGE_END_EVENTS: Array<{ type: string } & Record<string, unknown>> = [
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
];

/**
 * Writes one assistant text message as paced SSE frames, one text delta per
 * `intervalMs`. Stops early, without throwing, when the client goes away, and
 * answers whether the whole message was written.
 */
async function writePacedStream(
  response: ServerResponse,
  id: string,
  model: string,
  deltas: readonly string[],
  intervalMs: number,
): Promise<boolean> {
  let gone = false;
  response.once("close", () => {
    if (!response.writableFinished) gone = true;
  });
  const left = () => gone || response.destroyed;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(frame(messageStart(id, model)));
  response.write(
    frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  );
  for (const [index, text] of deltas.entries()) {
    if (left()) return false;
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (left()) return false;
    response.write(
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    );
  }
  if (left()) return false;
  response.end(MESSAGE_END_EVENTS.map(frame).join(""));
  return true;
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

export async function startFakeAnthropicModel(
  port = 0,
  options: FakeAnthropicModelOptions = {},
): Promise<FakeAnthropicModel> {
  const calls: FakeModelCall[] = [];
  const scripts = options.toolScripts ?? {};
  /** `[retry:<id>:<n>]` failures already answered, per id. */
  const retryFailures = new Map<string, number>();
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
        images: imageBlockCount(body),
        tools: offeredToolNames(body),
      };
      if (calls.length >= MAX_CALLS) calls.shift();
      calls.push(call);
      if (hold && !(await waitForRelease(hold, response))) {
        call.aborted = true;
        return;
      }
      const model = String((body as { model?: unknown }).model ?? "claude-haiku-4-5");
      const streaming = (body as { stream?: unknown }).stream === true;
      const started = turnPrompt(body);
      const retry = prompt ? retryOf(prompt) : undefined;
      if (retry && (retryFailures.get(retry.id) ?? 0) < retry.failures) {
        retryFailures.set(retry.id, (retryFailures.get(retry.id) ?? 0) + 1);
        call.failedWith = 500;
        call.answeredAt = Date.now();
        response.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: "Fixture failure, retry the request" },
          }),
        );
        return;
      }
      const scriptId = scriptIdOf(started);
      const steps = scriptId ? scripts[scriptId] : undefined;
      if (scriptId && steps) {
        const stepIndex = toolResultsSinceTurnPrompt(body);
        const step = steps[stepIndex];
        call.answeredAt = Date.now();
        if (step) {
          const tool = resolveStepTool(step, call.tools);
          call.script = { id: scriptId, step: stepIndex, tool };
          const id = `msg_fake_${counter}`;
          if (streaming) {
            response
              .writeHead(200, { "content-type": "text/event-stream" })
              .end(toolCallStreamFrames(id, model, tool, resolveStepInput(step, body)));
          } else {
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                id,
                type: "message",
                role: "assistant",
                model,
                content: [
                  {
                    type: "tool_use",
                    id: `toolu_${id}`,
                    name: tool,
                    input: resolveStepInput(step, body),
                  },
                ],
                stop_reason: "tool_use",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
              }),
            );
          }
          return;
        }
        call.script = { id: scriptId, step: stepIndex };
      }
      // After a compaction the turn's message also carries the CLI's own
      // context blocks; the answer echoes only the line with the marker.
      const text = answerFor(
        scriptId && steps
          ? (started.split("\n").find((line) => SCRIPT_PATTERN.test(line)) ?? started).trim()
          : prompt,
      );
      const streamDeltas = streamDeltaCountOf(prompt);
      const bashWord = endsWithToolResult(body) ? undefined : bashWordOf(prompt);
      call.answeredAt = Date.now();
      if (bashWord && (body as { stream?: unknown }).stream === true) {
        response
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(
            toolUseStreamFrames(
              `msg_fake_${counter}`,
              model,
              `printf ${bashWord} > ${bashWord}.txt`,
            ),
          );
        return;
      }
      if ((body as { stream?: unknown }).stream === true && streamDeltas > 0) {
        const whole = await writePacedStream(
          response,
          `msg_fake_${counter}`,
          model,
          streamedAnswerDeltas(prompt, streamDeltas),
          STREAM_DELTA_INTERVAL_MS,
        );
        // A stream the client left early never ended: it has no stream end.
        if (whole) call.streamedAt = Date.now();
        else call.aborted = true;
        return;
      }
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
