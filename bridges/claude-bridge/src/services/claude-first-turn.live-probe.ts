// What a first Claude turn costs cold, on a prewarmed spare and on a warm CLI.
//
// Runs the pinned CLI, and the bridge itself, against a local scripted Messages
// endpoint with a fake key and a throwaway HOME, so no login is read and no
// model is billed. The endpoint answers at once, so every time here is what a
// turn pays before the model, and every request is counted, which also proves a
// parked spare calls nothing. Prints one JSON document after `RESULT_SENTINEL`;
// see to-do 0005, task 3.
//
//   bun src/services/claude-first-turn.live-probe.ts [runs] [concurrent] [stall [turnDeadlineMs]]
//
// Every variant runs on a `Fixture` of its own: endpoint, request log, home and
// bridge processes. `concurrent` runs the variants side by side, which is
// enough for the structural checks the live test makes but distorts the
// timings, so the measurement task leaves it off.
//
// `stall` is a fault mode for the live test's failure path: the endpoint takes
// every model request and never answers it, so a turn fails on its deadline
// with a CLI still running. Only one cold run is made. Every CLI's pid is
// printed to stderr after `CLI_PID_SENTINEL`, and `STALLED_SENTINEL` once the
// first model request is being held.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prewarm,
  query,
  type Options,
  type Query,
  type SDKUserMessage,
  type SpareProcess,
} from "@anthropic-ai/claude-agent-sdk";

const RESULT_SENTINEL = "__FIRST_TURN_RESULT__";
const CLI_PID_SENTINEL = "__FIRST_TURN_CLI_PID__";
const STALLED_SENTINEL = "__FIRST_TURN_STALLED__";
const RUNS = Number(process.argv[2] ?? 5);
const STDIO_SERVERS = ["alpha", "beta", "gamma"];
const FIXTURE_SERVER = join(import.meta.dir, "session-manager-prompt-mcp-sync.live-fixture.ts");

const CONCURRENT = process.argv[3] === "concurrent";
const STALL = process.argv[4] === "stall";
/** How long a turn may take once its model request is seen. */
const TURN_DEADLINE_MS = positiveInteger(process.argv[5]) ?? 60_000;
/** How long a child has after SIGTERM, and again after SIGKILL, before cleanup moves on. */
const CHILD_STOP_GRACE_MS = 2_000;
/** The one ambient variable a CLI keeps, read before the environment is cleared. */
const HOST_PATH = process.env.PATH;

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const root = await mkdtemp(join(tmpdir(), "claude-first-turn-"));

/** What one variant owns, so variants share no request log, model hook, home or bridge. */
interface Fixture {
  /** Request lines the endpoint saw, `METHOD /path`. */
  requests: string[];
  /** Ms from now until the next model request, once `start` has been called. */
  untilModelCall: (start: () => unknown) => Promise<number>;
  isolatedEnv: Record<string, string | undefined>;
  env: Record<string, string | undefined>;
  bridgeChildren: Set<ChildProcess>;
  /** Every CLI this fixture started that has not exited; a CLI writes under its home while it runs. */
  cliChildren: Set<ChildProcess>;
  /** A working directory of this fixture; `mcpServers` become its folder `.mcp.json`. */
  directory: (name: string, mcpServers?: Record<string, unknown>) => Promise<string>;
  stop: () => Promise<void>;
}

const fixtures = new Set<Fixture>();
let cleaning: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return (cleaning ??= (async () => {
    await Promise.all([...fixtures].map((fixture) => fixture.stop()));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  })());
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === "SIGTERM" ? 143 : 130));
  });
}

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

/**
 * SIGTERM, then SIGKILL after `CHILD_STOP_GRACE_MS`. Settles when the child
 * exits, or one more grace period after the SIGKILL whatever happens, so a
 * child that ignores both cannot hold cleanup (and the failure it would
 * report) forever.
 */
function stopChild(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return resolve();
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const done = () => {
      for (const timer of timers) clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
    timers.push(
      setTimeout(() => {
        child.kill("SIGKILL");
        timers.push(setTimeout(done, CHILD_STOP_GRACE_MS));
      }, CHILD_STOP_GRACE_MS),
    );
    child.kill("SIGTERM");
  });
}

