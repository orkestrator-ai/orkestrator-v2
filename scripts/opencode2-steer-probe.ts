#!/usr/bin/env bun
/**
 * Live probe of OpenCode 2.x steering semantics (to-do 0008, retired (`git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`), task 10).
 *
 * Starts a pinned 2.x `opencode serve` in a disposable HOME/XDG/OPENCODE_DB with a
 * scripted local OpenAI-compatible model, so it makes no billed or remote model calls,
 * and checks:
 *   1. a steer sent while a tool runs is delivered at the next step boundary (same run);
 *   2. a steer sent while the final answer streams continues the same run;
 *   3. a steer sent to an idle session starts a new run;
 *   4. what an exact retry and a conflicting reuse of the same input id answer;
 *   5. how inbox and execution events are ordered (live `/api/event` `durable.seq`);
 *   6. what `queue` does on an idle session, and how a malformed input id is refused.
 *
 * It reports what it observed; it asserts nothing. Results for 2.2.6 are recorded in
 * to-do 0008, retired (`git show 17d28238c:docs/todo/agent-engines/0008-opencode-v2.md`) (task 10, "Spike results").
 *
 * Usage: OPENCODE2_CLI_PATH=/path/to/opencode bun scripts/opencode2-steer-probe.ts [--json]
 * The binary must be a 2.x build (e.g. unpacked from `npm pack @opencode/cli-<platform>@<v>`).
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;
type ChatRequest = {
  messages?: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string; description?: string } }>;
};

const STEP_SLEEP_SECONDS = 3;
const FINAL_ANSWER_DELAY_MS = 2500;

function log(...parts: unknown[]) {
  if (!process.argv.includes("--json")) process.stderr.write(`${parts.map(String).join(" ")}\n`);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (part && typeof part === "object" ? String((part as Json).text ?? "") : ""))
      .join("");
  return "";
}

/** Each scripted reply is chosen by the latest user text the model was given. */
export class ScriptedModel {
  /**
   * `tools` is every tool name the request offered the model;
   * `lastUserContent` is the newest user message's raw content (text and file
   * parts), and `reasoningEffort` the request's `reasoning_effort` (a model
   * variant's setting), so a live test can see what reached the model.
   */
  readonly calls: Array<{
    userTexts: string[];
    /** The request's system messages, where session instructions arrive. */
    systemTexts: string[];
    lastRole: string;
    tools: string[];
    /** The newest tool result the model was handed, when the request ends in one. */
    toolResult?: string;
    lastUserContent?: unknown;
    reasoningEffort?: unknown;
  }> = [];
  /**
   * A live test's own script, consulted before the defaults below: given
   * every message's text (any role), the last role and the offered tools, it
   * answers with one tool call or a final text, or undefined for the defaults.
   */
  respond?: (call: {
    texts: string[];
    lastRole: string;
    tools: string[];
    /** Each offered tool's description, by name. */
    descriptions: Record<string, string>;
  }) => { tool: string; arguments: Json } | { text: string } | undefined;
  /**
   * Awaited before a request is answered, so a live test can hold the model's
   * response open (a turn mid-stream, as a restart may find it). Given every
   * message's text; resolving lets the request continue as scripted.
   */
  hold?: (call: { texts: string[]; lastRole: string }) => Promise<void> | void;
  private server: ReturnType<typeof Bun.serve> | undefined;

