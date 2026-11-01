// What a first Claude turn costs cold, on a prewarmed spare and on a warm CLI.
//
// Runs the pinned CLI, and the bridge itself, against a local scripted Messages
// endpoint with a fake key and a throwaway HOME, so no login is read and no
// model is billed. The endpoint answers at once, so every time here is what a
// turn pays before the model, and every request is counted, which also proves a
// parked spare calls nothing. Prints one JSON document after `RESULT_SENTINEL`;
// see to-do 0005, task 3.
//
//   bun src/services/claude-first-turn.live-probe.ts [runs]
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prewarm,
  query,
  type Options,
  type SDKUserMessage,
  type SpareProcess,
} from "@anthropic-ai/claude-agent-sdk";

const RESULT_SENTINEL = "__FIRST_TURN_RESULT__";
const RUNS = Number(process.argv[2] ?? 5);
const STDIO_SERVERS = ["alpha", "beta", "gamma"];
const FIXTURE_SERVER = join(import.meta.dir, "session-manager-prompt-mcp-sync.live-fixture.ts");

const root = await mkdtemp(join(tmpdir(), "claude-first-turn-"));
const home = join(root, "home");
const configDir = join(home, ".claude");

let modelCalls = 0;
const requests: string[] = [];
let onModelCall: (() => void) | undefined;

function modelStream(id: string): string {
  const message = {
    id,
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  return [
    { type: "message_start", message },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

const endpoint = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    await request.text();
    if (!path.endsWith("/messages")) return Response.json({ input_tokens: 1 });
    modelCalls += 1;
    onModelCall?.();
    return new Response(modelStream(`msg_${modelCalls}`), {
      headers: { "content-type": "text/event-stream" },
    });
  },
});

/** Ms from now until the next model request, once `start` has been called. */
function untilModelCall(start: () => unknown): Promise<number> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No model request in 60 s")), 60_000);
    onModelCall = () => {
      clearTimeout(timer);
      onModelCall = undefined;
      resolve(Math.round(performance.now() - startedAt));
    };
    void start();
  });
}

const isolatedEnv = {
  PATH: process.env.PATH,
  HOME: home,
  CLAUDE_CONFIG_DIR: configDir,
  ANTHROPIC_API_KEY: "sk-ant-test-first-turn-fixture",
  ANTHROPIC_BASE_URL: endpoint.url.origin,
  DISABLE_TELEMETRY: "1",
  DISABLE_AUTOUPDATER: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
};
// Nothing ambient reaches a CLI: no login, no key, no real config directory.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolatedEnv);
const env = { ...isolatedEnv, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };

const SLOW_MCP_DELAY_MS = 2_000;
const slowFixtureServer = join(root, "slow-mcp-server.ts");
/** Like the fixture server, but it takes `SLOW_MCP_DELAY_MS` to be ready to read. */
const SLOW_FIXTURE_SOURCE = `await Bun.sleep(${SLOW_MCP_DELAY_MS});
process.argv.splice(2, 0, "slow");
await import(${JSON.stringify(FIXTURE_SERVER)});
`;
const slowServer = {
  slow: { type: "stdio" as const, command: process.execPath, args: [slowFixtureServer] },
};

const stdioServers = Object.fromEntries(
  STDIO_SERVERS.map((name) => [
    name,
    { type: "stdio" as const, command: process.execPath, args: [FIXTURE_SERVER, name] },
  ]),
);

/** The options a bridge launch shares with every session. */
function launchOptions(extra: Partial<Options> = {}): Options {
  return {
    env,
    settingSources: ["user", "project", "local"],
    includePartialMessages: true,
    forwardSubagentText: true,
    agentProgressSummaries: true,
    perTaskStopAffordance: true,
    enableFileCheckpointing: true,
    includeHookEvents: true,
    permissionMode: "acceptEdits",
    systemPrompt: { type: "preset", preset: "claude_code", append: "Fixture." },
    hooks: { PreToolUse: [{ hooks: [async () => ({ continue: true })] }] },
    canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
    ...extra,
  };
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessage;
}

/** A held streaming prompt, the way the bridge keeps a CLI open between turns. */
function heldInput() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  return {
    push(text: string) {
      queue.push(userMessage(text));
      wake?.();
    },
    stream: (async function* () {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })(),
  };
}

