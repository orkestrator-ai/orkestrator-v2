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



  test("reports an ACP agent without session listing instead of showing an empty history", async () => {
    const bridge = await spawnBridge({ env: { FAKE_ACP_NO_LIST_SESSION: "1" } });
    const response = await nativeFetch(`${bridge.base}/session/list`, { headers: bridge.headers });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: "cursor cannot list resumable ACP sessions",
    });
  });



  test("does not list sessions when the agent can list but cannot load them", async () => {
    const bridge = await spawnBridge({ env: { FAKE_ACP_NO_LOAD_SESSION: "1" } });
    const response = await nativeFetch(`${bridge.base}/session/list`, { headers: bridge.headers });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: "cursor cannot list resumable ACP sessions",
    });
  });



  test("loads an existing bridge session even when resume controls are omitted", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "resume-without-controls.log");
    const bridge = await spawnBridge({ env: { FAKE_ACP_LIFECYCLE_FILE: lifecycleFile } });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json()) as { id: string };
    const firstPid = Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]);
    process.kill(firstPid, "SIGKILL");
    await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}/status`, { headers: bridge.headers }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "error",
    );

    const resumed = await nativeFetch(`${bridge.base}/session/resume`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ sessionId: created.id }),
    });
    expect(resumed.status).toBe(201);
    expect((await resumed.json()) as { id: string; status: string }).toMatchObject({
      id: created.id,
      status: "idle",
    });
    expect(await fs.readFile(lifecycleFile, "utf8")).toContain("load:");
  });



  test("pages the ACP session list and de-duplicates across pages", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "list-cursors.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_LIST_PAGES: "3",
      FAKE_ACP_LIST_COUNTER_FILE: counterFile,
    } });

    const listed = await nativeFetch(`${bridge.base}/session/list`, { headers: bridge.headers })
      .then((response) => response.json()) as { sessions: Array<{ title?: string }> };

    expect(await fs.readFile(counterFile, "utf8")).toBe("<none>\npage-1\npage-2\n");
    // `external-session` is repeated on every page and must collapse to one.
    expect(listed.sessions.map((session) => session.title)).toEqual([
      "Previous ACP work",
      "Paged ACP work 0",
      "Paged ACP work 1",
      "Paged ACP work 2",
    ]);
  });



  test("applies each racing resume's own controls to one adopted session", async () => {
    const bridge = await spawnBridge({ env: { FAKE_ACP_LOAD_DELAY_MS: "400" } });
    const listed = await nativeFetch(`${bridge.base}/session/list`, { headers: bridge.headers })
      .then((response) => response.json()) as { sessions: Array<{ id: string; title?: string }> };
    const external = listed.sessions.find((session) => session.title === "Previous ACP work");

    const resume = (modelId: string) => nativeFetch(`${bridge.base}/session/resume`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ sessionId: external!.id, modelId }),
    }).then(async (response) => ({
      status: response.status,
      body: await response.json() as { id: string; composer: { selectedModelId?: string } },
    }));

    const first = resume("composer-2.5");
    // Lands while the first `session/load` is still open, so it joins the
    // in-flight adoption instead of starting a second one.
    await Bun.sleep(100);
    const second = await resume("gpt-5.5");
    const winner = await first;

    expect(winner.status).toBe(201);
    expect(second.status).toBe(201);
    // One ACP conversation, one bridge session.
    expect(second.body.id).toBe(winner.body.id);
    // The joining caller's controls were applied rather than silently
    // inheriting whatever the first caller asked for.
    expect(second.body.composer.selectedModelId).toBe("gpt-5.5");
  });



  test("omits model attribution entirely when the agent advertises no model", async () => {
    const { base, headers } = await spawnBridge({ env: { FAKE_ACP_NO_MODEL_OPTION: "1" } });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-nomodel:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    const dispatched = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIRECT:no model", requestId: "no-model-1" }),
    });
    expect(dispatched.status).toBe(202);

    const session = await waitFor(
      () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          composer: { selectedModelId?: string; models: unknown[] };
          messages: Array<Record<string, unknown>>;
        }>,
      (value) => value.status === "idle",
    );

    expect(session.composer.models).toEqual([]);
    expect(session.composer.selectedModelId).toBeUndefined();
    const assistant = session.messages.find((message) => message.role === "assistant");
    // Absent, not an empty string: the renderer distinguishes "no model
    // recorded" from a model whose id happens to be blank.
    expect(assistant && "modelId" in assistant).toBe(false);
  });



  test("keeps usage scoped to one turn and rehydrates the latest turn after restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-usage:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    type UsageSnapshot = {
      status: string;
      contextUsage?: Record<string, unknown>;
      runtime?: Record<string, unknown>;
    };
    const readSession = async (base: string, headers: Record<string, string>) =>
      await nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as UsageSnapshot;

    const before = await readSession(first.base, first.headers);
    // Nothing has run, so there is no measurement to report — as opposed to a
    // measurement of zero, which would render as a populated usage meter.
    expect(before.contextUsage).toBeUndefined();
    expect(before.runtime).toMatchObject({ state: "idle", version: "9.9.9" });

    expect((await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "USAGE: count the tokens" }),
    })).status).toBe(202);

    const session = await waitFor(
      () => readSession(first.base, first.headers),
      (value) => value.status === "idle" && value.contextUsage !== undefined,
    );
    expect(session.contextUsage).toMatchObject({
      usedTokens: 15_675,
      inputTokens: 15_639,
      outputTokens: 36,
      // Only `response_completed` reported the cache split. A later, sparser
      // carrier for the same turn must not drop it.
      cacheReadTokens: 5_888,
      reasoningTokens: 31,
      apiDurationMs: 1_448,
      source: "provider",
    });
    expect(session.contextUsage?.durationMs).toBeGreaterThanOrEqual(0);
    expect(session.contextUsage).not.toHaveProperty("costUsd");
    expect(session.runtime).toMatchObject({
      mcpServers: 2,
      commands: 3,
      version: "9.9.9",
      state: "idle",
    });

    expect((await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "USAGE_SPARSE: count the next turn" }),
    })).status).toBe(202);

    const sparseSession = await waitFor(
      () => readSession(first.base, first.headers),
      (value) => value.status === "idle" && value.contextUsage?.usedTokens === 222,
    );
    expect(sparseSession.contextUsage).toMatchObject({
      usedTokens: 222,
      inputTokens: 200,
      outputTokens: 22,
      source: "provider",
    });
    expect(sparseSession.contextUsage).not.toHaveProperty("cacheReadTokens");
    expect(sparseSession.contextUsage).not.toHaveProperty("reasoningTokens");
    expect(sparseSession.contextUsage).not.toHaveProperty("apiDurationMs");

    first.child.kill("SIGTERM");
    await Bun.sleep(200);
    const second = await spawnBridge({ stateDirectory });
    const restored = await readSession(second.base, second.headers);
    expect(restored.contextUsage).toMatchObject({
      usedTokens: 222,
      inputTokens: 200,
      outputTokens: 22,
      source: "provider",
    });
    expect(restored.contextUsage).not.toHaveProperty("cacheReadTokens");
    expect(restored.contextUsage).not.toHaveProperty("reasoningTokens");
    expect(restored.contextUsage).not.toHaveProperty("apiDurationMs");
    // The command list belongs to the session and survives with it; the agent
    // version and MCP inventory come from a handshake this process has not had.
    expect(restored.runtime).toMatchObject({ commands: 3 });
  });



  test("merges a usage carrier that arrives after its turn already resolved", async () => {
    const bridge = await spawnBridge({ stateDirectory: await temporaryDirectory() });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-usage-late:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    const readSession = async () =>
      await nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as {
          status: string;
          contextUsage?: Record<string, unknown>;
        };

    expect((await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "USAGE_LATE: report after the fact" }),
    })).status).toBe(202);

    // The prompt result is the only carrier this turn has while it is running,
    // so the reasoning split is genuinely absent at this point rather than
    // merely unobserved.
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle" && value.contextUsage?.usedTokens === 900,
    );
    expect(settled.contextUsage).not.toHaveProperty("reasoningTokens");
    const settledDurationMs = settled.contextUsage?.durationMs;
    expect(settledDurationMs).toBeGreaterThanOrEqual(0);

    const late = await waitFor(
      readSession,
      (value) => value.contextUsage?.reasoningTokens === 77,
    );
    // The carrier belongs to the turn that just ended, so it fills that turn's
    // gap instead of being dropped or opening a new snapshot.
    expect(late.contextUsage).toMatchObject({
      usedTokens: 900,
      inputTokens: 850,
      outputTokens: 50,
      reasoningTokens: 77,
      source: "provider",
    });
    // No turn was in flight, so the elapsed time must be carried over rather
    // than measured again from a clock this turn no longer owns.
    expect(late.contextUsage?.durationMs).toBe(settledDurationMs);
  });



  test("reads occupancy from a usage_update that uses type instead of sessionUpdate", async () => {
    const bridge = await spawnBridge({ stateDirectory: await temporaryDirectory() });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-usage-typed:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "USAGE_TYPED: report occupancy under type" }),
    })).status).toBe(202);

    // The bridge routes an update on `sessionUpdate` or `type`; the parser has
    // to read the discriminator the same way, or a `type`-spelled occupancy
    // report reaches the usage path and is then silently dropped as a generic
    // `used`/`size` pair.
    const session = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          contextUsage?: Record<string, unknown>;
        }>,
      (value) => value.status === "idle" && value.contextUsage !== undefined,
    );
    expect(session.contextUsage).toMatchObject({
      usedTokens: 1_500,
      maximumTokens: 30_000,
      source: "provider",
    });
    expect(session.contextUsage?.percentage).toBeCloseTo(5);
  });



  test("hydrates usage replayed by session/load when the bridge holds no snapshot", async () => {
    const bridge = await spawnBridge({ env: { FAKE_ACP_REPLAY_USAGE: "1" } });
    const listed = await nativeFetch(`${bridge.base}/session/list`, { headers: bridge.headers })
      .then((response) => response.json()) as { sessions: Array<{ id: string; title?: string }> };
    const external = listed.sessions.find((session) => session.title === "Previous ACP work");

    const resumed = await nativeFetch(`${bridge.base}/session/resume`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ sessionId: external!.id }),
    });
    expect(resumed.status).toBe(201);
    const session = await resumed.json() as {
      id: string;
      contextUsage?: Record<string, unknown>;
    };

    // This session has no accounting of its own: the load is the only report
    // the panel will ever see for the turn that produced it.
    expect(session.contextUsage).toMatchObject({
      usedTokens: 4_321,
      inputTokens: 4_000,
      outputTokens: 321,
      source: "provider",
    });
  });



  test("does not re-latch usage replayed into a session that already counted it", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "reconnect-usage-replay.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      FAKE_ACP_REPLAY_USAGE: "1",
    } });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json()) as { id: string };
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          contextUsage?: Record<string, unknown>;
        }>;

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "USAGE_STATE: count this turn once" }),
    });
    const before = await waitFor(
      readSession,
      (value) => value.status === "idle" && value.contextUsage !== undefined,
    );
    expect(before.contextUsage).toMatchObject({ usedTokens: 8_000 });

    const firstPid = Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]);
    process.kill(firstPid, "SIGKILL");
    await waitFor(readSession, (value) => value.status === "error");

    const resumed = await nativeFetch(`${bridge.base}/session/resume`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ sessionId: created.id }),
    });
    expect(resumed.status).toBe(201);

    // The replayed report describes the same turn this session already counted.
    // Latching it would swap in the replay's numbers and stamp `updatedAt` with
    // the reconnect, dating a measurement to a moment no turn ran.
    const after = await readSession();
    expect(after.contextUsage).toEqual(before.contextUsage);
  });



  test("answers attach for a session this bridge does not hold", async () => {
    const bridge = await spawnBridge();
    // The backend reads 404 here as "nothing to warm" and lets the prompt
    // request answer authoritatively, so it must not be a hard failure.
    const response = await nativeFetch(`${bridge.base}/session/missing/attach`, {
      method: "POST",
      headers: bridge.headers,
      body: "{}",
    });
    expect(response.status).toBe(404);
  });



  test("applies a vendor model update delivered as a request, not just a notification", async () => {
    const directory = await temporaryDirectory();
    const responseFile = resolve(directory, "vendor-model-response.log");
    const { base, headers } = await spawnBridge({ env: {
      ACP_PROVIDER: "grok",
      FAKE_ACP_VENDOR_MODEL_REQUEST_FILE: responseFile,
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    const dispatched = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIRECT:update models", requestId: "model-update-request" }),
    });
    expect(dispatched.status).toBe(202);

    // Rejecting unsupported vendor requests must not also reject the ones this
    // bridge does implement: the update carries real catalogue state.
    const response = await waitFor(
      () => fs.readFile(responseFile, "utf8")
        .then((value) => JSON.parse(value.trim()))
        .catch(() => null) as Promise<Record<string, unknown> | null>,
      Boolean,
    );
    expect(response).toMatchObject({ id: 902, result: {} });
    expect(response).not.toHaveProperty("error");

    const session = await waitFor(
      () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((value) => value.json()) as Promise<{
          composer: { selectedModelId?: string; models: Array<{ id: string }> };
        }>,
      (value) => value.composer.models.some((model) => model.id === "grok-next"),
    );
    expect(session.composer.selectedModelId).toBe("grok-next");
  });

});