  start(): string {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 60,
      fetch: async (request) => {
        if (!new URL(request.url).pathname.endsWith("/chat/completions"))
          return new Response(null, { status: 404 });
        const body = (await request.json()) as ChatRequest;
        const messages = body.messages ?? [];
        const userTexts = messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
        const systemTexts = messages
          .filter((m) => m.role === "system")
          .map((m) => textOf(m.content));
        const lastRole = messages.at(-1)?.role ?? "";
        const tools = (body.tools ?? []).flatMap((tool) =>
          typeof tool.function?.name === "string" ? [tool.function.name] : [],
        );
        const lastUserContent = messages.filter((m) => m.role === "user").at(-1)?.content;
        const reasoningEffort = (body as { reasoning_effort?: unknown }).reasoning_effort;
        this.calls.push({
          userTexts,
          systemTexts,
          lastRole,
          tools,
          lastUserContent,
          reasoningEffort,
          ...(lastRole === "tool" ? { toolResult: textOf(messages.at(-1)?.content) } : {}),
        });
        await this.hold?.({ texts: messages.map((m) => textOf(m.content)), lastRole });
        const custom = this.respond?.({
          texts: messages.map((m) => textOf(m.content)),
          lastRole,
          tools,
          descriptions: Object.fromEntries(
            (body.tools ?? []).flatMap((tool) =>
              typeof tool.function?.name === "string"
                ? [[tool.function.name, tool.function.description ?? ""]]
                : [],
            ),
          ),
        });
        if (custom && "tool" in custom) {
          return sse(namedToolCallChunks(custom.tool, JSON.stringify(custom.arguments)));
        }
        if (custom) return sse(answerChunks(custom.text));
        const latestUser = userTexts.at(-1) ?? "";
        // A turn asking for a slow tool gets one bash call, then (after the tool result) an answer.
        // `RUN_BASH:<command>` runs that command instead (fixture-only; the model is scripted).
        // `RUN_TOOL:<name> <json arguments>` (one line) calls any offered tool by its exact name.
        // `ANSWER_JSON:<value>` (one line) makes the final answer exactly that text.
        if (lastRole === "user") {
          // `CALL_TOOL:<name> <json args>` calls any tool once (fixture-only).
          const call = /CALL_TOOL:(\S+)\s+(\{.*\})\s*$/s.exec(latestUser);
          if (call) return sse(namedToolCallChunks(call[1]!, call[2]!));
          const tool = /RUN_TOOL:(\S+) (\{.*\})$/m.exec(latestUser);
          if (tool) return sse(toolCallChunks(undefined, tool[1]!, tool[2]!));
          const bash = /RUN_BASH:(.+)$/s.exec(latestUser)?.[1];
          if (bash) return sse(toolCallChunks(bash.trim()));
          if (latestUser.includes("RUN_SLOW_TOOL")) return sse(toolCallChunks());
        }
        const answer = /ANSWER_JSON:(.+)$/m.exec(latestUser)?.[1];
        if (answer) return sse(answerChunks(answer.trim()));
        const slowAnswer = latestUser.includes("SLOW_ANSWER");
        return sse(
          answerChunks(`ack:${latestUser.slice(0, 40)}`),
          slowAnswer ? FINAL_ANSWER_DELAY_MS : 0,
        );
      },
    });
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop() {
    this.server?.stop(true);
  }
}

const base = {
  id: "chatcmpl-probe",
  object: "chat.completion.chunk",
  created: 1,
  model: "fixture",
};

