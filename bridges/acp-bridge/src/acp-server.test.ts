import { afterEach, describe, expect, jest, test } from "bun:test";


import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";


import { createServer } from "node:net";


import { promises as fs } from "node:fs";


import os from "node:os";


import { dirname, resolve } from "node:path";


import { fileURLToPath, pathToFileURL } from "node:url";



const here = dirname(fileURLToPath(import.meta.url));


// The repository-wide test preload installs a browser-like fetch for UI tests.
// Use Bun's native client for loopback bridge integration requests so browser
// CORS rules cannot turn these GETs into preflight requests.
const nativeFetch = Bun.fetch;


const children = new Set<ChildProcessWithoutNullStreams>();


const temporaryDirectories = new Set<string>();


/**
 * Bun's 5 s default per-test budget is smaller than what these tests actually
 * do. `spawnBridge` alone may spend up to `DEFAULT_WAIT_TIMEOUT_MS` waiting on
 * the child's health endpoint before a test body starts, and nearly every body
 * then polls with one or more further `waitFor` calls. Under aggregate-suite
 * spawn contention the health wait consumed the whole budget, which is the
 * flake recorded in `docs/flaky-tests.md`. Raise it once for the file rather
 * than per test, so the next case to hit that contention does not need its own
 * one-off timeout to be discovered first.
 */
const BRIDGE_TEST_TIMEOUT_MS = 20_000;


jest.setTimeout(BRIDGE_TEST_TIMEOUT_MS);


/** Smallest valid PNG, so attachment tests exercise real image bytes. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);



afterEach(async () => {
  for (const child of children) child.kill("SIGTERM");
  children.clear();
  await Promise.all([...temporaryDirectories].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});



async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(resolve(os.tmpdir(), "acp-bridge-test-"));
  temporaryDirectories.add(directory);
  return directory;
}



async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to reserve test port");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}



const MAX_WAIT_DIAGNOSTIC_BYTES = 4 * 1024;



/**
 * Bounds the timeout diagnostic. Several suites deliberately drive a transcript
 * to the megabyte-scale `ACP_MAX_TRANSCRIPT_BYTES` floor, and serializing the
 * whole snapshot into a failure message writes that much agent text and tool
 * arguments into the saved test log for every timeout.
 */
function describeWaitValue(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    return "<unserializable>";
  }
  return serialized.length <= MAX_WAIT_DIAGNOSTIC_BYTES
    ? serialized
    : `${serialized.slice(0, MAX_WAIT_DIAGNOSTIC_BYTES)}… (${serialized.length} chars, truncated)`;
}



function isRetryableWaitError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ConnectionRefused" || error.code === "ECONNREFUSED";
}



/**
 * Deliberately below {@link BRIDGE_TEST_TIMEOUT_MS}. A wait that could outlast
 * the per-test budget loses the race to Bun's generic "test timed out", and the
 * bounded diagnostic below — the whole reason this helper exists — never prints.
 */
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;



async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | undefined;
  let lastRetryableCode: string | undefined;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      if (accept(latest)) return latest;
    } catch (error) {
      // The bridge child can still be binding, or Bun may already have killed it
      // after a test timeout. Retry until the deadline so a refused connection
      // becomes a bounded wait diagnostic instead of an unhandled rejection.
      if (!isRetryableWaitError(error)) throw error;
      lastRetryableCode = String((error as { code: unknown }).code);
    }
    await Bun.sleep(20);
  }
  // Report the swallowed code as well. When every read was refused `latest` was
  // never assigned, so without this the message is a bare `undefined` — which is
  // exactly the case where the retried error is the only useful evidence.
  const cause = lastRetryableCode ? ` (last error: ${lastRetryableCode})` : "";
  throw new Error(`Timed out waiting for ACP state: ${describeWaitValue(latest)}${cause}`);
}



function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}