/** Rejects with `message` unless `promise` settles within `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

let fixtureCount = 0;

async function createFixture(): Promise<Fixture> {
  const label = `variant-${(fixtureCount += 1)}`;
  const home = join(root, label, "home");
  const configDir = join(home, ".claude");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true }),
  );
  let modelCalls = 0;
  const requests: string[] = [];
  let onModelCall: (() => void) | undefined;
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
      if (STALL) {
        if (modelCalls === 1) console.error(STALLED_SENTINEL);
        // Held until `stop` closes the endpoint.
        return new Promise<Response>(() => undefined);
      }
      return new Response(modelStream(`msg_${modelCalls}`), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const isolatedEnv = {
    PATH: HOST_PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: "sk-ant-test-first-turn-fixture",
    ANTHROPIC_BASE_URL: endpoint.url.origin,
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };
  const bridgeChildren = new Set<ChildProcess>();
  const cliChildren = new Set<ChildProcess>();
  const fixture: Fixture = {
    requests,
    untilModelCall(start) {
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
    },
    isolatedEnv,
    env: { ...isolatedEnv, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    bridgeChildren,
    cliChildren,
    async directory(name, mcpServers) {
      const path = join(root, label, name);
      await mkdir(path, { recursive: true });
      if (mcpServers) await writeFile(join(path, ".mcp.json"), JSON.stringify({ mcpServers }));
      return path;
    },
    async stop() {
      // A run closes its own CLI on the way out; any still here belongs to a
      // run that failed before it could, or to a signal mid-run.
      await Promise.all([...bridgeChildren, ...cliChildren].map(stopChild));
      endpoint.stop(true);
    },
  };
  fixtures.add(fixture);
  return fixture;
}

// Nothing ambient reaches a CLI: no login, no key, no real config directory.
// Every CLI is given its own environment; one that fell back to this process's
// would send its requests to a closed local port.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, {
  PATH: HOST_PATH,
  HOME: join(root, "home"),
  CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
  ANTHROPIC_API_KEY: "sk-ant-test-first-turn-fixture",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
  DISABLE_TELEMETRY: "1",
  DISABLE_AUTOUPDATER: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
});

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
function launchOptions(fx: Fixture, extra: Partial<Options> = {}): Options {
  return {
    env: fx.env,
    spawnClaudeCodeProcess: (spawnOptions) => {
      const child = spawn(spawnOptions.command, spawnOptions.args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        signal: spawnOptions.signal,
        stdio: ["pipe", "pipe", "ignore"],
      });
      fx.cliChildren.add(child);
      const forget = () => fx.cliChildren.delete(child);
      child.once("exit", forget);
      child.once("error", forget);
      if (child.pid !== undefined) console.error(`${CLI_PID_SENTINEL}${child.pid}`);
      return child;
    },
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

/** Waits for a turn's result, which has `TURN_DEADLINE_MS` once its model request is seen. */
function turnEnd(result: Promise<void>): Promise<void> {
  return withDeadline(result, TURN_DEADLINE_MS, `No turn result in ${TURN_DEADLINE_MS} ms`);
}

async function coldRun(fx: Fixture, cwd: string, extra: Partial<Options>) {
  const input = heldInput();
  const control = query({ prompt: input.stream, options: launchOptions(fx, { cwd, ...extra }) });
  try {
    const frames = consume(control);
    let result = frames.result();
    const firstMs = await fx.untilModelCall(() => input.push("Say ok."));
    await turnEnd(result);
    result = frames.result();
    const followUpMs = await fx.untilModelCall(() => input.push("Say ok again."));
    await turnEnd(result);
    return { firstMs, followUpMs };
  } finally {
    control.close();
  }
}

async function spareRun(fx: Fixture, cwd: string, extra: Partial<Options>) {
  const before = fx.requests.length;
  const startedAt = performance.now();
  const spare = await prewarm({ options: launchOptions(fx, extra) });
  let control: Query | undefined;
  try {
    const parkMs = Math.round(performance.now() - startedAt);
    // Parked long enough for any start-up call to show.
    await Bun.sleep(1_500);
    const parkedRequests = fx.requests.slice(before);
    // The newest child is this variant's CLI only when no other variant starts one.
    const parkedRssMb = CONCURRENT ? 0 : newestChildRssMb();
    const input = heldInput();
    control = spare.claim({ prompt: input.stream, options: { cwd } });
    const frames = consume(control);
    let result = frames.result();
    const firstMs = await fx.untilModelCall(() => input.push("Say ok."));
    await turnEnd(result);
    result = frames.result();
    const followUpMs = await fx.untilModelCall(() => input.push("Say ok again."));
    await turnEnd(result);
    return { parkMs, parkedRequests, parkedRssMb, firstMs, followUpMs };
  } finally {
    if (control) control.close();
    else spare.close();
  }
}