function toolCallChunks(
  command = `sleep ${STEP_SLEEP_SECONDS}`,
  name = "shell",
  argumentsJson?: string,
): Json[] {
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${Math.random().toString(36).slice(2, 10)}`,
                type: "function",
                function: {
                  // 2.x names it `shell` (it repairs a `bash` call, but say it right).
                  name,
                  arguments:
                    argumentsJson ??
                    JSON.stringify({
                      command,
                      description: "Run in the disposable workspace",
                    }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function namedToolCallChunks(name: string, args: string): Json[] {
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${name}`,
                type: "function",
                function: { name, arguments: args },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function answerChunks(text: string): Json[] {
  return [
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

function sse(chunks: Json[], delayMs = 0): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      if (delayMs) await Bun.sleep(delayMs);
      for (const chunk of chunks)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

class Api {
  constructor(
    readonly baseUrl: string,
    readonly password: string,
    readonly directory: string,
  ) {}

  async call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Basic ${btoa(`opencode:${this.password}`)}`,
        "x-opencode-directory": this.directory,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    // Successful 2.x answers are enveloped as `{ data }`.
    if (response.ok && data && typeof data === "object" && "data" in data)
      data = (data as Json).data;
    return { status: response.status, data };
  }
}

export interface OpenCode2Fixture {
  baseUrl: string;
  password: string;
  /** The project directory the server and its sessions are scoped to. */
  directory: string;
  model: ScriptedModel;
  version: string;
  /**
   * Stop the server and start it again on the same port, password, database
   * and directories, as a crash or an upgrade restart would. `SIGTERM` (the
   * default) is what the backend's reaper sends an orphaned server first;
   * `SIGKILL` stands in for a server that died with no chance to clean up.
   */
  restart(options?: { signal?: "SIGTERM" | "SIGKILL" }): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start a 2.x `opencode serve` in a disposable HOME/XDG/OPENCODE_DB, wired to a
 * scripted local model, and wait for `/api/info`. Shared by this probe and the
 * backend's OpenCode 2.x live tests. `stop()` signals only the process it spawned.
 */
export async function startOpenCode2Fixture(
  binary: string,
  options: {
    env?: Record<string, string>;
    /** 2.x native rules (`{ action, resource, effect }`), applied after the defaults below. */
    permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>;
  } = {},
): Promise<OpenCode2Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ork-opencode2-")));
  const model = new ScriptedModel();
  const modelUrl = model.start();
  const dirs = Object.fromEntries(
    ["home", "config", "data", "state", "cache", "work"].map((name) => [name, join(root, name)]),
  ) as Record<"home" | "config" | "data" | "state" | "cache" | "work", string>;
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(
    join(dirs.work, "opencode.json"),
    JSON.stringify({
      permission: { bash: "allow", edit: "allow", external_directory: "allow" },
      ...(options.permissions ? { permissions: options.permissions } : {}),
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local fixture",
          options: { baseURL: `${modelUrl}/v1`, apiKey: "test-key" },
          models: { fixture: { name: "Fixture", limit: { context: 16000, output: 2000 } } },
        },
      },
      model: "fixture/fixture",
    }),
  );
  const password = crypto.randomUUID();
  const port = await freePort();
  const spawnServer = () =>
    Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: dirs.work,
      env: {
        PATH: process.env.PATH,
        HOME: dirs.home,
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_STATE_HOME: dirs.state,
        XDG_CACHE_HOME: dirs.cache,
        OPENCODE_DB: join(dirs.data, "fixture.db"),
        OPENCODE_PASSWORD: password,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        // As every Orkestrator launch runs it (`OPENCODE2_DISABLE_FILEWATCHER`
        // in apps/backend/src/core/opencode2/server.ts), so the live set
        // qualifies the server Orkestrator actually starts. `options.env`
        // may turn the watchers back on.
        OPENCODE_DISABLE_FILEWATCHER: "1",
        ...options.env,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
  let server = spawnServer();
  /** Signal only the process this fixture spawned, and wait for it to exit. */
  const stopServer = async (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
    const current = server;
    current.kill(signal);
    await Promise.race([current.exited, Bun.sleep(5000)]);
    if (current.exitCode === null && current.signalCode === null) {
      current.kill("SIGKILL");
      await current.exited;
    }
  };
  const stop = async () => {
    await stopServer();
    model.stop();
    if (!process.env.OPENCODE2_PROBE_KEEP) await rm(root, { recursive: true, force: true });
    else log("kept", root);
  };
  const baseUrl = `http://127.0.0.1:${port}`;
  const api = new Api(baseUrl, password, dirs.work);
  const healthy = async (): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      const info = await api.call("GET", "/api/info").catch(() => null);
      if (info?.status === 200) return String((info.data as Json).version);
      if (server.exitCode !== null) throw new Error(`opencode exited with ${server.exitCode}`);
      if (attempt > 120) throw new Error("opencode did not become healthy");
      await Bun.sleep(250);
    }
  };
  const restart = async (restartOptions: { signal?: "SIGTERM" | "SIGKILL" } = {}) => {
    await stopServer(restartOptions.signal);
    server = spawnServer();
    await healthy();
  };
  try {
    const version = await healthy();
    return { baseUrl, password, directory: dirs.work, model, version, restart, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function main() {
  const binary = process.env.OPENCODE2_CLI_PATH?.trim();
  if (!binary) throw new Error("Set OPENCODE2_CLI_PATH to a 2.x opencode binary");
  const fixture = await startOpenCode2Fixture(binary);
  const api = new Api(fixture.baseUrl, fixture.password, fixture.directory);
  const results: Json = { version: fixture.version };
  try {
    log("server", fixture.version);
    await runScenarios(api, fixture.model, results);
  } finally {
    await fixture.stop();
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

type Message = { id: string; type: string; text?: string; outcome?: string; content?: unknown };

/** Oldest first. The list route answers newest first. */
async function messages(api: Api, sessionID: string): Promise<Message[]> {
  const response = await api.call("GET", `/api/session/${sessionID}/message`);
  if (response.status !== 200 || !Array.isArray(response.data))
    throw new Error(`message list ${response.status}`);
  return [...(response.data as Message[])].reverse();
}

/** The run boundary marker 2.x appends to the history when a run settles. */
const idleCount = (list: Message[]) => list.filter((m) => m.type === "idle").length;

async function waitForIdle(
  api: Api,
  sessionID: string,
  idles: number,
  timeoutMs = 30000,
): Promise<Message[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await messages(api, sessionID);
    if (idleCount(list) >= idles) return list;
    if (Date.now() > deadline) throw new Error(`timed out waiting for idle #${idles}`);
    await Bun.sleep(150);
  }
}

/** Collapse the history to a readable timeline: user texts, answers, idle markers. */
function timeline(list: Message[]): string[] {
  return list.map((m) => {
    if (m.type === "user") return `user:${m.text}`;
    if (m.type === "idle") return `idle:${m.outcome}`;
    if (m.type === "assistant") {
      const parts = Array.isArray(m.content) ? (m.content as Json[]) : [];
      return `assistant:${parts.map((p) => (p.type === "text" ? `text(${p.text})` : String(p.type))).join("+")}`;
    }
    return m.type;
  });
}

/** Whether an idle marker separates two user texts: different runs if so. */
function sameRun(list: Message[], firstText: string, secondText: string): boolean {
  const first = list.findIndex((m) => m.type === "user" && m.text === firstText);
  const second = list.findIndex((m) => m.type === "user" && m.text === secondText);
  if (first < 0 || second < 0) throw new Error(`missing ${first < 0 ? firstText : secondText}`);
  return !list.slice(first, second).some((m) => m.type === "idle");
}

const nonTitleCalls = (model: ScriptedModel) =>
  model.calls.filter(
    (call) => !call.userTexts.some((text) => text.includes("Reply with only the title")),
  );

async function runScenarios(api: Api, model: ScriptedModel, results: Json) {
  const events: Array<{ type: string; keys: string[]; durable?: unknown }> = [];
  const eventAbort = new AbortController();
  void watchEvents(api, events, eventAbort.signal);
  try {
    const created = await api.call("POST", "/api/session", {
      model: { providerID: "fixture", id: "fixture" },
      location: { directory: api.directory },
    });
    if (created.status !== 200)
      throw new Error(`create ${created.status} ${JSON.stringify(created.data)}`);
    const sessionID = (created.data as Json).id as string;
    const prompt = (id: string, text: string, delivery: "steer" | "queue" = "steer") =>
      api.call("POST", `/api/session/${sessionID}/prompt`, { id, text, delivery });

    // 1. Steer while a tool runs: delivered at the next step boundary, same run.
    const p1 = await prompt("msg_orkprobe0001", "RUN_SLOW_TOOL first");
    await Bun.sleep(1500);
    const s1 = await prompt("msg_orkprobe0002", "STEER_DURING_TOOL");
    let list = await waitForIdle(api, sessionID, 1);
    const callWithSteer = nonTitleCalls(model).find((call) =>
      call.userTexts.includes("STEER_DURING_TOOL"),
    );
    results.midStep = {
      promptStatus: p1.status,
      steerStatus: s1.status,
      steerAnswer: s1.data,
      sameRun: sameRun(list, "RUN_SLOW_TOOL first", "STEER_DURING_TOOL"),
      modelSawSteerAfterTool: callWithSteer?.lastRole ?? null,
      timeline: timeline(list),
    };
    log("1", JSON.stringify(results.midStep));

    // 2. Steer while the final answer streams: the run continues with it.
    await prompt("msg_orkprobe0003", "SLOW_ANSWER second");
    await Bun.sleep(1000);
    const s2 = await prompt("msg_orkprobe0004", "STEER_DURING_ANSWER");
    list = await waitForIdle(api, sessionID, 2);
    await Bun.sleep(500);
    list = await messages(api, sessionID);
    results.finalAnswer = {
      steerStatus: s2.status,
      sameRun: sameRun(list, "SLOW_ANSWER second", "STEER_DURING_ANSWER"),
      idleMarkers: idleCount(list),
      timeline: timeline(list),
    };
    log("2", JSON.stringify(results.finalAnswer));

    // 3. Steer an idle session: starts a new run.
    const idlesBefore = idleCount(list);
    const s3 = await prompt("msg_orkprobe0005", "STEER_WHILE_IDLE");
    list = await waitForIdle(api, sessionID, idlesBefore + 1);
    results.idleWake = {
      steerStatus: s3.status,
      newRun: !sameRun(list, "STEER_DURING_ANSWER", "STEER_WHILE_IDLE"),
      answered: timeline(list).slice(-2),
    };
    log("3", JSON.stringify(results.idleWake));

    // 4. Exact retry and conflicting reuse of the same input id.
    const callsBefore = nonTitleCalls(model).length;
    const retry = await prompt("msg_orkprobe0005", "STEER_WHILE_IDLE");
    const conflict = await prompt("msg_orkprobe0005", "A DIFFERENT TEXT");
    await Bun.sleep(1500);
    list = await messages(api, sessionID);
    results.idempotency = {
      retryStatus: retry.status,
      retryAnswer: retry.data,
      conflictStatus: conflict.status,
      conflictAnswer: conflict.data,
      extraModelCalls: nonTitleCalls(model).length - callsBefore,
      steerWhileIdleCopies: list.filter((m) => m.type === "user" && m.text === "STEER_WHILE_IDLE")
        .length,
    };
    log("4", JSON.stringify(results.idempotency));

    // 5. Queue on an idle session: does it wake? Can it be withdrawn?
    const idles5 = idleCount(list);
    const q = await prompt("msg_orkprobe0006", "QUEUED_WHILE_IDLE", "queue");
    await Bun.sleep(2000);
    list = await messages(api, sessionID);
    const inbox = await api.call("GET", `/api/session/${sessionID}/inbox`);
    const withdrawn = await api.call("DELETE", `/api/session/${sessionID}/inbox/msg_orkprobe0006`);
    results.queueWhileIdle = {
      queueStatus: q.status,
      woke: idleCount(list) > idles5,
      inbox: inbox.data,
      withdrawStatus: withdrawn.status,
      withdrawAnswer: withdrawn.data,
    };
    log("5", JSON.stringify(results.queueWhileIdle));

    // 6. Malformed or foreign input ids.
    const badId = await prompt("not-a-msg-id", "BAD_ID");
    results.badIdStatus = badId.status;
    results.badIdAnswer = badId.data;
  } finally {
    eventAbort.abort();
  }
  const types = new Map<string, string[]>();
  for (const event of events) if (!types.has(event.type)) types.set(event.type, event.keys);
  results.eventTypes = Object.fromEntries(types);
  // Ordering evidence: the durable envelope of every run and inbox event, in arrival order.
  results.runAndInboxEvents = events
    .filter((event) => /^session\.(execution|inbox)\./.test(event.type))
    .map((event) => ({ type: event.type, durable: event.durable ?? null }));
}

/** Records each `/api/event` frame's type and top-level keys (never payload content). */
async function watchEvents(
  api: Api,
  sink: Array<{ type: string; keys: string[]; durable?: unknown }>,
  signal: AbortSignal,
) {
  try {
    const response = await fetch(`${api.baseUrl}/api/event`, {
      headers: {
        authorization: `Basic ${btoa(`opencode:${api.password}`)}`,
        "x-opencode-directory": api.directory,
      },
      signal,
    });
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        try {
          const parsed = JSON.parse(data.slice(6)) as Json;
          sink.push({
            type: String(parsed.type),
            keys: Object.keys(parsed).sort(),
            ...(parsed.durable ? { durable: parsed.durable } : {}),
          });
        } catch {}
      }
    }
  } catch {}
}

if (import.meta.main) await main();