async function spawnBridge(options: {
  port?: number;
  token?: string;
  stateDirectory?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{ child: ChildProcessWithoutNullStreams; base: string; headers: Record<string, string> }> {
  const port = options.port ?? await unusedPort();
  const token = options.token ?? "integration-test-token";
  // A live Orkestrator process exports ACP_STATE_DIR. Inheriting it would
  // restore that environment's sessions into this test bridge, so a
  // MAX_SESSIONS=1 rollback test 429s before it can fail closed, and
  // /global/models merges the fixture catalogue with whatever was persisted.
  const stateDirectory = options.stateDirectory ?? await temporaryDirectory();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ACP_PROVIDER: "cursor",
    ACP_AGENT_PATH: resolve(here, "testing/fake-agent.ts"),
    ACP_BRIDGE_TOKEN: token,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    ACP_STATE_DIR: stateDirectory,
  };
  delete env.ACP_MAX_SESSIONS;
  Object.assign(env, options.env);
  // The child inherits this process's environment, so a test that pins a
  // fail-closed default has to prove the variable is genuinely absent rather
  // than merely unmentioned. An explicit `undefined` in `options.env` deletes
  // it instead of leaking whatever the developer's or CI shell exported.
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(process.execPath, [resolve(here, "index.ts")], {
    cwd: resolve(here, "../../.."),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => nativeFetch(`${base}/global/health`).then((response) => response.ok).catch(() => false),
    Boolean,
  );
  return {
    child,
    base,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  };
}



async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  child.kill("SIGTERM");
  await exited;
  children.delete(child);
}



async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

describe("ACP bridge", () => {



  // The fake agent records its own argv, so these assert the exact command line
  // the bridge builds. They cannot prove the real CLIs accept those flags —
  // `docs/upgrade-agents.md` carries that as a manual step for version bumps.
  async function readAgentArgs(env: NodeJS.ProcessEnv): Promise<string[]> {
    const argsFile = resolve(await temporaryDirectory(), "args.log");
    const { base, headers } = await spawnBridge({
      env: { ...env, FAKE_ACP_ARGS_FILE: argsFile },
    });

    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    });
    expect(created.status).toBe(201);

    const recorded = await waitFor(
      async () => fs.readFile(argsFile, "utf8").catch(() => ""),
      (value) => value.trim().length > 0,
    );
    // One session spawns one agent. A second line would mean the child was
    // restarted, which should fail as itself rather than as a JSON parse error
    // on two concatenated records.
    const lines = recorded.trim().split("\n");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!) as string[];
  }



  test("starts Cursor ACP without project MCP auto-approval by default", async () => {
    // ACP_APPROVE_PROJECT_MCPS must fail closed when absent — the state every
    // launcher except the container one leaves it in. Delete it outright
    // instead of setting "0", so a regression to a default-on check such as
    // `!== "0"` cannot satisfy this test.
    expect(await readAgentArgs({ ACP_APPROVE_PROJECT_MCPS: undefined }))
      .toEqual(["--force", "acp"]);
  });



  test("starts Grok ACP with automatic tool approval", async () => {
    expect(await readAgentArgs({ ACP_PROVIDER: "grok" }))
      .toEqual(["--always-approve", "agent", "stdio"]);
  });



  test("closes an outstanding Cursor replay process when the bridge shuts down", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-replay-shutdown.log");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_LOAD_DELAY_MS: "5000",
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-shutdown:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS" }),
    });
    // The replay child is parked in `session/load` and is not reachable from
    // any session's `child`, so only its own registry can close it.
    const started = await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => value.includes("load:"),
    );
    expect(started.match(/^start:/gm)?.length ?? 0).toBe(2);

    await stopChild(bridge.child);
    const stopped = await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => (value.match(/^stop:/gm)?.length ?? 0) === 2,
    );
    const startedPids = new Set((stopped.match(/^start:(\d+)$/gm) ?? []).map(
      (line) => line.slice("start:".length),
    ));
    const stoppedPids = new Set((stopped.match(/^stop:(\d+)$/gm) ?? []).map(
      (line) => line.slice("stop:".length),
    ));
    expect(stoppedPids).toEqual(startedPids);
  });



  test("settles a tool left in flight when the agent process dies mid-turn", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-crash" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIETOOL: die mid-turn" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "error",
    );

    expect(session.messages[1]?.parts.find((part) => part.toolUseId === "crash-1")).toMatchObject({
      toolState: "failure",
      toolError: "Tool call ended without a result",
    });
  });



  test("surfaces the agent exit that happened during resource-exhausted backoff", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-child-died.log");
    const { base, headers } = await spawnBridge({ env: {
      ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "400",
      FAKE_ACP_COUNTER_FILE: counterFile,
      FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "4",
      FAKE_ACP_RESOURCE_EXHAUSTED_DIE_AFTER_MS: "20",
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: die during backoff",
        requestId: "resource-retry-died-1",
      }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{ status: string; error?: string }>,
      (value) => value.status === "error",
    );

    // The child's exit is the real cause, so the retry must not overwrite it
    // with a generic "lost its live session".
    expect(session.error).toContain("ACP process exited");
    // The continuation is never dispatched into a dead child.
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });



  test("times out hung initialization and rejects malformed agent output", async () => {
    const hung = await spawnBridge({ env: { FAKE_ACP_HANG_INITIALIZE: "1", ACP_RPC_TIMEOUT_MS: "30" } });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await nativeFetch(`${hung.base}/session/create`, { method: "POST", headers: hung.headers });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "cursor ACP initialize timed out" });
    }
    expect((await nativeFetch(`${hung.base}/global/health`)).ok).toBe(true);

    const malformed = await spawnBridge({ env: { FAKE_ACP_MALFORMED_INITIALIZE: "1" } });
    const response = await nativeFetch(`${malformed.base}/session/create`, { method: "POST", headers: malformed.headers });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "cursor ACP emitted malformed JSON" });
  });



  test("counts in-flight creation reservations against the session cap", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cap-lifecycle.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_HANG_INITIALIZE: "1",
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      ACP_RPC_TIMEOUT_MS: "1000",
      ACP_MAX_SESSIONS: "2",
    } });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const create = (key: string, signal: AbortSignal) => nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: key }),
      signal,
    }).catch(() => undefined);
    const first = create("first", firstController.signal);
    const second = create("second", secondController.signal);
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (contents) => (contents.match(/^start:/gm)?.length ?? 0) === 2,
    );
    const rejected = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "third" }),
    });
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ error: "ACP session limit reached" });
    firstController.abort();
    secondController.abort();
    await Promise.all([first, second]);
  });



  test("exits when its advertised parent dies", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "parent-lifecycle.log");
    const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] });
    children.add(parent);
    const bridge = await spawnBridge({ env: {
      ORKESTRATOR_PARENT_PID: String(parent.pid),
      ACP_PARENT_WATCHDOG_INTERVAL_MS: "20",
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
    } });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    });
    expect(created.status).toBe(201);
    const lifecycle = await fs.readFile(lifecycleFile, "utf8");
    const agentPid = Number(/^start:(\d+)$/m.exec(lifecycle)?.[1]);
    const exited = new Promise<void>((resolvePromise) => bridge.child.once("exit", () => resolvePromise()));
    parent.kill("SIGKILL");
    await Promise.race([
      exited,
      Bun.sleep(2_000).then(() => { throw new Error("ACP bridge did not exit after parent death"); }),
    ]);
    expect(() => process.kill(agentPid, 0)).toThrow();
    children.delete(parent);
    children.delete(bridge.child);
  });



  test("keeps serving other sessions after one agent dies mid-turn", async () => {
    const { base, headers, child } = await spawnBridge();
    const [dying, healthy] = await Promise.all([
      nativeFetch(`${base}/session/create`, { method: "POST", headers })
        .then((response) => response.json()) as Promise<{ id: string }>,
      nativeFetch(`${base}/session/create`, { method: "POST", headers })
        .then((response) => response.json()) as Promise<{ id: string }>,
    ]);

    // This prompt kills its agent without answering.
    await nativeFetch(`${base}/session/${dying.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CRASH now", requestId: "crash-1" }),
    });
    const failed = await waitFor(
      async () => nativeFetch(`${base}/session/${dying.id}/status`, { headers }).then((response) => response.json()) as Promise<{ status: string; error?: string }>,
      (value) => value.status === "error",
    );
    expect(failed.error).toContain("exited");

    // Client actions against the dead session must not disturb the bridge.
    expect((await nativeFetch(`${base}/session/${dying.id}/cancel`, { method: "POST", headers })).status).toBe(202);
    expect(child.exitCode).toBe(null);

    // The unrelated session is untouched and still usable.
    await nativeFetch(`${base}/session/${healthy.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIRECT:still here", requestId: "healthy-1" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${healthy.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "idle",
    );
    expect(session.messages.at(-1)?.content).toBe("still here");
  });

});