/** The one consumer of a CLI's frames; `result()` waits for the next turn's end. */
function consume(frames: AsyncIterable<unknown>) {
  const waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];
  let ended: Error | undefined;
  void (async () => {
    try {
      for await (const value of frames) {
        const frame = value as { type?: string; subtype?: string };
        if (frame.type !== "result") continue;
        const waiter = waiting.shift();
        if (frame.subtype === "success") waiter?.resolve();
        else waiter?.reject(new Error(`Result: ${JSON.stringify(frame)}`));
      }
      ended = new Error("The CLI ended");
    } catch (error) {
      ended = error instanceof Error ? error : new Error(String(error));
    }
    for (const waiter of waiting.splice(0)) waiter.reject(ended);
  })();
  return {
    result: () =>
      new Promise<void>((resolve, reject) => {
        if (ended) reject(ended);
        else waiting.push({ resolve, reject });
      }),
  };
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

/** Resident MB of the newest child of this process: the CLI just started. 0 if unreadable. */
function newestChildRssMb(): number {
  try {
    const pid = execFileSync("pgrep", ["-n", "-P", String(process.pid)])
      .toString()
      .trim();
    return Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", pid]).toString()) / 1024);
  } catch {
    return 0;
  }
}

async function coldRun(cwd: string, extra: Partial<Options>) {
  const input = heldInput();
  const control = query({ prompt: input.stream, options: launchOptions({ cwd, ...extra }) });
  const frames = consume(control);
  let result = frames.result();
  const firstMs = await untilModelCall(() => input.push("Say ok."));
  await result;
  result = frames.result();
  const followUpMs = await untilModelCall(() => input.push("Say ok again."));
  await result;
  control.close();
  return { firstMs, followUpMs };
}

async function spareRun(cwd: string, extra: Partial<Options>) {
  const before = requests.length;
  const startedAt = performance.now();
  const spare = await prewarm({ options: launchOptions(extra) });
  const parkMs = Math.round(performance.now() - startedAt);
  // Parked long enough for any start-up call to show.
  await Bun.sleep(1_500);
  const parkedRequests = requests.slice(before);
  const parkedRssMb = newestChildRssMb();
  const input = heldInput();
  const control = spare.claim({ prompt: input.stream, options: { cwd } });
  const frames = consume(control);
  let result = frames.result();
  const firstMs = await untilModelCall(() => input.push("Say ok."));
  await result;
  result = frames.result();
  const followUpMs = await untilModelCall(() => input.push("Say ok again."));
  await result;
  control.close();
  return { parkMs, parkedRequests, parkedRssMb, firstMs, followUpMs };
}

async function compareSdk(name: string, cwd: string, extra: Partial<Options>) {
  const cold: Awaited<ReturnType<typeof coldRun>>[] = [];
  const spare: Awaited<ReturnType<typeof spareRun>>[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    cold.push(await coldRun(cwd, extra));
    spare.push(await spareRun(cwd, extra));
  }
  return {
    name,
    coldFirstMs: cold.map((run) => run.firstMs),
    spareFirstMs: spare.map((run) => run.firstMs),
    medianColdFirstMs: median(cold.map((run) => run.firstMs)),
    medianSpareFirstMs: median(spare.map((run) => run.firstMs)),
    medianWarmFollowUpMs: median(cold.map((run) => run.followUpMs)),
    medianParkMs: median(spare.map((run) => run.parkMs)),
    medianParkedRssMb: median(spare.map((run) => run.parkedRssMb)),
    parkedRequests: spare.flatMap((run) => run.parkedRequests),
  };
}

/** A real bridge process on a port of its own. */
async function startBridge(cwd: string) {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port as number;
  probe.stop(true);
  const token = randomUUID();
  const child: ChildProcess = spawn(process.execPath, [join(import.meta.dir, "../index.ts")], {
    env: {
      ...env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      CWD: cwd,
      CLAUDE_BRIDGE_TOKEN: token,
    },
    stdio: "ignore",
  });
  const call = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "X-Orkestrator-Claude-Token": token },
    });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const healthy = await call("/global/health").then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) break;
    await Bun.sleep(25);
  }
  return { call, stop: () => child.kill() };
}