async function compareSdk(fx: Fixture, name: string, cwd: string, extra: Partial<Options>) {
  const cold: Awaited<ReturnType<typeof coldRun>>[] = [];
  const spare: Awaited<ReturnType<typeof spareRun>>[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    cold.push(await coldRun(fx, cwd, extra));
    spare.push(await spareRun(fx, cwd, extra));
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
async function startBridge(fx: Fixture, cwd: string) {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port as number;
  probe.stop(true);
  const token = randomUUID();
  const child: ChildProcess = spawn(process.execPath, [join(import.meta.dir, "../index.ts")], {
    env: {
      ...fx.env,
      ORKESTRATOR_PARENT_PID: String(process.pid),
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      CWD: cwd,
      CLAUDE_BRIDGE_TOKEN: token,
    },
    stdio: "ignore",
  });
  fx.bridgeChildren.add(child);
  child.once("exit", () => fx.bridgeChildren.delete(child));
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

async function bridgeRun(fx: Fixture, cwd: string) {
  const bridge = await startBridge(fx, cwd);
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
    const firstMs = await fx.untilModelCall(() => {
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
    const followUpMs = await fx.untilModelCall(() => {
      answered = send("Say ok again.");
    });
    const followUpStatus = (await answered!).status;
    return { firstMs, followUpMs, firstStatus, followUpStatus };
  } finally {
    bridge.stop();
    await Bun.sleep(100);
  }
}

async function compareBridge(fx: Fixture, name: string, cwd: string) {
  const runs: Awaited<ReturnType<typeof bridgeRun>>[] = [];
  for (let run = 0; run < RUNS; run += 1) runs.push(await bridgeRun(fx, cwd));
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
async function sessionBinding(fx: Fixture, cwd: string) {
  const claimOnce = async (extra: Partial<Options>) => {
    let spare: SpareProcess | undefined;
    let control: Query | undefined;
    try {
      spare = await prewarm({ options: launchOptions(fx, extra) });
      const input = heldInput();
      control = spare.claim({ prompt: input.stream, options: { cwd } });
      const result = consume(control).result();
      input.push("Say ok.");
      const claimed = await spare.claimed;
      await turnEnd(result).catch(() => undefined);
      return { sessionId: claimed.sessionId };
    } catch (error) {
      return { refused: error instanceof Error ? error.message : String(error) };
    } finally {
      if (control) control.close();
      else spare?.close();
    }
  };
  const asked = randomUUID();
  const withSessionId = await claimOnce({ sessionId: asked });
  const existing = randomUUID();
  await coldRun(fx, cwd, { sessionId: existing });
  const withResume = await claimOnce({ resume: existing });
  return {
    sessionIdOption: { asked, ...withSessionId },
    resumeOption: { asked: existing, ...withResume },
  };
}

/**
 * Runs `tasks` one after another, or all at once when `concurrent`. Every task
 * finishes before a failure is thrown, so no CLI outlives the probe's report.
 */
async function runVariants(tasks: (() => Promise<unknown>)[]): Promise<unknown[]> {
  const started: Promise<unknown>[] = [];
  for (const task of tasks) {
    const promise = task();
    started.push(promise);
    if (!CONCURRENT) await promise.catch(() => undefined);
  }
  const settled = await Promise.allSettled(started);
  const failed = settled.find((entry) => entry.status === "rejected");
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return settled.map((entry) => (entry as PromiseFulfilledResult<unknown>).value);
}

try {
  await mkdir(join(root, "home", ".claude"), { recursive: true });
  await writeFile(slowFixtureServer, SLOW_FIXTURE_SOURCE);

  /** A variant on a fixture of its own, created when the variant starts. */
  const variant =
    <T>(work: (fx: Fixture) => Promise<T>) =>
    async () =>
      work(await createFixture());

  if (STALL) {
    // Fails on the turn deadline, then must still clean up and exit.
    const fx = await createFixture();
    await coldRun(fx, await fx.directory("bare"), {});
    throw new Error("A stalled model request produced a result");
  }

  // The first exec pages the binary in; it counts as neither mode. Variants
  // that overlap start their CLIs together, so there is nothing to page in first.
  const pageIn = CONCURRENT
    ? undefined
    : await variant(async (fx) => coldRun(fx, await fx.directory("bare"), {}))();
  const results = await runVariants([
    variant(async (fx) => compareSdk(fx, "bare", await fx.directory("bare"), {})),
    variant(async (fx) =>
      compareSdk(fx, "3 stdio MCP servers given inline at launch", await fx.directory("bare"), {
        mcpServers: stdioServers,
      }),
    ),
    variant(async (fx) =>
      compareSdk(
        fx,
        `a ${SLOW_MCP_DELAY_MS} ms MCP server given inline at launch`,
        await fx.directory("bare"),
        { mcpServers: slowServer },
      ),
    ),
    variant(async (fx) =>
      compareSdk(
        fx,
        `a ${SLOW_MCP_DELAY_MS} ms MCP server in the folder's .mcp.json`,
        await fx.directory("slow-folder", slowServer),
        {},
      ),
    ),
    // The bridge leaves this on. The fake key is all such a request can carry.
    variant(async (fx) =>
      compareSdk(
        fx,
        "non-essential traffic left on, as in a real launch",
        await fx.directory("bare"),
        { env: fx.isolatedEnv },
      ),
    ),
    variant(async (fx) => compareBridge(fx, "bare", await fx.directory("bare"))),
    variant(async (fx) =>
      compareBridge(fx, ".mcp.json in folder", await fx.directory("folder", stdioServers)),
    ),
    variant(async (fx) => sessionBinding(fx, await fx.directory("bare"))),
  ]);
  const requests = [...fixtures].flatMap((fixture) => fixture.requests);
  const report = {
    pageInFirstMs: pageIn?.firstMs ?? null,
    sdk: results.slice(0, 5),
    bridge: results.slice(5, 7),
    sessionBinding: results[7],
    requestPaths: [...new Set(requests)],
    modelCalls: requests.filter((request) => request.endsWith("/messages")).length,
  };
  console.log(`${RESULT_SENTINEL}${JSON.stringify(report, null, 2)}`);
} finally {
  await cleanup();
}