async function bridgeRun(cwd: string) {
  const bridge = await startBridge(cwd);
  try {
    const created = (await (
      await bridge.call("/session/create", { method: "POST", body: "{}" })
    ).json()) as { sessionId: string };
    const send = (prompt: string) =>
      bridge.call(`/session/${created.sessionId}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt, permissionMode: "acceptEdits", model: "haiku" }),
      });
    let answered: Promise<Response> | undefined;
    const firstMs = await untilModelCall(() => {
      answered = send("Say ok.");
    });
    const firstStatus = (await answered!).status;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const state = (await (await bridge.call(`/session/${created.sessionId}`)).json()) as {
        status?: string;
      };
      if (state.status === "idle") break;
      await Bun.sleep(25);
    }
    const followUpMs = await untilModelCall(() => {
      answered = send("Say ok again.");
    });
    const followUpStatus = (await answered!).status;
    return { firstMs, followUpMs, firstStatus, followUpStatus };
  } finally {
    bridge.stop();
    await Bun.sleep(100);
  }
}

async function compareBridge(name: string, cwd: string) {
  const runs: Awaited<ReturnType<typeof bridgeRun>>[] = [];
  for (let run = 0; run < RUNS; run += 1) runs.push(await bridgeRun(cwd));
  return {
    name,
    firstMs: runs.map((run) => run.firstMs),
    followUpMs: runs.map((run) => run.followUpMs),
    medianFirstMs: median(runs.map((run) => run.firstMs)),
    medianFollowUpMs: median(runs.map((run) => run.followUpMs)),
    statuses: [...new Set(runs.flatMap((run) => [run.firstStatus, run.followUpStatus]))],
  };
}

/** What a claim keeps of a session id or a resume given at prewarm. */
async function sessionBinding(cwd: string) {
  const claimOnce = async (extra: Partial<Options>) => {
    let spare: SpareProcess | undefined;
    try {
      spare = await prewarm({ options: launchOptions(extra) });
      const input = heldInput();
      const control = spare.claim({ prompt: input.stream, options: { cwd } });
      const result = consume(control).result();
      input.push("Say ok.");
      const claimed = await spare.claimed;
      await result.catch(() => undefined);
      control.close();
      return { sessionId: claimed.sessionId };
    } catch (error) {
      spare?.close();
      return { refused: error instanceof Error ? error.message : String(error) };
    }
  };
  const asked = randomUUID();
  const withSessionId = await claimOnce({ sessionId: asked });
  const existing = randomUUID();
  await coldRun(cwd, { sessionId: existing });
  const withResume = await claimOnce({ resume: existing });
  return {
    sessionIdOption: { asked, ...withSessionId },
    resumeOption: { asked: existing, ...withResume },
  };
}

try {
  const bare = join(root, "bare");
  const folder = join(root, "folder");
  await mkdir(bare, { recursive: true });
  await mkdir(folder, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true }),
  );
  await writeFile(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: stdioServers }));
  await writeFile(slowFixtureServer, SLOW_FIXTURE_SOURCE);
  const slowFolder = join(root, "slow-folder");
  await mkdir(slowFolder, { recursive: true });
  await writeFile(join(slowFolder, ".mcp.json"), JSON.stringify({ mcpServers: slowServer }));

  // The first exec pages the binary in; it counts as neither mode.
  const pageIn = await coldRun(bare, {});
  const report = {
    pageInFirstMs: pageIn.firstMs,
    sdk: [
      await compareSdk("bare", bare, {}),
      await compareSdk("3 stdio MCP servers given inline at launch", bare, {
        mcpServers: stdioServers,
      }),
      await compareSdk(`a ${SLOW_MCP_DELAY_MS} ms MCP server given inline at launch`, bare, {
        mcpServers: slowServer,
      }),
      await compareSdk(
        `a ${SLOW_MCP_DELAY_MS} ms MCP server in the folder's .mcp.json`,
        slowFolder,
        {},
      ),
      // The bridge leaves this on. The fake key is all such a request can carry.
      await compareSdk("non-essential traffic left on, as in a real launch", bare, {
        env: isolatedEnv,
      }),
    ],
    bridge: [await compareBridge("bare", bare), await compareBridge(".mcp.json in folder", folder)],
    sessionBinding: await sessionBinding(bare),
    requestPaths: [...new Set(requests)],
    modelCalls,
  };
  console.log(`${RESULT_SENTINEL}${JSON.stringify(report, null, 2)}`);
} finally {
  endpoint.stop(true);
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
