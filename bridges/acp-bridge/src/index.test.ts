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

describe("waitFor", () => {
  test("retries ConnectionRefused until the read succeeds", async () => {
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts < 3) throw codedError("ConnectionRefused");
      return { ready: true };
    }, (current) => current.ready);
    expect(value).toEqual({ ready: true });
    expect(attempts).toBe(3);
  });

  test("retries ECONNREFUSED until the read succeeds", async () => {
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts < 2) throw codedError("ECONNREFUSED");
      return "up";
    }, (current) => current === "up");
    expect(value).toBe("up");
    expect(attempts).toBe(2);
  });

  test("retries a real Bun fetch connection failure until the read succeeds", async () => {
    const port = await unusedPort();
    let attempts = 0;
    const value = await waitFor(async () => {
      attempts += 1;
      if (attempts >= 3) return "recovered";
      // `unusedPort` releases the port before returning, so a parallel worker
      // could in principle bind it between then and now. Convert that into an
      // explicit non-retryable error, which `waitFor` rethrows on the spot and
      // names, instead of letting it surface as a bare `expect(1).toBe(3)`.
      // Reaching attempt 3 therefore also proves Bun's own error shape is what
      // `isRetryableWaitError` classifies as retryable.
      throw await nativeFetch(`http://127.0.0.1:${port}/health`).then(
        () => new Error(`Expected 127.0.0.1:${port} to refuse the connection, but it answered`),
        (reason: unknown) => reason,
      );
    }, (current) => current === "recovered");
    expect(value).toBe("recovered");
    expect(attempts).toBe(3);
  });

  test("polls until accept is satisfied and returns the accepted value", async () => {
    let reads = 0;
    const value = await waitFor(async () => {
      reads += 1;
      return { status: reads < 3 ? "running" : "idle" };
    }, (current) => current.status === "idle");
    expect(value).toEqual({ status: "idle" });
    expect(reads).toBe(3);
  });

  test("rethrows a non-retryable coded error on the first attempt", async () => {
    const error = codedError("EPERM");
    let attempts = 0;
    await expect(waitFor(async () => {
      attempts += 1;
      throw error;
    }, () => true)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test("rethrows errors that have no code on the first attempt", async () => {
    const error = new Error("parse failed");
    let attempts = 0;
    await expect(waitFor(async () => {
      attempts += 1;
      throw error;
    }, () => true)).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test("rethrows non-object rejections on the first attempt", async () => {
    // `isRetryableWaitError` reads `error.code`, so a bare string that merely
    // *names* a retryable code — and a nullish rejection — must fail fast
    // rather than spin until the deadline.
    for (const rejection of ["ConnectionRefused", null]) {
      let attempts = 0;
      await expect(waitFor(async () => {
        attempts += 1;
        throw rejection;
      }, () => true)).rejects.toBe(rejection);
      expect(attempts).toBe(1);
    }
  });

  test("times out when ConnectionRefused never recovers and names the code", async () => {
    let attempts = 0;
    // 400 ms rather than a value just above the 20 ms poll interval: the
    // assertion below is about retrying, and one scheduler stall on a loaded
    // parallel run must not be able to consume the budget before attempt two.
    await expect(waitFor(async () => {
      attempts += 1;
      throw codedError("ConnectionRefused");
    }, () => true, 400)).rejects.toThrow(
      "Timed out waiting for ACP state: undefined (last error: ConnectionRefused)",
    );
    expect(attempts).toBeGreaterThan(1);
  });

  test("reports the last read value when accept is never satisfied", async () => {
    await expect(waitFor(
      async () => ({ status: "running" }),
      (current) => current.status === "idle",
      200,
    )).rejects.toThrow('Timed out waiting for ACP state: {"status":"running"}');
  });

  test("truncates an oversized diagnostic instead of logging the whole snapshot", async () => {
    const oversized = "x".repeat(MAX_WAIT_DIAGNOSTIC_BYTES * 2);
    const rejection = await waitFor(async () => oversized, () => false, 200)
      .then(() => null, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    const { message } = rejection as Error;
    expect(message).toContain("chars, truncated)");
    expect(message.length).toBeLessThan(oversized.length);
  });
});

describe("ACP bridge", () => {
  test("allows authenticated renderer requests from trusted local origins", async () => {
    const { base } = await spawnBridge();
    const origin = "http://127.0.0.1:1420";
    const preflight = await nativeFetch(`${base}/session/create`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-orkestrator-acp-token, content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase())
      .toContain("x-orkestrator-acp-token");

    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers: {
        origin,
        "x-orkestrator-acp-token": "integration-test-token",
        "content-type": "application/json",
      },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("access-control-allow-origin")).toBe(origin);
    const session = await created.json() as { id: string };

    // Packaged Electron renderers use an opaque origin. They still have to
    // prove possession of the bridge credential, but must not be rejected by
    // the browser-origin boundary before authentication runs.
    const opaqueOrigin = await nativeFetch(`${base}/session/${session.id}`, {
      headers: {
        origin: "null",
        "x-orkestrator-acp-token": "integration-test-token",
      },
    });
    expect(opaqueOrigin.status).toBe(200);
    expect(opaqueOrigin.headers.get("access-control-allow-origin")).toBe("null");

    const rejected = await nativeFetch(`${base}/global/health`, {
      headers: { origin: "https://attacker.invalid" },
    });
    expect(rejected.status).toBe(403);
  });

  test("withholds CORS and private-network access from the unauthenticated health route", async () => {
    const { base } = await spawnBridge();

    // `/global/health` answers before the token check. Any public page can mint
    // an opaque origin through a sandboxed iframe, so reflecting that origin
    // here — or granting Private Network Access for it — would hand the open
    // web a readable loopback probe. The route stays reachable for the
    // backend's non-browser prober; a browser just cannot read the body.
    const opaque = await nativeFetch(`${base}/global/health`, {
      headers: { origin: "null" },
    });
    expect(opaque.status).toBe(200);
    expect(opaque.headers.get("access-control-allow-origin")).toBeNull();

    const loopback = await nativeFetch(`${base}/global/health`, {
      headers: { origin: "http://127.0.0.1:1420" },
    });
    expect(loopback.status).toBe(200);
    expect(loopback.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await nativeFetch(`${base}/global/health`, {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "GET",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-private-network")).toBeNull();

    // The backend probes without an Origin header at all, which must keep
    // working — that is the only client this route exists for.
    const prober = await nativeFetch(`${base}/global/health`);
    expect(prober.status).toBe(200);
    expect(await prober.json()).toMatchObject({ ok: true });

    // Authenticated data routes still get their preflight, including the
    // private-network opt-in a packaged renderer needs.
    const dataPreflight = await nativeFetch(`${base}/session/create`, {
      method: "OPTIONS",
      headers: { origin: "null", "access-control-request-method": "POST" },
    });
    expect(dataPreflight.status).toBe(204);
    expect(dataPreflight.headers.get("access-control-allow-private-network")).toBe("true");
  });

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

  test("starts local-default Cursor ACP without project MCP auto-approval", async () => {
    expect(await readAgentArgs({ ACP_APPROVE_PROJECT_MCPS: "0" }))
      .toEqual(["--force", "acp"]);
  });

  test("treats a non-canonical Cursor MCP approval value as disabled", async () => {
    // The backend only ever writes "0" or "1". Anything else arrived from an
    // ambient environment the bridge did not choose, so it must not grant
    // repository-controlled MCP servers a host process.
    expect(await readAgentArgs({ ACP_APPROVE_PROJECT_MCPS: "true" }))
      .toEqual(["--force", "acp"]);
  });

  test("starts explicitly isolated Cursor ACP with MCP auto-approval", async () => {
    expect(await readAgentArgs({ ACP_APPROVE_PROJECT_MCPS: "1" }))
      .toEqual(["--force", "--approve-mcps", "acp"]);
  });

  test("starts Grok ACP with automatic tool approval", async () => {
    expect(await readAgentArgs({ ACP_PROVIDER: "grok" }))
      .toEqual(["--always-approve", "agent", "stdio"]);
  });

  for (const acpProvider of ["cursor", "grok"] as const) {
    test(`lists and resumes provider-owned ${acpProvider} sessions`, async () => {
      const directory = await temporaryDirectory();
      const lifecycleFile = resolve(directory, `${acpProvider}-resume-lifecycle.log`);
      const bridge = await spawnBridge({ env: {
        ACP_PROVIDER: acpProvider,
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_REPLAY_HISTORY: "1",
      } });
      const created = await nativeFetch(`${bridge.base}/session/create`, {
        method: "POST",
        headers: bridge.headers,
      }).then((response) => response.json()) as { id: string };

      const firstListResponse = await nativeFetch(`${bridge.base}/session/list`, {
        headers: bridge.headers,
      });
      expect(firstListResponse.status).toBe(200);
      const firstList = await firstListResponse.json() as {
        sessions: Array<{
          id: string;
          title?: string;
          updatedAt?: string;
          messageCount?: number;
        }>;
      };
      expect(firstList.sessions).toHaveLength(2);
      // Sessions already represented by bridge state retain that stable ID, so
      // the shared picker can exclude the session the current tab already owns.
      expect(firstList.sessions.find((session) => session.title === "Current ACP work"))
        .toMatchObject({ id: created.id, messageCount: 4 });
      const external = firstList.sessions.find((session) => session.title === "Previous ACP work");
      expect(external).toMatchObject({
        updatedAt: "2026-08-13T20:00:00.000Z",
        messageCount: 12,
      });
      expect(external?.id).not.toBe("external-session");

      const tampered = `${external!.id.slice(0, -1)}${external!.id.endsWith("A") ? "B" : "A"}`;
      const rejected = await nativeFetch(`${bridge.base}/session/resume`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({ sessionId: tampered }),
      });
      expect(rejected.status).toBe(404);

      const resumedResponse = await nativeFetch(`${bridge.base}/session/resume`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({
          sessionId: external!.id,
        }),
      });
      expect(resumedResponse.status).toBe(201);
      const resumed = await resumedResponse.json() as {
        id: string;
        sessionId: string;
        status: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(resumed.id).toBe(resumed.sessionId);
      expect(resumed.id).not.toBe(external!.id);
      expect(resumed.status).toBe("idle");
      expect(resumed.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "Earlier question"],
        ["assistant", "Earlier answer continued"],
      ]);
      expect(await fs.readFile(lifecycleFile, "utf8")).toContain("load:");

      // Once adopted, the same provider conversation resolves to the stable
      // bridge id instead of producing another wrapper around one ACP session.
      const secondList = await nativeFetch(`${bridge.base}/session/list`, {
        headers: bridge.headers,
      }).then((response) => response.json()) as { sessions: Array<{ id: string; title?: string }> };
      expect(secondList.sessions.find((session) => session.title === "Previous ACP work")?.id)
        .toBe(resumed.id);
      const duplicate = await nativeFetch(`${bridge.base}/session/resume`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({ sessionId: resumed.id }),
      }).then((response) => response.json()) as { id: string };
      expect(duplicate.id).toBe(resumed.id);
    });
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

  for (const env of ["FAKE_ACP_LIST_MISSING_CWD", "FAKE_ACP_LIST_WRONG_CWD"] as const) {
    test(`does not list ACP sessions with ${env}`, async () => {
      const bridge = await spawnBridge({ env: { [env]: "1" } });
      const response = await nativeFetch(`${bridge.base}/session/list`, { headers: bridge.headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessions: [] });
    });
  }

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

  test("ignores an agent's live echo of the user prompt", async () => {
    const bridge = await spawnBridge({ env: { FAKE_ACP_ECHO_USER_PROMPT: "1" } });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:Answered" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "idle",
    );

    // The bridge already pushed the authoritative user message, so the echo
    // must neither append a second bubble nor double the prompt text inside
    // the first one.
    expect(session.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "DIRECT:Answered"],
      ["assistant", "Answered"],
    ]);
  });

  test("does not replay history into a transcript the bridge already holds", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "reconnect-replay.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      FAKE_ACP_REPLAY_HISTORY: "1",
    } });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json()) as { id: string };
    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:Answered" }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ role: string; content: string; parts: Array<{ type: string }> }>;
        }>;
    const before = await waitFor(readSession, (value) => value.status === "idle");
    expect(before.messages).toHaveLength(2);

    const firstPid = Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]);
    process.kill(firstPid, "SIGKILL");
    await waitFor(readSession, (value) => value.status === "error");

    const resumed = await nativeFetch(`${bridge.base}/session/resume`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ sessionId: created.id }),
    });
    expect(resumed.status).toBe(201);
    const after = await resumed.json() as {
      messages: Array<{ role: string; content: string; parts: Array<{ type: string }> }>;
    };
    // Replayed text and replayed tool calls are both suppressed: the agent is
    // re-describing a conversation this session already stores.
    expect(after.messages.map((message) => [message.role, message.content]))
      .toEqual(before.messages.map((message) => [message.role, message.content]));
    expect(after.messages.flatMap((message) => message.parts.map((part) => part.type)))
      .toEqual(before.messages.flatMap((message) => message.parts.map((part) => part.type)));
    expect(after.messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-invocation")).toHaveLength(0);
  });

  test("hydrates replayed history that carries no provider message ids", async () => {
    const bridge = await spawnBridge({ env: { FAKE_ACP_REPLAY_NO_MESSAGE_IDS: "1" } });
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
      messages: Array<{
        role: string;
        content: string;
        parts: Array<{ type: string; content: string }>;
      }>;
    };

    expect(session.messages.map((message) => [
      message.role,
      message.parts.map((part) => `${part.type}:${part.content}`),
    ])).toEqual([
      // Array-form content is flattened into one block rather than dropped.
      ["user", ["text:Earlier question"]],
      // A thought chunk followed by a text chunk is one assistant turn, so the
      // change of part type must not open a second message.
      ["assistant", ["thinking:Thinking first", "text:Earlier answer continued"]],
      // A whole-message update always begins a new turn.
      ["assistant", ["text:Second answer"]],
    ]);
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

  test("stops paging when the agent repeats a cursor it already issued", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "looping-cursors.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_LIST_REPEAT_CURSOR: "1",
      FAKE_ACP_LIST_COUNTER_FILE: counterFile,
    } });

    const listed = await nativeFetch(`${bridge.base}/session/list`, { headers: bridge.headers })
      .then((response) => response.json()) as { sessions: Array<{ title?: string }> };

    expect(listed.sessions.map((session) => session.title)).toEqual(["Looping ACP work"]);
    // Two requests: the first issues the cursor, the second sees it repeat and
    // breaks rather than running to the page cap.
    expect(await fs.readFile(counterFile, "utf8")).toBe("<none>\nsame-cursor\n");
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

  test("bounds remembered provider message ids during a large replay", async () => {
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_REPLAY_MESSAGE_COUNT: "1200",
    } });
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
      status: string;
      baseIndex: number;
      messages: Array<{ role: string }>;
    };

    // More distinct provider message ids than either bound allows. The session
    // stays usable, the transcript stays capped, and the eviction is reported
    // through `baseIndex` rather than silently shifting the client's window.
    expect(session.status).toBe("idle");
    expect(session.messages.length).toBeLessThanOrEqual(500);
    expect(session.baseIndex).toBeGreaterThan(0);
  });

  test("drives an ACP session and rehydrates a parked permission", async () => {
    const { base, headers } = await spawnBridge();

    const unauthorized = await nativeFetch(`${base}/session/create`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    const createdResponse = await nativeFetch(`${base}/session/create`, { method: "POST", headers });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string };

    const promptResponse = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Do the work" }),
    });
    expect(promptResponse.status).toBe(202);
    const approval = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) => response.json()) as Promise<{ approvals: Array<{ id: string; approvalId: string; title: string; kind: string }> }>,
      (value) => value.approvals.length === 1,
    );
    expect(approval.approvals[0]?.title).toBe("Run safe command");
    expect(approval.approvals[0]).toMatchObject({
      approvalId: approval.approvals[0]!.id,
      kind: "permissions",
    });

    const resolveResponse = await nativeFetch(
      `${base}/session/${created.id}/approvals/${approval.approvals[0]!.id}`,
      { method: "POST", headers, body: JSON.stringify({ decision: "approve" }) },
    );
    expect(resolveResponse.ok).toBe(true);
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string; messages: Array<{ content: string; parts: unknown[] }> }>,
      (value) => value.status === "idle",
    );
    expect(session.messages.map((message) => message.content)).toEqual(["Do the work", "approved:once"]);
    expect(session.messages[1]?.parts).toEqual([
      {
        type: "thinking",
        content: "Checking permission. ",
        sourcePartId: expect.any(String),
        sourceMessageId: expect.any(String),
      },
      {
        type: "tool-invocation",
        content: "Run safe command",
        sourcePartId: "tool:tool-1",
        sourceMessageId: expect.any(String),
        toolUseId: "tool-1",
        toolName: "execute",
        toolArgs: { command: "printf ok" },
        toolState: "success",
        toolTitle: "Run safe command",
        toolOutput: JSON.stringify({ exitCode: 0, stdout: "ok" }, null, 2),
      },
      {
        type: "text",
        content: "approved:once",
        sourcePartId: expect.any(String),
        sourceMessageId: expect.any(String),
      },
    ]);
  });

  for (const { provider, modelId } of [
    { provider: "cursor", modelId: "gpt-5.5" },
    { provider: "grok", modelId: "grok-composer-2.5-fast" },
  ] as const) {
    test(`attributes ${provider} assistant messages to the selected model across restart`, async () => {
      const stateDirectory = await temporaryDirectory();
      const first = await spawnBridge({
        stateDirectory,
        env: { ACP_PROVIDER: provider },
      });
      const created = await nativeFetch(`${first.base}/session/create`, {
        method: "POST",
        headers: first.headers,
        body: JSON.stringify({ clientSessionKey: `env-model:${provider}` }),
      }).then((response) => response.json()) as { id: string };

      const dispatched = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
        method: "POST",
        headers: first.headers,
        body: JSON.stringify({
          prompt: "DIRECT:model attribution",
          requestId: `model-attribution-${provider}`,
          modelId,
        }),
      });
      expect(dispatched.status).toBe(202);

      const session = await waitFor(
        () => nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers })
          .then((response) => response.json()) as Promise<{
            status: string;
            messages: Array<{ role: string; modelId?: string }>;
          }>,
        (value) => value.status === "idle",
      );
      expect(session.messages.find((message) => message.role === "assistant")?.modelId)
        .toBe(modelId);

      await waitFor(
        () => fs.readFile(resolve(stateDirectory, "state.json"), "utf8")
          .then((contents) => JSON.parse(contents) as {
            sessions: Array<{ messages: Array<{ role: string; modelId?: string }> }>;
          }),
        (value) => value.sessions.some((persisted) =>
          persisted.messages.some((message) =>
            message.role === "assistant" && message.modelId === modelId
          )
        ),
      );
      await stopChild(first.child);

      const restarted = await spawnBridge({
        stateDirectory,
        env: { ACP_PROVIDER: provider },
      });
      const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
        headers: restarted.headers,
      }).then((response) => response.json()) as {
        messages: Array<{ role: string; modelId?: string }>;
      };
      expect(restored.messages.find((message) => message.role === "assistant")?.modelId)
        .toBe(modelId);
    });
  }

  // The attribution has to be *stored per message*, not derived from whatever
  // the composer currently has selected. Switching models mid-session is the
  // only assertion that separates the two: a restart alone cannot, because the
  // composer restores to the same selection the messages were stamped with.
  test("keeps each assistant message on the model that produced it when the model changes", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-switch:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    const readSession = (bridge: { base: string; headers: Record<string, string> }) =>
      waitFor(
        () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
          .then((response) => response.json()) as Promise<{
            status: string;
            messages: Array<{ role: string; content: string; modelId?: string }>;
          }>,
        (value) => value.status === "idle",
      );

    // No `modelId` in the body: the turn runs on the agent's own default, and
    // that default is what the message must record.
    const firstTurn = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "DIRECT:first turn", requestId: "switch-1" }),
    });
    expect(firstTurn.status).toBe(202);
    await readSession(first);

    const secondTurn = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({
        prompt: "DIRECT:second turn",
        requestId: "switch-2",
        modelId: "gpt-5.5",
      }),
    });
    expect(secondTurn.status).toBe(202);
    // The 202 is written after the route has already set the session running,
    // so this cannot observe the previous turn's idle snapshot.
    const session = await readSession(first);

    expect(session.messages.map((message) => [message.role, message.modelId])).toEqual([
      // A user message is never attributed to a model.
      ["user", undefined],
      ["assistant", "composer-2.5"],
      ["user", undefined],
      ["assistant", "gpt-5.5"],
    ]);
    // The first reply keeps its own model even though the composer has since
    // moved on, which is what a derived-at-read-time stamp would get wrong.
    expect(session.messages[1]?.content).toBe("first turn");
    expect(session.messages[3]?.content).toBe("second turn");

    await waitFor(
      () => fs.readFile(resolve(stateDirectory, "state.json"), "utf8")
        .then((contents) => JSON.parse(contents) as {
          sessions: Array<{ messages: Array<{ role: string; modelId?: string }> }>;
        }),
      (value) => value.sessions.some((persisted) =>
        persisted.messages.filter((message) => message.role === "assistant").length === 2
      ),
    );
    await stopChild(first.child);

    const restarted = await spawnBridge({ stateDirectory });
    const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json()) as {
      messages: Array<{ role: string; modelId?: string }>;
    };
    expect(
      restored.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.modelId),
    ).toEqual(["composer-2.5", "gpt-5.5"]);
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

  test("drops a persisted model id that is blank, oversized, or not a string", async () => {
    const stateDirectory = await temporaryDirectory();
    const assistantMessage = (id: string, modelId: unknown) => ({
      id,
      role: "assistant",
      content: id,
      parts: [{
        type: "text",
        content: id,
        sourcePartId: `${id}:0`,
        sourceMessageId: id,
      }],
      createdAt: "2026-08-01T00:00:00.000Z",
      modelId,
    });
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({
        version: 3,
        provider: "cursor",
        sessions: [{
          id: "session-model-ids",
          clientSessionKey: "env-1:tab-1",
          acpSessionId: "acp-session-model-ids",
          status: "idle",
          revision: 4,
          structured: [],
          promptJournal: [],
          messages: [
            assistantMessage("kept", "  gpt-5.5  "),
            assistantMessage("blank", "   "),
            // One byte past the bound the live composer enforces. An identifier
            // must be dropped rather than shortened into one that matches no
            // catalogue entry.
            assistantMessage("oversized", "m".repeat(1025)),
            assistantMessage("nonstring", 42),
            assistantMessage("absent", undefined),
          ],
        }],
      }),
    );

    const bridge = await spawnBridge({ stateDirectory });
    const session = await nativeFetch(`${bridge.base}/session/session-model-ids`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as {
      messages: Array<Record<string, unknown>>;
    };

    expect(session.messages.map((message) => message.id))
      .toEqual(["kept", "blank", "oversized", "nonstring", "absent"]);
    // Trimmed and kept, then dropped outright for every unusable form.
    expect(session.messages[0]?.modelId).toBe("gpt-5.5");
    expect(session.messages.slice(1).map((message) => "modelId" in message))
      .toEqual([false, false, false, false]);
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

  test("normalizes ACP tool calls, upserts updates, and rehydrates them after restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    const promptResponse = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "TOOLS: edit the file" }),
    });
    expect(promptResponse.status).toBe(202);

    const session = await waitFor(
      async () => nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    const assistantParts = session.messages[1]?.parts;
    expect(assistantParts?.map((part) => part.type)).toEqual([
      "thinking",
      "tool-invocation",
      "tool-invocation",
      "text",
    ]);
    expect(assistantParts?.filter((part) => part.toolUseId === "edit-1")).toHaveLength(1);
    expect(assistantParts?.[1]).toMatchObject({
      type: "tool-invocation",
      content: "Edit `src/example.ts`",
      sourcePartId: "tool:edit-1",
      sourceMessageId: expect.any(String),
      toolUseId: "edit-1",
      toolName: "edit",
      toolArgs: { path: "src/example.ts" },
      toolState: "success",
      toolTitle: "Edit `src/example.ts`",
      toolOutput: JSON.stringify({ success: true }, null, 2),
      toolDiff: {
        filePath: "src/example.ts",
        additions: 2,
        deletions: 1,
      },
    });
    const editDiff = assistantParts?.[1]?.toolDiff as Record<string, unknown> | undefined;
    expect(editDiff?.diff).toContain("-const value = 1;\n+const value = 2;\n+const ready = true;");
    // The rendered diff is what the renderer reads, so the whole-file states it
    // would never fall back to are not carried alongside it.
    expect(editDiff?.before).toBeUndefined();
    expect(editDiff?.after).toBeUndefined();
    expect(assistantParts?.[2]).toMatchObject({
      type: "tool-invocation",
      content: "Search for references",
      toolUseId: "search-1",
      toolName: "search",
      toolArgs: { pattern: "value" },
      toolState: "success",
      toolTitle: "Search for references",
      toolOutput: JSON.stringify({ totalMatches: 3 }, null, 2),
    });

    await waitFor(
      async () => JSON.parse(
        await fs.readFile(resolve(stateDirectory, "state.json"), "utf8"),
      ) as {
        version: number;
        sessions: Array<{ messages: Array<{ parts: Array<{ toolUseId?: string }> }> }>;
      },
      (value) => value.version === 3
        && value.sessions[0]?.messages.some((message) =>
          message.parts.some((part) => part.toolUseId === "edit-1")
        ) === true,
    );
    await stopChild(first.child);

    const restarted = await spawnBridge({ stateDirectory });
    const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json()) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(restored.messages[1]?.parts).toEqual(assistantParts);
  });

  test("keeps Cursor's completed Task launch active until the background sub-agent ends", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-background-subagent:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT: validate" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(settled.messages[1]?.parts[0]).toMatchObject({
      type: "tool-invocation",
      toolUseId: "cursor-subagent-1",
      toolName: "task",
      toolState: "success",
      agentState: "active",
      toolOutput: "Sub-agent launched.",
    });
    expect(await nativeFetch(`${first.base}/session/${created.id}/activity`, {
      headers: first.headers,
    }).then((response) => response.json())).toEqual({ activity: "working" });

    await stopChild(first.child);
    const restarted = await spawnBridge({ stateDirectory });
    const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json()) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    // The background child belonged to the old Cursor process, so restart is
    // authoritative evidence that it cannot still be running.
    expect(restored.messages[1]?.parts[0]).toMatchObject({
      toolState: "success",
      agentState: "failed",
    });
    expect(await nativeFetch(`${restarted.base}/session/${created.id}/activity`, {
      headers: restarted.headers,
    }).then((response) => response.json())).toEqual({ activity: "idle" });
  });

  test("preserves ACP nested child parentToolCallId as parentTaskUseId", async () => {
    const bridge = await spawnBridge();
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-nested-subagent:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "NESTEDSUBAGENT: inspect" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    const parts = settled.messages.flatMap((message) => message.parts);
    expect(parts.find((part) => part.toolUseId === "cursor-subagent-1")).toMatchObject({
      toolName: "task",
      agentState: "active",
    });
    // Every vendor spelling the bridge claims to accept, proven individually.
    expect(new Map(parts
      .filter((part) => typeof part.toolUseId === "string"
        && part.toolUseId.startsWith("cursor-child-"))
      .map((part) => [part.toolUseId, part.parentTaskUseId]))).toEqual(new Map([
        ["cursor-child-grep-1", "cursor-subagent-1"],
        ["cursor-child-read-2", "cursor-subagent-1"],
        ["cursor-child-edit-3", "cursor-subagent-1"],
        ["cursor-child-list-4", "cursor-subagent-1"],
        ["cursor-child-claude-5", "cursor-subagent-1"],
        ["cursor-child-claude-6", "cursor-subagent-1"],
        // A call naming itself is dropped rather than self-parented.
        ["cursor-child-self-7", undefined],
      ]));
    expect(parts.find((part) => part.toolUseId === "cursor-child-grep-1")).toMatchObject({
      toolTitle: "Search Find",
      parentTaskUseId: "cursor-subagent-1",
    });
    expect(JSON.stringify(settled)).not.toContain("_meta");
    expect(JSON.stringify(settled)).not.toContain("parentToolCallId");
  });

  // The rail and the nested agent row both key off `parentTaskUseId`, so losing
  // it across a bridge restart would silently flatten a restored transcript
  // back into unattributed top-level tool rows.
  test("restores nested child parentTaskUseId after a bridge restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-nested-restart:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "NESTEDSUBAGENT: inspect" }),
    })).status).toBe(202);

    await waitFor(
      async () => nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );
    // Persistence is debounced, so the restart has to wait for the writer
    // rather than for the turn that produced the parts.
    await waitFor(
      () => fs.readFile(resolve(stateDirectory, "state.json"), "utf8")
        .then((contents) => contents)
        .catch(() => ""),
      (contents) => contents.includes("cursor-child-grep-1"),
    );
    await stopChild(first.child);

    const restarted = await spawnBridge({ stateDirectory });
    const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json()) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    const restoredParts = restored.messages.flatMap((message) => message.parts);
    expect(restoredParts.find((part) => part.toolUseId === "cursor-child-grep-1"))
      .toMatchObject({ parentTaskUseId: "cursor-subagent-1" });
    expect(restoredParts.find((part) => part.toolUseId === "cursor-child-claude-5"))
      .toMatchObject({ parentTaskUseId: "cursor-subagent-1" });
    expect(restoredParts.find((part) => part.toolUseId === "cursor-child-self-7"))
      .not.toHaveProperty("parentTaskUseId");
    // The launch part still has to be findable, or the restored children would
    // have a parent id pointing at nothing.
    expect(restoredParts.find((part) => part.toolUseId === "cursor-subagent-1"))
      .toMatchObject({ toolName: "task" });
  });

  test("fails active child markers replayed while adopting provider history", async () => {
    const bridge = await spawnBridge({ env: { FAKE_ACP_REPLAY_ACTIVE_SUBAGENT: "1" } });
    const listed = await nativeFetch(`${bridge.base}/session/list`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as {
      sessions: Array<{ id: string; title?: string }>;
    };
    const external = listed.sessions.find((session) => session.title === "Previous ACP work");
    expect(external).toBeDefined();

    const resumedResponse = await nativeFetch(`${bridge.base}/session/resume`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ sessionId: external!.id }),
    });
    expect(resumedResponse.status).toBe(201);
    const resumed = await resumedResponse.json() as {
      id: string;
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(resumed.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "history-background-child"
    )).toMatchObject({ toolState: "success", agentState: "failed" });
    expect(await nativeFetch(`${bridge.base}/session/${resumed.id}/activity`, {
      headers: bridge.headers,
    }).then((response) => response.json())).toEqual({ activity: "idle" });
  });

  test("fails a pending Task launch abandoned when its parent turn ends", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "PENDINGSUBAGENT" }),
    });
    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(settled.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "abandoned-subagent-1"
    )).toMatchObject({ toolState: "failure", agentState: "failed" });
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });
  });

  test("latches a fatal error when active children exceed the bounded registry", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const { base, headers } = first;
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "SUBAGENTOVERFLOW" }),
    });
    const failed = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "error",
    );
    expect(failed.error).toBe("cursor exceeded the active sub-agent limit");
    expect(failed.messages.flatMap((message) => message.parts).some((part) =>
      part.agentState === "active"
    )).toBe(false);
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });

    const rejected = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "Session exceeded the active sub-agent limit" });
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });

    await stopChild(first.child);
    const restarted = await spawnBridge({ stateDirectory });
    const rejectedAfterRestart = await nativeFetch(`${restarted.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: restarted.headers,
      body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
    });
    expect(rejectedAfterRestart.status).toBe(409);
    expect(await rejectedAfterRestart.json())
      .toEqual({ error: "Session exceeded the active sub-agent limit" });
  });

  for (const terminal of [
    { prompt: "FINISHCURSORSUBAGENT", agentState: "finished", toolState: "success" },
    { prompt: "FINISHCURSORSUBAGENTSTATUS", agentState: "finished", toolState: "success" },
    { prompt: "FINISHCURSORTASK", agentState: "finished", toolState: "success" },
    { prompt: "FAILCURSORTASK", agentState: "failed", toolState: "success" },
    { prompt: "REJECTCURSORTASK", agentState: "failed", toolState: "success" },
    { prompt: "FAILCURSORSUBAGENT", agentState: "failed", toolState: "failure" },
  ] as const) {
    test(`settles Cursor's in-process child via ${terminal.prompt} as ${terminal.agentState}`, async () => {
      const { base, headers } = await spawnBridge();
      const created = await nativeFetch(`${base}/session/create`, {
        method: "POST",
        headers,
      }).then((response) => response.json()) as { id: string };
      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
      });
      await waitFor(
        async () => nativeFetch(`${base}/session/${created.id}/activity`, { headers })
          .then((response) => response.json()) as Promise<{ activity: string }>,
        (value) => value.activity === "working",
      );

      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: terminal.prompt }),
      });
      const settled = await waitFor(
        async () => nativeFetch(`${base}/session/${created.id}`, { headers })
          .then((response) => response.json()) as Promise<{
            status: string;
            messages: Array<{ parts: Array<Record<string, unknown>> }>;
          }>,
        (value) => value.status === "idle"
          && value.messages.some((message) => message.parts.some((part) =>
            part.toolUseId === "cursor-subagent-1" && part.agentState === terminal.agentState
          )),
      );
      expect(settled.messages.flatMap((message) => message.parts).find((part) =>
        part.toolUseId === "cursor-subagent-1"
      )).toMatchObject({ toolState: terminal.toolState, agentState: terminal.agentState });
      expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
        .then((response) => response.json())).toEqual({ activity: "idle" });
    });
  }

  // The request form is the only one the pinned `cursor-agent` sends: its
  // `sendNonBlockingExtensionNotification` helper calls `extMethod`, which is
  // `sendRequest`. The answer is a bare `{}` because Cursor discards the result
  // and the method publishes no response schema to fill in.
  for (const request of [
    { prompt: "FINISHCURSORTASKREQUEST", label: "a completed child", agentState: "finished" },
    { prompt: "FAILCURSORTASKREQUEST", label: "a failed child", agentState: "failed" },
  ] as const) {
    test(`answers Cursor's cursor/task request for ${request.label} and settles it`, async () => {
      const directory = await temporaryDirectory();
      const responseFile = resolve(directory, "cursor-task-response.log");
      const { base, headers } = await spawnBridge({ env: {
        FAKE_ACP_CURSOR_TASK_REQUEST_FILE: responseFile,
      } });
      const created = await nativeFetch(`${base}/session/create`, {
        method: "POST",
        headers,
      }).then((response) => response.json()) as { id: string };
      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
      });
      await waitFor(
        async () => nativeFetch(`${base}/session/${created.id}/activity`, { headers })
          .then((response) => response.json()) as Promise<{ activity: string }>,
        (value) => value.activity === "working",
      );

      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: request.prompt }),
      });
      const response = await waitFor(
        () => fs.readFile(responseFile, "utf8")
          .then((value) => JSON.parse(value.trim()))
          .catch(() => null) as Promise<Record<string, unknown> | null>,
        Boolean,
      );
      expect(response).toMatchObject({ id: 903, result: {} });
      expect(response).not.toHaveProperty("error");
      // Not the ACP permission outcome. Its members are `selected` and
      // `cancelled`; neither describes a child that ended.
      expect(response).not.toHaveProperty("result.outcome");
      const settled = await waitFor(
        async () => nativeFetch(`${base}/session/${created.id}`, { headers })
          .then((response) => response.json()) as Promise<{
            status: string;
            messages: Array<{ parts: Array<Record<string, unknown>> }>;
          }>,
        (value) => value.status === "idle"
          && value.messages.some((message) => message.parts.some((part) =>
            part.toolUseId === "cursor-subagent-1" && part.agentState === request.agentState
          )),
      );
      expect(settled.messages.flatMap((message) => message.parts).find((part) =>
        part.toolUseId === "cursor-subagent-1"
      )).toMatchObject({ toolState: "success", agentState: request.agentState });
      expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
        .then((response) => response.json())).toEqual({ activity: "idle" });
    });
  }

  // Each of these turns delivers a `cursor/task` the bridge must ignore. The
  // turn is allowed to finish before the assertion, so a still-active child is
  // evidence the frame was processed and rejected — not that the test raced it.
  for (const ignored of [
    {
      prompt: "RUNNINGCURSORTASK",
      reason: "reports a non-terminal state",
    },
    {
      prompt: "OTHERSESSIONCURSORTASK",
      reason: "belongs to another ACP session",
    },
    {
      prompt: "UNKNOWNCURSORTASK",
      reason: "names a tool call that is not a live child",
    },
  ] as const) {
    test(`ignores a cursor/task that ${ignored.reason}`, async () => {
      const { base, headers } = await spawnBridge();
      const created = await nativeFetch(`${base}/session/create`, {
        method: "POST",
        headers,
      }).then((response) => response.json()) as { id: string };
      const read = async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ content?: string; parts: Array<Record<string, unknown>> }>;
        }>;
      const activity = async () => nativeFetch(`${base}/session/${created.id}/activity`, { headers })
        .then((response) => response.json()) as Promise<{ activity: string }>;

      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
      });
      await waitFor(activity, (value) => value.activity === "working");

      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: ignored.prompt }),
      });
      // The marker is written after the frame on the same stream, so its
      // arrival is what makes "still active" below an observation, not a race.
      const held = await waitFor(
        read,
        (value) => value.status === "idle"
          && value.messages.some((message) =>
            message.content?.includes("Cursor task frame delivered.") === true
          ),
      );
      const parts = held.messages.flatMap((message) => message.parts);
      expect(parts.find((part) => part.toolUseId === "cursor-subagent-1"))
        .toMatchObject({ agentState: "active" });
      expect(await activity()).toEqual({ activity: "working" });
      // An ignored frame must not invent a launch part for the id it named.
      expect(parts.some((part) => part.toolUseId === "cursor-never-seen-1")).toBe(false);
      const plain = parts.find((part) => part.toolUseId === "cursor-plain-tool-1");
      if (plain) expect(plain).not.toHaveProperty("agentState");

      // The same child still settles once a frame the bridge accepts arrives,
      // so the guard rejects the bad frame rather than the method.
      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "FINISHCURSORTASK" }),
      });
      const settled = await waitFor(
        read,
        (value) => value.status === "idle"
          && value.messages.some((message) => message.parts.some((part) =>
            part.toolUseId === "cursor-subagent-1" && part.agentState === "finished"
          )),
      );
      expect(settled.messages.flatMap((message) => message.parts).find((part) =>
        part.toolUseId === "cursor-subagent-1"
      )).toMatchObject({ toolState: "success", agentState: "finished" });
      expect(await activity()).toEqual({ activity: "idle" });
    });
  }

  test("tracks Grok's metadata-described sub-agent until its terminal notification", async () => {
    const { base, headers } = await spawnBridge({ env: { ACP_PROVIDER: "grok" } });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-grok-background-subagent:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT: validate" }),
    })).status).toBe(202);

    const active = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "grok-subagent-tool-1" && part.agentState === "active"
        )),
    );
    expect(active.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "grok-subagent-tool-1"
    )).toMatchObject({
      type: "tool-invocation",
      toolName: "spawn_subagent",
      toolState: "success",
      agentState: "active",
      toolArgs: {
        variant: "Task",
        run_in_background: true,
        description: "Validate the implementation",
        subagent_type: "explore",
      },
    });
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, {
      headers,
    }).then((response) => response.json())).toEqual({ activity: "working" });

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FINISHSUBAGENT" }),
    })).status).toBe(202);

    const finished = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "grok-subagent-tool-1" && part.agentState === "finished"
        )),
    );
    expect(finished.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "grok-subagent-tool-1"
    )).toMatchObject({ toolState: "success", agentState: "finished" });
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, {
      headers,
    }).then((response) => response.json())).toEqual({ activity: "idle" });
  });

  test("correlates concurrent Grok children without claiming mismatched spawns", async () => {
    const { base, headers } = await spawnBridge({ env: { ACP_PROVIDER: "grok" } });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };
    const read = async () => nativeFetch(`${base}/session/${created.id}`, { headers })
      .then((response) => response.json()) as Promise<{
        status: string;
        messages: Array<{ parts: Array<Record<string, unknown>> }>;
      }>;

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "GROKMULTISUBAGENT" }),
    });
    await waitFor(read, (value) => value.status === "idle"
      && value.messages.flatMap((message) => message.parts)
        .filter((part) => part.agentState === "active").length === 2);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FAILGROKSUBAGENT_B" }),
    });
    const oneActive = await waitFor(read, (value) => value.status === "idle"
      && value.messages.flatMap((message) => message.parts).some((part) =>
        part.toolUseId === "grok-multi-tool-b" && part.agentState === "failed"
      ));
    const parts = oneActive.messages.flatMap((message) => message.parts);
    expect(parts.find((part) => part.toolUseId === "grok-multi-tool-a"))
      .toMatchObject({ agentState: "active" });
    expect(parts.find((part) => part.toolUseId === "grok-multi-tool-b"))
      .toMatchObject({ agentState: "failed" });
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "working" });

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CANCELGROKSUBAGENT_A" }),
    });
    await waitFor(read, (value) => value.status === "idle"
      && value.messages.flatMap((message) => message.parts).some((part) =>
        part.toolUseId === "grok-multi-tool-a" && part.agentState === "failed"
      ));
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });
  });

  test("keeps Grok child activity authoritative across transcript eviction and a late finish", async () => {
    const { base, headers } = await spawnBridge({ env: {
      ACP_PROVIDER: "grok",
      ACP_MAX_TRANSCRIPT_BYTES: "1048576",
    } });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };
    const read = async () => nativeFetch(`${base}/session/${created.id}`, { headers })
      .then((response) => response.json()) as Promise<{
        status: string;
        baseIndex: number;
        messages: Array<{ parts: Array<Record<string, unknown>> }>;
      }>;

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "EVICTGROKSUBAGENT" }),
    });
    const evicted = await waitFor(read, (value) => value.status === "idle");
    expect(evicted.messages.flatMap((message) => message.parts).some((part) =>
      part.toolUseId === "grok-evicted-tool"
    )).toBe(false);
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "working" });

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FINISHEVICTEDGROKSUBAGENT" }),
    });
    await waitFor(read, (value) => value.status === "idle");
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });
    const after = await read();
    expect(after.baseIndex).toBeGreaterThan(0);
    expect(after.messages.flatMap((message) => message.parts).some((part) =>
      part.toolUseId === "grok-evicted-tool"
    )).toBe(false);
  });

  test("settles an evicted Cursor child without rebuilding a ghost launch part", async () => {
    const { base, headers } = await spawnBridge({ env: {
      ACP_MAX_TRANSCRIPT_BYTES: "1048576",
    } });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };
    const read = async () => nativeFetch(`${base}/session/${created.id}`, { headers })
      .then((response) => response.json()) as Promise<{
        status: string;
        baseIndex: number;
        messages: Array<{ parts: Array<Record<string, unknown>> }>;
      }>;

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
    });
    await waitFor(read, (value) => value.status === "idle");
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "working" });

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FINISHEVICTEDCURSORSUBAGENT" }),
    });
    const settled = await waitFor(read, (value) => value.status === "idle");
    expect(settled.baseIndex).toBeGreaterThan(0);
    expect(settled.messages.flatMap((message) => message.parts).some((part) =>
      part.toolUseId === "cursor-subagent-1"
    )).toBe(false);
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });
  });

  test("settles an evicted Cursor child from cursor/task without rebuilding a ghost launch part", async () => {
    const { base, headers } = await spawnBridge({ env: {
      ACP_MAX_TRANSCRIPT_BYTES: "1048576",
    } });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };
    const read = async () => nativeFetch(`${base}/session/${created.id}`, { headers })
      .then((response) => response.json()) as Promise<{
        status: string;
        baseIndex: number;
        messages: Array<{ parts: Array<Record<string, unknown>> }>;
      }>;

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
    });
    await waitFor(read, (value) => value.status === "idle");
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "working" });

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FINISHEVICTEDCURSORTASK" }),
    });
    const settled = await waitFor(read, (value) => value.status === "idle");
    expect(settled.baseIndex).toBeGreaterThan(0);
    expect(settled.messages.flatMap((message) => message.parts).some((part) =>
      part.toolUseId === "cursor-subagent-1"
    )).toBe(false);
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });
  });

  test("enriches Cursor's generic live tool calls from its post-turn ACP replay", async () => {
    const bridge = await spawnBridge({
      env: { FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1" },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-tools:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    const promptResponse = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS" }),
    });
    expect(promptResponse.status).toBe(202);

    const session = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle"
        && value.messages[1]?.parts.some(
          (part) => part.toolTitle === "Read package.json (1 - 80)",
        ) === true,
    );
    const tools = session.messages[1]?.parts.filter((part) => part.type === "tool-invocation");
    expect(tools).toEqual([
      expect.objectContaining({
        toolUseId: "live-read-1",
        toolName: "read",
        toolTitle: "Read package.json (1 - 80)",
        content: "Read package.json (1 - 80)",
        toolArgs: { path: "/workspace/package.json" },
        toolState: "success",
      }),
      expect.objectContaining({
        toolUseId: "live-search-1",
        toolName: "search",
        toolTitle: "grep --include=\"*.json\" \"scripts\"",
        content: "grep --include=\"*.json\" \"scripts\"",
        toolArgs: { pattern: "scripts", path: "/workspace" },
        toolState: "success",
      }),
    ]);
  });

  test("enriches completed Cursor tool titles while the turn is still running", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-live-replay.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-live-tools:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    const promptResponse = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_RUNNING" }),
    });
    expect(promptResponse.status).toBe(202);

    // The fake agent holds this turn open until released below, so the enriched
    // titles below are observed while the turn is genuinely still running
    // rather than by beating it to the finish.
    const enriched = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "running"
        && value.messages[1]?.parts.some(
          (part) => part.toolTitle === "Read package.json (1 - 80)",
        ) === true,
    );
    expect(enriched.status).toBe("running");
    expect(enriched.messages[1]?.parts.filter((part) => part.type === "tool-invocation"))
      .toEqual([
        expect.objectContaining({
          toolUseId: "live-read-1",
          toolTitle: "Read package.json (1 - 80)",
          toolArgs: { path: "/workspace/package.json" },
        }),
        expect.objectContaining({
          toolUseId: "live-search-1",
          toolTitle: "grep --include=\"*.json\" \"scripts\"",
          toolArgs: { pattern: "scripts", path: "/workspace" },
        }),
      ]);
    // Both calls settled in one burst, so the scheduler owes exactly one
    // replay: a child per completion update would multiply processes and race
    // several identical joins over the same parts.
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );
    expect(settled.status).toBe("idle");
    // Nothing is generic any more, so the final pass finds no targets and never
    // spawns a second child.
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);
  });

  test("enriches a settled Cursor read while a same-kind sibling is still in flight", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-pending-sibling.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_PARALLEL_READS: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-pending-sibling:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_PENDING_SIBLING" }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
    const tools = (value: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
      value.messages[1]?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    const live = await waitFor(
      readSession,
      (value) => tools(value).some(
        (part) => part.toolUseId === "live-read-2"
          && part.toolTitle === "Read second.json (1 - 20)",
      ),
    );
    // `live-read-2` is in the index; `live-read-1` is not. The live pass has to
    // enrich the settled call from a unique output match and leave the pending
    // one generic — using the kind fallback here would stamp the wrong file
    // onto `live-read-1` permanently.
    expect(tools(live)).toEqual([
      expect.objectContaining({ toolUseId: "live-read-1", toolTitle: "Read File", toolState: "pending" }),
      expect.objectContaining({
        toolUseId: "live-read-2",
        toolTitle: "Read second.json (1 - 20)",
        toolArgs: { path: "/workspace/second.json" },
        toolState: "success",
      }),
    ]);
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle"
        && tools(value).every((part) => part.toolTitle !== "Read File"),
    );
    // Both entries exist by the final pass, and each part keeps its own file:
    // the replay arrives in completion order, the reverse of the launch order
    // the transcript holds.
    expect(tools(settled)).toEqual([
      expect.objectContaining({
        toolUseId: "live-read-1",
        toolTitle: "Read first.json (1 - 40)",
        toolArgs: { path: "/workspace/first.json" },
      }),
      expect.objectContaining({
        toolUseId: "live-read-2",
        toolTitle: "Read second.json (1 - 20)",
        toolArgs: { path: "/workspace/second.json" },
      }),
    ]);
  });

  test("enriches a settled Cursor read while a different-kind call is still in flight", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-pending-other.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-pending-other:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_PENDING_OTHER" }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
    const tools = (value: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
      value.messages[1]?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    const live = await waitFor(
      readSession,
      (value) => tools(value).some(
        (part) => part.toolUseId === "live-read-1"
          && part.toolTitle === "Read package.json (1 - 80)",
      ),
    );
    expect(tools(live)).toEqual([
      expect.objectContaining({
        toolUseId: "live-read-1",
        toolTitle: "Read package.json (1 - 80)",
        toolArgs: { path: "/workspace/package.json" },
        toolState: "success",
      }),
      expect.objectContaining({
        toolUseId: "live-shell-1",
        toolTitle: "Run safe command",
        toolState: "pending",
      }),
    ]);
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle"
        && tools(value).some((part) => part.toolUseId === "live-shell-1" && part.toolState === "success"),
    );
    expect(tools(settled).find((part) => part.toolUseId === "live-read-1"))
      .toMatchObject({
        toolTitle: "Read package.json (1 - 80)",
        toolArgs: { path: "/workspace/package.json" },
      });
  });

  test("does not stamp a stale same-kind title on a live Cursor pass", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-stale-kind.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_STALE_KIND: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-stale-kind:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_STALE_KIND" }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
    const tools = (value: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
      value.messages[1]?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => (value.match(/^load:/gm)?.length ?? 0) >= 1,
    );
    // The live window holds only the stale same-kind candidate, which has no
    // output hash. Kind fallback would stamp that file onto this part forever.
    await Bun.sleep(800);
    const live = await readSession();
    expect(live.status).toBe("running");
    expect(tools(live)).toEqual([
      expect.objectContaining({
        toolUseId: "live-read-1",
        toolTitle: "Read File",
        toolArgs: {},
        toolState: "success",
      }),
      expect.objectContaining({
        toolUseId: "live-shell-1",
        toolTitle: "Run safe command",
        toolState: "pending",
      }),
    ]);
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle"
        && tools(value).some((part) => part.toolUseId === "live-read-1"
          && part.toolTitle === "Read package.json (1 - 80)"),
    );
    expect(tools(settled).find((part) => part.toolUseId === "live-read-1"))
      .toMatchObject({
        toolTitle: "Read package.json (1 - 80)",
        toolArgs: { path: "/workspace/package.json" },
      });
  });

  test("does not spawn a second live Cursor replay after settled parts are already enriched", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-noop-followup.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const secondSettleFile = resolve(directory, "second-settle");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_PARALLEL_READS: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
        FAKE_ACP_SECOND_SETTLE_FILE: secondSettleFile,
        FAKE_ACP_LOAD_DELAY_MS: "800",
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-noop-followup:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_NOOP_FOLLOWUP" }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
    const tools = (value: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
      value.messages[1]?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => value.includes("load:"),
    );
    await fs.writeFile(secondSettleFile, "");
    const live = await waitFor(
      readSession,
      (value) => tools(value).some(
        (part) => part.toolUseId === "live-read-2"
          && part.toolTitle === "Read second.json (1 - 20)",
      ),
    );
    expect(tools(live)).toEqual([
      expect.objectContaining({ toolUseId: "live-read-1", toolTitle: "Read File", toolState: "pending" }),
      expect.objectContaining({
        toolUseId: "live-read-2",
        toolTitle: "Read second.json (1 - 20)",
        toolArgs: { path: "/workspace/second.json" },
        toolState: "success",
      }),
    ]);
    // The duplicate completion armed a follow-up live pass whose settled
    // window is already enriched. That pass must not spend another child.
    await Bun.sleep(1_200);
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle"
        && tools(value).every((part) => part.toolTitle !== "Read File"),
    );
    expect(tools(settled)).toEqual([
      expect.objectContaining({
        toolUseId: "live-read-1",
        toolTitle: "Read first.json (1 - 40)",
        toolArgs: { path: "/workspace/first.json" },
      }),
      expect.objectContaining({
        toolUseId: "live-read-2",
        toolTitle: "Read second.json (1 - 20)",
        toolArgs: { path: "/workspace/second.json" },
      }),
    ]);
  });

  test("leaves a failed Cursor read generic on the live pass and recovers at the end", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-failed-no-output.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-failed-no-output:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_FAILED_NO_OUTPUT" }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
    const tools = (value: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
      value.messages[1]?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => (value.match(/^load:/gm)?.length ?? 0) >= 1,
    );
    await Bun.sleep(800);
    const live = await readSession();
    expect(live.status).toBe("running");
    expect(tools(live)).toEqual([
      expect.objectContaining({
        toolUseId: "live-read-1",
        toolTitle: "Read File",
        toolArgs: {},
        toolState: "failure",
      }),
      expect.objectContaining({
        toolUseId: "live-shell-1",
        toolTitle: "Run safe command",
        toolState: "pending",
      }),
    ]);
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle"
        && tools(value).some((part) => part.toolUseId === "live-read-1"
          && part.toolTitle === "Read package.json (1 - 80)"),
    );
    expect(tools(settled).find((part) => part.toolUseId === "live-read-1"))
      .toMatchObject({
        toolTitle: "Read package.json (1 - 80)",
        toolArgs: { path: "/workspace/package.json" },
        toolState: "failure",
      });
  });

  test("drops a pending live Cursor replay when the turn fails", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-failed-turn.log");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-failed-turn:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_FAIL" }),
    });
    const failed = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{ status: string; error?: string }>,
      (value) => value.status === "error",
    );
    expect(failed.error).toContain("fake turn failure");

    // The generic call settled just before the failure, arming a live pass that
    // no final pass will ever consume. A failed turn gets no detached child,
    // the same way `DELETE` and shutdown withdraw one.
    await Bun.sleep(1_200);
    expect(await fs.readFile(lifecycleFile, "utf8").catch(() => "")).not.toContain("load:");
  });

  test.each([
    [
      "a structured turn is running",
      { requestId: "cursor-live-structured-1", outputSchema: { type: "object" } },
      {},
    ],
    ["the turn has no live budget left", {}, { ACP_MAX_LIVE_CURSOR_TOOL_REPLAYS: "0" }],
  ])("holds Cursor enrichment back to the final pass when %s", async (_label, body, extraEnv) => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-live-suppressed.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
        ...extraEnv,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-suppressed:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_RUNNING", ...body }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
    const titles = (value: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
      (value.messages[1]?.parts ?? [])
        .filter((part) => part.type === "tool-invocation")
        .map((part) => part.toolTitle);

    await waitFor(readSession, (value) => titles(value).length === 2);
    // A structured turn forbids the silent re-bounding the join performs, and a
    // spent budget is what stops a long turn spawning a child per settled tool.
    // Either way no live child may start while the turn is still open.
    await Bun.sleep(1_200);
    expect(await fs.readFile(lifecycleFile, "utf8").catch(() => "")).not.toContain("load:");
    expect(await readSession().then(titles)).toEqual(["Read File", "grep"]);

    await fs.writeFile(holdTurnFile, "");
    // The final pass is never suppressed, so the turn still ends enriched.
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle" && titles(value).every((title) => title !== "Read File"),
    );
    expect(titles(settled)).toEqual([
      "Read package.json (1 - 80)",
      "grep --include=\"*.json\" \"scripts\"",
    ]);
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);
  });

  test("settles the turn before a delayed Cursor replay and enriches only its captured tools", async () => {
    const stateDirectory = await temporaryDirectory();
    const lifecycleFile = resolve(stateDirectory, "cursor-replay-delay.log");
    const bridge = await spawnBridge({
      stateDirectory,
      env: {
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_LOAD_DELAY_MS: "800",
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-delay:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS" }),
    });
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => value.includes("load:"),
    );

    const whileReplayLoads = await nativeFetch(`${bridge.base}/session/${created.id}`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as { status: string };
    expect(whileReplayLoads.status).toBe("idle");
    const activity = await nativeFetch(`${bridge.base}/session/${created.id}/activity`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as { activity: string };
    expect(activity.activity).toBe("idle");

    const followUp = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:second turn" }),
    });
    expect(followUp.status).toBe(202);

    const enriched = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ content: string; parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.content === "second turn")
        && value.messages[1]?.parts.some(
          (part) => part.toolTitle === "Read package.json (1 - 80)",
        ) === true,
    );
    expect(enriched.messages[1]?.parts.find((part) => part.toolUseId === "live-read-1"))
      .toMatchObject({ toolArgs: { path: "/workspace/package.json" } });

    const persisted = await waitFor(
      async () => JSON.parse(
        await fs.readFile(resolve(stateDirectory, "state.json"), "utf8"),
      ) as {
        sessions: Array<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
      },
      (value) => value.sessions[0]?.status === "idle"
        && value.sessions[0]?.messages[1]?.parts.some(
          (part) => part.toolTitle === "Read package.json (1 - 80)",
        ) === true,
    );
    expect(persisted.sessions[0]?.status).toBe("idle");
  });

  test.each([
    ["failed", { FAKE_ACP_FAIL_LOAD_SESSION: "1" }],
    ["unsupported", { FAKE_ACP_NO_LOAD_SESSION: "1" }],
  ] as const)("keeps a completed turn idle when Cursor replay is %s", async (_label, replayEnv) => {
    const stateDirectory = await temporaryDirectory();
    const lifecycleFile = resolve(stateDirectory, "cursor-replay-unavailable.log");
    const bridge = await spawnBridge({
      stateDirectory,
      env: {
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
        ...replayEnv,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: `env-cursor-${_label}:tab-1` }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS" }),
    });
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => value.includes("stop:"),
    );
    const session = await nativeFetch(`${bridge.base}/session/${created.id}`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as {
      status: string;
      error?: string;
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(session.status).toBe("idle");
    expect(session.error).toBeUndefined();
    expect(session.messages[1]?.parts.find((part) => part.toolUseId === "live-read-1"))
      .toMatchObject({ toolTitle: "Read File", toolArgs: {} });

    const persisted = await waitFor(
      async () => JSON.parse(
        await fs.readFile(resolve(stateDirectory, "state.json"), "utf8"),
      ) as { sessions: Array<{ status: string; error?: string }> },
      (value) => value.sessions[0]?.status === "idle",
    );
    expect(persisted.sessions[0]?.error).toBeUndefined();
  });

  test("matches reordered same-kind replay tools by output and leaves ambiguous calls generic", async () => {
    const bridge = await spawnBridge({
      env: { FAKE_ACP_REPLAY_CURSOR_SAME_KIND_METADATA: "1" },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-same-kind:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_SAME_KIND_TOOLS" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.messages[1]?.parts.some(
        (part) => part.toolTitle === "Read a.json",
      ) === true,
    );
    const tools = session.messages[1]?.parts.filter((part) => part.type === "tool-invocation") ?? [];
    expect(tools.find((part) => part.toolUseId === "live-read-a"))
      .toMatchObject({ toolTitle: "Read a.json", toolArgs: { path: "/workspace/a.json" } });
    expect(tools.find((part) => part.toolUseId === "live-read-b"))
      .toMatchObject({ toolTitle: "Read b.json", toolArgs: { path: "/workspace/b.json" } });
    expect(tools.find((part) => part.toolUseId === "live-read-c"))
      .toMatchObject({ toolTitle: "Read File", toolArgs: {} });
    expect(tools.find((part) => part.toolUseId === "live-read-d"))
      .toMatchObject({ toolTitle: "Read File", toolArgs: {} });
  });

  test("bounds replay metadata before publishing and persists the trimmed transcript", async () => {
    const stateDirectory = await temporaryDirectory();
    const lifecycleFile = resolve(stateDirectory, "cursor-replay-bounds.log");
    const maximumTranscriptBytes = 1024 * 1024;
    const first = await spawnBridge({
      stateDirectory,
      env: {
        ACP_MAX_TRANSCRIPT_BYTES: String(maximumTranscriptBytes),
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_REPLAY_CURSOR_OVERSIZED_METADATA: "1",
      },
    });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-bounds:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "CURSOR_OVERSIZED_REPLAY" }),
    });
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => value.includes("stop:"),
    );
    const session = await nativeFetch(`${first.base}/session/${created.id}`, {
      headers: first.headers,
    }).then((response) => response.json()) as {
      status: string;
      baseIndex: number;
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(session.status).toBe("idle");
    expect(Buffer.byteLength(JSON.stringify(session.messages))).toBeLessThanOrEqual(maximumTranscriptBytes);
    expect(session.baseIndex).toBeGreaterThan(0);
    expect(session.messages.flatMap((message) => message.parts).some(
      (part) => typeof part.content === "string"
        && part.content.includes("Earlier steps in this response were dropped"),
    )).toBe(true);
    // Both bounds evict oldest-first, so the calls that survive the budget are
    // the *newest* ones — the metadata the live turn is most likely to need.
    // `replay-huge-b` is the one dropped, and its live part keeps the generic
    // title rather than inheriting a surviving neighbour's filename.
    const retainedTool = session.messages.flatMap((message) => message.parts).find(
      (part) => part.toolTitle === "Read huge-c.json",
    );
    expect(retainedTool?.toolUseId).toBe("live-huge-c");
    expect((retainedTool?.toolArgs as { payload?: string } | undefined)?.payload?.length)
      .toBe(480 * 1024);
    expect(session.messages.flatMap((message) => message.parts).find(
      (part) => part.toolUseId === "live-huge-b",
    )).toMatchObject({ toolTitle: "Read File", toolArgs: {} });

    const persisted = await waitFor(
      async () => JSON.parse(
        await fs.readFile(resolve(stateDirectory, "state.json"), "utf8"),
      ) as {
        sessions: Array<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
      },
      (value) => value.sessions[0]?.messages.flatMap((message) => message.parts).some(
        (part) => part.toolTitle === "Read huge-c.json",
      ) === true,
    );
    expect(persisted.sessions[0]?.status).toBe("idle");
    expect(Buffer.byteLength(JSON.stringify(persisted.sessions[0]?.messages)))
      .toBeLessThanOrEqual(maximumTranscriptBytes);

    await stopChild(first.child);
    const restarted = await spawnBridge({
      stateDirectory,
      env: { ACP_MAX_TRANSCRIPT_BYTES: String(maximumTranscriptBytes) },
    });
    const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json()) as {
      status: string;
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(restored.status).toBe("idle");
    expect(Buffer.byteLength(JSON.stringify(restored.messages))).toBeLessThanOrEqual(maximumTranscriptBytes);
  });

  test("keeps all turns settled when the Cursor replay process cap is saturated", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-replay-cap.log");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_LOAD_DELAY_MS: "800",
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
      },
    });
    const created = await Promise.all(Array.from({ length: 9 }, async (_, index) =>
      nativeFetch(`${bridge.base}/session/create`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({ clientSessionKey: `env-cursor-cap:tab-${index}` }),
      }).then((response) => response.json()) as Promise<{ id: string }>
    ));
    const promptResponses = await Promise.all(created.map((session) =>
      nativeFetch(`${bridge.base}/session/${session.id}/prompt`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS" }),
      })
    ));
    expect(promptResponses.every((response) => response.status === 202)).toBe(true);
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => (value.match(/^load:/gm)?.length ?? 0) >= 8,
    );
    const statuses = await Promise.all(created.map((session) =>
      nativeFetch(`${bridge.base}/session/${session.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{ status: string }>
    ));
    expect(statuses.every((session) => session.status === "idle")).toBe(true);

    // Past the load delay every slot has been released. A ninth load appearing
    // now would mean the refused replay was queued rather than dropped, and
    // asserting the count only on the way up could never tell the two apart.
    await Bun.sleep(1_600);
    const loads = await fs.readFile(lifecycleFile, "utf8").catch(() => "");
    expect(loads.match(/^load:/gm)?.length ?? 0).toBe(8);
  });

  test("keeps the newest replayed tools when the collector's count bound evicts", async () => {
    const bridge = await spawnBridge({
      env: { FAKE_ACP_REPLAY_CURSOR_HISTORY_TOOL_METADATA: "1" },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-history:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS" }),
    });
    // The replay leads with two calls from earlier history that have no live
    // counterpart. Capacity is the live turn's two tools, so those have to be
    // evicted rather than crowd out the calls this turn actually made.
    const session = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle"
        && value.messages[1]?.parts.some(
          (part) => part.toolTitle === "Read package.json (1 - 80)",
        ) === true,
    );
    const tools = session.messages[1]?.parts.filter((part) => part.type === "tool-invocation") ?? [];
    expect(tools.find((part) => part.toolUseId === "live-read-1"))
      .toMatchObject({ toolTitle: "Read package.json (1 - 80)", toolArgs: { path: "/workspace/package.json" } });
    expect(tools.find((part) => part.toolUseId === "live-search-1"))
      .toMatchObject({ toolTitle: "grep --include=\"*.json\" \"scripts\"" });
    expect(tools.some((part) => String(part.toolTitle).includes("stale"))).toBe(false);
  });

  test("does not let a late replay enrich an earlier turn from a later one", async () => {
    const stateDirectory = await temporaryDirectory();
    const lifecycleFile = resolve(stateDirectory, "cursor-replay-two-turn.log");
    const bridge = await spawnBridge({
      stateDirectory,
      env: {
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_LOAD_DELAY_MS: "600",
        FAKE_ACP_REPLAY_CURSOR_TWO_TURN_METADATA: "1",
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-two-turn:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS" }),
    });
    // The first turn's replay is still loading, so the second turn's tool calls
    // land in its collector. Its window is sized for the first turn, so without
    // a guard the trailing entries it keeps describe the *second* turn.
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => value.includes("load:"),
    );
    const followUp = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_SECOND_TURN_TOOLS" }),
    });
    expect(followUp.status).toBe(202);

    const session = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle"
        && value.messages.flatMap((message) => message.parts).some(
          (part) => part.toolTitle === "Read tsconfig.json (1 - 40)",
        ) === true,
    );
    const tools = session.messages.flatMap((message) => message.parts).filter(
      (part) => part.type === "tool-invocation",
    );
    // Each part keeps its own turn's path. A mis-scoped replay shows up as
    // `live-read-1` wearing the second turn's tsconfig title, which nothing
    // afterwards can undo: the part stops looking generic, so the next replay
    // skips it.
    expect(tools.find((part) => part.toolUseId === "live-read-1"))
      .toMatchObject({
        toolTitle: "Read package.json (1 - 80)",
        toolArgs: { path: "/workspace/package.json" },
      });
    expect(tools.find((part) => part.toolUseId === "live-read-2"))
      .toMatchObject({
        toolTitle: "Read tsconfig.json (1 - 40)",
        toolArgs: { path: "/workspace/tsconfig.json" },
      });
    expect(tools.find((part) => part.toolUseId === "live-search-1"))
      .toMatchObject({ toolArgs: { pattern: "scripts", path: "/workspace" } });
    expect(tools.find((part) => part.toolUseId === "live-search-2"))
      .toMatchObject({ toolArgs: { pattern: "strict", path: "/workspace/src" } });
  });

  test("leaves a structured turn dispatched during a Cursor replay intact", async () => {
    const bridge = await spawnBridge({
      env: {
        ACP_MAX_TRANSCRIPT_BYTES: String(1024 * 1024),
        FAKE_ACP_LOAD_DELAY_MS: "600",
        FAKE_ACP_REPLAY_CURSOR_OVERSIZED_METADATA: "1",
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-structured:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_OVERSIZED_REPLAY" }),
    });
    await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );

    // Enrichment re-bounds the transcript, and a trim there must never be read
    // as *this* turn overflowing: a structured turn that failed would cancel
    // the live child and hand the caller an error for someone else's growth.
    const structuredResponse = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({
        prompt: "DIRECT:{\"ok\":true}",
        requestId: "cursor-structured-1",
        outputSchema: { type: "object" },
      }),
    });
    expect(structuredResponse.status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{ status: string; error?: string }>,
      (value) => value.status === "idle" || value.status === "error",
    );
    expect(settled.status).toBe("idle");
    expect(settled.error).toBeUndefined();

    const structured = await waitFor(
      async () => nativeFetch(
        `${bridge.base}/session/${created.id}/structured-output?requestId=cursor-structured-1`,
        { headers: bridge.headers },
      ).then((response) => response.json()) as Promise<{ structuredOutput: unknown }>,
      (value) => value.structuredOutput !== null,
    );
    expect(structured.structuredOutput).toMatchObject({ ok: true, value: { ok: true } });
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

  test("normalizes failing tool calls into failed parts with an error message", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-fail" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FAILTOOL: break things" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const parts = session.messages[1]?.parts;
    expect(parts?.map((part) => part.type)).toEqual([
      "tool-invocation",
      "tool-invocation",
      "text",
    ]);
    const failWithPayload = parts?.find((part) => part.toolUseId === "fail-1");
    expect(failWithPayload).toMatchObject({
      toolState: "failure",
      toolOutput: JSON.stringify({ error: "boom" }, null, 2),
      toolError: JSON.stringify({ error: "boom" }, null, 2),
    });
    const failWithoutPayload = parts?.find((part) => part.toolUseId === "fail-2");
    expect(failWithoutPayload).toMatchObject({
      toolState: "failure",
      toolError: "Tool call failed",
    });
    expect(failWithoutPayload?.toolOutput).toBeUndefined();
  });

  test("preserves content output when a later patch updates only raw output", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-stream" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "STREAMTOOL: find references" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const stream = session.messages[1]?.parts.find((part) => part.toolUseId === "stream-1");
    expect(stream).toMatchObject({
      toolState: "success",
      toolOutput: "Searching for references...",
    });
    expect(stream?.toolDiff).toBeUndefined();
  });

  test("applies nullable and replacement tool update fields without stale metadata", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-patch" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "PATCHTOOLS: clear stale fields" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    // Every nullable field is gone: no stale title, name, args, output or diff
    // survives. The state is the one exception — clearing it to `null` left the
    // tool with no terminal status, so ending the turn settled it as unfinished
    // rather than leaving it indeterminate forever.
    const cleared = session.messages[1]?.parts.find((part) => part.toolUseId === "clear-1");
    expect(cleared).toEqual({
      type: "tool-invocation",
      content: "Tool call",
      sourcePartId: "tool:clear-1",
      sourceMessageId: expect.any(String),
      toolUseId: "clear-1",
      toolState: "failure",
      toolError: "Tool call ended without a result",
    });
  });

  test("combines every ACP file diff and counts only actual changed lines", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-multi" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "MULTIDIFF: edit two files" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "multi-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    expect(diff).toMatchObject({ additions: 2, deletions: 2 });
    expect(diff?.filePath).toBeUndefined();
    expect(diff?.before).toBeUndefined();
    expect(diff?.after).toBeUndefined();
    expect(diff?.diff).toEqual(expect.any(String));
    const rendered = diff?.diff as string;
    expect(rendered).toContain("--- src/first.ts");
    expect(rendered).toContain("+++ src/second.ts");
    expect(rendered).toContain(" const shared = true;");
    expect(rendered).toContain("-const value = 1;");
    expect(rendered).toContain("+const value = 2;");
    expect(rendered).toContain("-before");
    expect(rendered).toContain("+after");
  });

  test("renders a small edit to a large file as hunks, not the whole file", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-context" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CONTEXTEDIT: touch one line" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "context-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    expect(diff).toMatchObject({ filePath: "src/large.ts", additions: 1, deletions: 1 });
    const rendered = diff?.diff as string;
    // The change, three lines of context either side, and the headers — not the
    // 5,000-line file. Rendering every line is what exhausted the transcript.
    expect(rendered.split("\n")).toHaveLength(11);
    expect(rendered).toContain("@@ -2498,7 +2498,7 @@");
    expect(rendered).toContain("-const line_2500 = 2500;");
    expect(rendered).toContain("+const line_2500 = 2500; // touched");
    expect(rendered).toContain(" const line_2497 = 2497;");
    expect(rendered).toContain(" const line_2503 = 2503;");
    expect(rendered).not.toContain("line_2496");
    expect(rendered).not.toContain("line_2504");
    // The whole-file states are not carried alongside the rendering either, so
    // one edit costs its hunk rather than three copies of the file.
    expect(diff?.before).toBeUndefined();
    expect(diff?.after).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(tool))).toBeLessThan(1024);
  });

  test("renders separated changes and file boundaries as correctly positioned hunks", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-multi-hunk" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "MULTIHUNK: touch the boundaries and middle" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "multi-hunk-1");
    const diff = (tool?.toolDiff as { diff?: string } | undefined)?.diff ?? "";
    expect(diff.match(/^@@/gm)).toEqual([
      "@@",
      "@@",
      "@@",
    ]);
    expect(diff).toContain("@@ -1,4 +1,4 @@");
    expect(diff).toContain("@@ -7,7 +7,7 @@");
    expect(diff).toContain("@@ -17,4 +17,4 @@");
    expect(diff).toContain("-line 1\n+line 1 changed");
    expect(diff).toContain("-line 10\n+line 10 changed");
    expect(diff).toContain("-line 20\n+line 20 changed");
    expect(diff).not.toContain(" line 5");
    expect(diff).not.toContain(" line 15");
  });

  test("renders an edit with no changed lines as an empty hunk", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-noop-edit" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "NOOPEDIT: rewrite a file unchanged" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "noop-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    // Nothing changed, so there is no hunk to place: the headers and a bare
    // `@@` say exactly that, where rendering every line said the opposite.
    expect(diff?.diff).toBe("--- src/noop.ts\n+++ src/noop.ts\n@@");
    expect(diff).toMatchObject({ filePath: "src/noop.ts", additions: 0, deletions: 0 });
    expect(diff?.before).toBeUndefined();
    expect(diff?.after).toBeUndefined();
  });

  test("normalizes terminal and text tool content in protocol order", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-terminal" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "TERMINALTOOL: run checks" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    expect(session.messages[1]?.parts[0]).toMatchObject({
      toolUseId: "terminal-1",
      toolState: "success",
      toolOutput: "[Terminal terminal-42]\nChecks passed",
    });
  });

  test("starts a tool call on a fresh assistant message when it leads the turn", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-lead" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "TOOLSFIRST: start with a tool" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ id: string; role: string; parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]?.role).toBe("user");
    expect(session.messages[1]?.role).toBe("assistant");
    expect(session.messages[1]?.parts.map((part) => part.type)).toEqual([
      "tool-invocation",
      "text",
    ]);
    expect(session.messages[1]?.parts[0]).toMatchObject({
      toolUseId: "lead-1",
      toolName: "plan",
      toolArgs: { goal: "ship it" },
      // The agent ended the turn without ever completing this tool, so it is
      // settled rather than left spinning.
      toolState: "failure",
    });
  });

  test("bounds tool arguments, outputs, and diffs to their display limits", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-big" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "BIGTOOL: edit a huge file" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const big = session.messages[1]?.parts.find((part) => part.toolUseId === "big-1");
    expect(big).toBeDefined();
    expect(big?.toolArgs).toEqual({
      _orkestrator: "Tool input omitted because it exceeded the 512 KiB display limit",
    });
    expect(big?.toolOutput).toEqual(expect.any(String));
    expect(Buffer.byteLength(big?.toolOutput as string)).toBe(512 * 1024);
    expect((big?.toolOutput as string).endsWith("\n… tool output truncated")).toBe(true);
    const toolDiff = big?.toolDiff as Record<string, unknown> | undefined;
    expect(toolDiff).toMatchObject({ filePath: "huge.ts", additions: 1, deletions: 1 });
    // Bounded, and the cut is announced rather than silently dropping the tail.
    expect(Buffer.byteLength(toolDiff?.diff as string)).toBeLessThanOrEqual(1024 * 1024);
    expect((toolDiff?.diff as string).endsWith("\n… file diff truncated")).toBe(true);
    expect(toolDiff?.diff).toEqual(expect.stringContaining("-old\n+new"));
    expect(toolDiff?.before).toBeUndefined();
    expect(toolDiff?.after).toBeUndefined();
  });

  test("trims the oldest parts, and announces it, when a turn exhausts the per-message limit", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-many" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "MANYTOOLS: flood the turn" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => (value.messages[1]?.parts.length ?? 0) >= 512,
    );

    // An interactive turn survives its own volume: failing here would strand
    // the whole conversation behind the tab's connection-failure screen.
    expect(session.status).toBe("running");
    expect(session.error).toBeUndefined();
    expect(session.messages[1]?.parts).toHaveLength(512);
    // The oldest tool calls went, and the cut says so rather than reading as a
    // turn that never made those calls.
    expect(session.messages[1]?.parts[0]).toMatchObject({
      type: "text",
      content: expect.stringContaining("Earlier steps in this response were dropped"),
    });
    expect(session.messages[1]?.parts.slice(1).every((part) => part.type === "tool-invocation"))
      .toBe(true);
    expect(session.messages[1]?.parts.at(-1)).toMatchObject({ toolUseId: "many-512" });
  });

  test("does not rebuild a trimmed tool call from its own late update", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-trimmed-tool" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "TRIMMEDTOOLUPDATE: complete an evicted call" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const parts = session.messages[1]?.parts ?? [];
    expect(session.error).toBeUndefined();
    expect(parts).toHaveLength(512);
    expect(parts[0]).toMatchObject({
      type: "text",
      content: expect.stringContaining("Earlier steps in this response were dropped"),
    });
    // `early-1` was trimmed, and its completion arrived afterwards. Rebuilding
    // it there would append an empty `Tool call` at the end of the turn, after
    // the notice that says those steps went, with none of its title or output.
    expect(parts.filter((part) => part.toolUseId === "early-1")).toEqual([]);
    expect(parts.at(-1)).toMatchObject({ toolUseId: "filler-519" });
    expect(parts.slice(1).every((part) => part.type === "tool-invocation")).toBe(true);
  });

  test("starts a new part when a chunk follows a message trimmed to its notice", async () => {
    const { base, headers } = await spawnBridge({
      // The floor is reached when two parts alone still exceed the budget, and
      // at 16 MiB the per-part caps do not add up to that. Lowering the budget
      // is the only way to exercise it; it can only ever move downwards.
      env: { ACP_MAX_TRANSCRIPT_BYTES: String(1024 * 1024) },
    });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-trim-to-text" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "TRIMTOTEXT: empty the message, then speak" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ role: string; content: string; parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    // The lowered budget evicts whole messages before it trims parts, so the
    // prompt itself is gone and the assistant message is all that is left.
    const assistant = session.messages.at(-1)!;
    expect(session.error).toBeUndefined();
    expect(assistant.role).toBe("assistant");
    // Both tool parts went, so the notice is the message's *only* part and
    // therefore also its last. The chunk that follows must start its own part:
    // streaming into the notice would rewrite the announcement as agent output
    // and lose it.
    expect(assistant.parts).toHaveLength(2);
    expect(assistant.parts[0]).toMatchObject({
      type: "text",
      content: expect.stringContaining("Earlier steps in this response were dropped"),
    });
    expect(assistant.parts[1]).toMatchObject({ type: "text", content: "Recovered summary." });
    expect(assistant.content).toBe("Recovered summary.");

    const window = await nativeFetch(`${base}/session/${created.id}/messages`, { headers })
      .then((response) => response.json()) as {
        messageWindow: { truncated: boolean; omittedMessages?: number; omittedParts?: number };
      };
    expect(window.messageWindow.truncated).toBe(true);
    expect(window.messageWindow.omittedMessages).toBeGreaterThan(0);
    expect(window.messageWindow.omittedParts).toBeGreaterThan(0);
  });

  test("bounds an aggregate interactive transcript and preserves its trim across restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-transcript-overflow" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "TRANSCRIPTOVERFLOW: fill the display budget" }),
    });
    const read = async (base: string, headers: Record<string, string>) =>
      await nativeFetch(`${base}/session/${created.id}/messages`, { headers })
        .then((response) => response.json()) as {
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
          revision: number;
          messageWindow: { truncated: boolean; omittedMessages?: number; omittedParts?: number };
        };
    const bounded = await waitFor(
      () => read(first.base, first.headers),
      (value) => value.status === "idle",
    );

    const assistant = bounded.messages.at(-1)!;
    expect(bounded.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(bounded.messages))).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(assistant.parts.length).toBeLessThan(34);
    expect(assistant.parts[0]).toMatchObject({
      type: "text",
      content: expect.stringContaining("Earlier steps in this response were dropped"),
    });
    expect(bounded.messageWindow.truncated).toBe(true);
    expect(bounded.messageWindow.omittedParts).toBeGreaterThan(0);
    expect(assistant.parts.at(-1)).toMatchObject({ toolUseId: "large-33", toolState: "success" });
    const retainedToolIds = assistant.parts.flatMap((part) =>
      typeof part.toolUseId === "string" ? [part.toolUseId] : []
    );

    await stopChild(first.child);
    const second = await spawnBridge({ stateDirectory });
    const restored = await read(second.base, second.headers);
    const restoredAssistant = restored.messages.at(-1)!;
    expect(restored.status).toBe("idle");
    expect(restored.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(restored.messages))).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(restoredAssistant.parts[0]).toMatchObject({
      type: "text",
      content: expect.stringContaining("Earlier steps in this response were dropped"),
    });
    expect(restoredAssistant.parts.flatMap((part) =>
      typeof part.toolUseId === "string" ? [part.toolUseId] : []
    )).toEqual(retainedToolIds);
    expect(restored.messageWindow).toEqual(bounded.messageWindow);

    // A read re-bounds the transcript, but only when something was appended
    // since the last check: a steady-state poll of a large idle session must
    // not re-serialize it, and must not mutate what it returns.
    const readAgain = await read(second.base, second.headers);
    expect(readAgain.messages).toEqual(restored.messages);
    expect(readAgain.revision).toBe(restored.revision);

    const compressed = await nativeFetch(`${second.base}/session/${created.id}/messages`, {
      headers: { ...second.headers, "accept-encoding": "gzip" },
    });
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("vary")).toContain("Accept-Encoding");
    expect(Number(compressed.headers.get("content-length")))
      .toBeLessThan(Buffer.byteLength(JSON.stringify(restored.messages)));
    expect((await compressed.json() as { messages: unknown[] }).messages.length)
      .toBe(restored.messages.length);

    const refused = await nativeFetch(`${second.base}/session/${created.id}/messages`, {
      headers: { ...second.headers, "accept-encoding": "gzip;q=0, *;q=1" },
    });
    expect(refused.headers.get("content-encoding")).toBeNull();
    expect((await refused.json() as { messages: unknown[] }).messages.length)
      .toBe(restored.messages.length);
  });

  test("bounds all persisted sessions while retaining structured output across restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const maximumStateBytes = 2 * 1024 * 1024;
    const env = { ACP_MAX_STATE_FILE_BYTES: String(maximumStateBytes) };
    const first = await spawnBridge({ stateDirectory, env });

    const largeTranscript = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-persist:large-transcript" }),
    }).then((response) => response.json()) as { id: string };
    await nativeFetch(`${first.base}/session/${largeTranscript.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "BIGTOOL: pressure the shared state file" }),
    });
    await waitFor(
      async () => nativeFetch(`${first.base}/session/${largeTranscript.id}/status`, {
        headers: first.headers,
      }).then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );

    const structuredSession = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-persist:structured" }),
    }).then((response) => response.json()) as { id: string };
    const data = "s".repeat(400 * 1024);
    await nativeFetch(`${first.base}/session/${structuredSession.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({
        prompt: `DIRECT:${JSON.stringify({ data })}`,
        requestId: "persisted-structured-output",
        outputSchema: {
          type: "object",
          properties: { data: { type: "string" } },
          required: ["data"],
        },
      }),
    });
    await waitFor(
      async () => nativeFetch(`${first.base}/session/${structuredSession.id}/status`, {
        headers: first.headers,
      }).then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );

    await stopChild(first.child);
    const stateFile = resolve(stateDirectory, "state.json");
    expect((await fs.stat(stateFile)).size).toBeLessThanOrEqual(maximumStateBytes);

    const second = await spawnBridge({ stateDirectory, env });
    for (const sessionId of [largeTranscript.id, structuredSession.id]) {
      const response = await nativeFetch(`${second.base}/session/${sessionId}/messages`, {
        headers: second.headers,
      });
      expect(response.status).toBe(200);
      const restored = await response.json() as {
        messages: unknown[];
        messageWindow: { truncated: boolean };
      };
      expect(restored.messages.length).toBeGreaterThan(0);
      expect(restored.messageWindow.truncated).toBe(true);
    }

    const structured = await nativeFetch(
      `${second.base}/session/${structuredSession.id}/structured-output?requestId=persisted-structured-output`,
      { headers: second.headers },
    ).then((response) => response.json()) as {
      structuredOutput: { ok: boolean; value?: { data?: string } } | null;
    };
    expect(structured.structuredOutput?.ok).toBe(true);
    expect(structured.structuredOutput?.value?.data?.length).toBe(data.length);
  });

  test("fails a structured turn when its parts exhaust the per-message limit", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-many-structured" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "MANYTOOLS: flood the turn",
        requestId: "many-structured-1",
        outputSchema: { type: "object" },
      }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "error",
    );

    // A structured turn is worth exactly its complete output, so trimming it
    // has to fail rather than hand back a partial answer as a whole one.
    expect(session.error).toContain("exceeded the transcript limit");
    expect(session.messages[1]?.parts).toHaveLength(512);
    expect(session.messages[1]?.parts.every((part) => part.type === "tool-invocation")).toBe(true);
  });

  test("reconciles stale pending tool parts after a restart", async () => {
    const stateDirectory = await temporaryDirectory();
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({
        version: 3,
        provider: "cursor",
        sessions: [
          {
            id: "session-idle-pending",
            clientSessionKey: "env-1:tab-pending",
            acpSessionId: "acp-session-pending",
            status: "idle",
            revision: 3,
            structured: [],
            promptJournal: [],
            messages: [{
              id: "message-1",
              role: "assistant",
              content: "",
              parts: [
                {
                  type: "tool-invocation",
                  content: "Run tests",
                  sourcePartId: "tool:run-1",
                  sourceMessageId: "message-1",
                  toolUseId: "run-1",
                  toolName: "run",
                  toolState: "pending",
                },
                {
                  type: "tool-invocation",
                  content: "Edit file",
                  sourcePartId: "tool:edit-1",
                  sourceMessageId: "message-1",
                  toolUseId: "edit-1",
                  toolName: "edit",
                  toolState: "pending",
                  toolError: "already noted",
                },
                {
                  type: "tool-invocation",
                  content: "Search",
                  sourcePartId: "tool:search-1",
                  sourceMessageId: "message-1",
                  toolUseId: "search-1",
                  toolName: "search",
                  toolState: "success",
                },
              ],
              createdAt: "2026-08-01T00:00:00.000Z",
            }],
          },
          {
            id: "session-error-pending",
            clientSessionKey: "env-1:tab-error",
            acpSessionId: "acp-session-error",
            status: "error",
            revision: 1,
            structured: [],
            promptJournal: [],
            messages: [{
              id: "message-2",
              role: "assistant",
              content: "",
              parts: [{
                type: "tool-invocation",
                content: "Write file",
                sourcePartId: "tool:write-1",
                sourceMessageId: "message-2",
                toolUseId: "write-1",
                toolName: "write",
                toolState: "pending",
              }],
              createdAt: "2026-08-01T00:00:01.000Z",
            }],
          },
        ],
      }),
    );

    const bridge = await spawnBridge({ stateDirectory });
    const idle = await nativeFetch(`${bridge.base}/session/session-idle-pending`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as {
      status: string;
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(idle.messages[0]?.parts).toEqual([
      {
        type: "tool-invocation",
        content: "Run tests",
        sourcePartId: "tool:run-1",
        sourceMessageId: "message-1",
        toolUseId: "run-1",
        toolName: "run",
        toolState: "failure",
        toolError: "Tool call ended without a result",
      },
      {
        type: "tool-invocation",
        content: "Edit file",
        sourcePartId: "tool:edit-1",
        sourceMessageId: "message-1",
        toolUseId: "edit-1",
        toolName: "edit",
        toolState: "failure",
        toolError: "already noted",
      },
      {
        type: "tool-invocation",
        content: "Search",
        sourcePartId: "tool:search-1",
        sourceMessageId: "message-1",
        toolUseId: "search-1",
        toolName: "search",
        toolState: "success",
      },
    ]);

    const errored = await nativeFetch(`${bridge.base}/session/session-error-pending`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as {
      status: string;
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(errored.messages[0]?.parts[0]).toMatchObject({
      toolUseId: "write-1",
      toolState: "failure",
      toolError: "Tool call ended without a result",
    });
  });

  test("heals a session an older build failed for exceeding the transcript limit", async () => {
    const stateDirectory = await temporaryDirectory();
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({
        version: 3,
        provider: "cursor",
        sessions: [
          {
            id: "session-trim-failed",
            clientSessionKey: "env-1:tab-trimmed",
            acpSessionId: "acp-session-trimmed",
            status: "error",
            error: "cursor output exceeded the transcript limit",
            revision: 9,
            structured: [],
            promptJournal: [],
            messages: [{
              id: "message-1",
              role: "assistant",
              content: "Done.",
              parts: [{
                type: "text",
                content: "Done.",
                sourcePartId: "message-1:0",
                sourceMessageId: "message-1",
              }],
              createdAt: "2026-08-01T00:00:00.000Z",
            }],
          },
          {
            id: "session-really-failed",
            clientSessionKey: "env-1:tab-broken",
            acpSessionId: "acp-session-broken",
            status: "error",
            error: "cursor exited before the turn completed",
            revision: 2,
            structured: [],
            promptJournal: [],
            messages: [],
          },
        ],
      }),
    );

    const bridge = await spawnBridge({ stateDirectory });
    const read = async (id: string) =>
      await nativeFetch(`${bridge.base}/session/${id}`, { headers: bridge.headers })
        .then((response) => response.json()) as { status: string; error?: string };

    // The persisted failure is a display-budget artifact of an older build, and
    // nothing in the tab can clear it: the only control there reads it back.
    const healed = await read("session-trim-failed");
    expect(healed.status).toBe("idle");
    expect(healed.error).toBeUndefined();

    // Every other failure is the agent's, and still has to survive the restart.
    const broken = await read("session-really-failed");
    expect(broken.status).toBe("error");
    expect(broken.error).toBe("cursor exited before the turn completed");
  });

  test("drops malformed persisted tool parts on load", async () => {
    const stateDirectory = await temporaryDirectory();
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({
        version: 3,
        provider: "cursor",
        sessions: [{
          id: "session-malformed",
          clientSessionKey: "env-1:tab-malformed",
          acpSessionId: "acp-session-malformed",
          status: "idle",
          revision: 2,
          structured: [],
          promptJournal: [],
          messages: [{
            id: "message-1",
            role: "assistant",
            content: "",
            parts: [
              { type: "tool-invocation", content: "No id", sourcePartId: "x", sourceMessageId: "message-1", toolState: "success" },
              { type: "tool-invocation", content: "Numeric id", sourcePartId: "y", sourceMessageId: "message-1", toolUseId: 42, toolState: "success" },
              { type: "tool-invocation", content: "Valid", sourcePartId: "z", sourceMessageId: "message-1", toolUseId: "ok-1", toolState: "success" },
              { type: "bogus", content: "Unknown type" },
            ],
            createdAt: "2026-08-01T00:00:00.000Z",
          }],
        }],
      }),
    );

    const bridge = await spawnBridge({ stateDirectory });
    const session = await nativeFetch(`${bridge.base}/session/session-malformed`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(session.messages[0]?.parts).toEqual([{
      type: "tool-invocation",
      content: "Valid",
      sourcePartId: "z",
      sourceMessageId: "message-1",
      toolUseId: "ok-1",
      toolState: "success",
    }]);
  });

  test("settles a tool left in flight when a live turn ends, without a restart", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-hang" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "HANGTOOL: abandon a tool" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    // The in-flight tool settles even though this bridge process never reloaded
    // persisted state — the turn ending is what resolves it.
    const abandoned = session.messages[1]?.parts.find((part) => part.toolUseId === "hang-1");
    expect(abandoned).toMatchObject({
      toolState: "failure",
      toolError: "Tool call ended without a result",
    });
    // A tool that already reported a terminal state is left exactly as it was.
    const finished = session.messages[1]?.parts.find((part) => part.toolUseId === "hang-done");
    expect(finished).toMatchObject({ toolState: "success" });
    expect(finished?.toolError).toBeUndefined();
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

  test("keeps a known tool state when an update carries an unrecognized status", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-odd" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "ODDSTATUS: send a future status" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    // The unknown status left `pending` intact rather than erasing the state, so
    // the end-of-turn settle could still recognise the tool as unfinished.
    expect(session.messages[1]?.parts.find((part) => part.toolUseId === "odd-1")).toMatchObject({
      toolState: "failure",
      toolError: "Tool call ended without a result",
    });
  });

  test("renders a placeholder when both file states exceed the inline limit", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-huge" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "HUGEEDIT: rewrite an oversized file" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "hugeedit-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    expect(diff?.diff).toBe(
      "--- oversized.ts\n+++ oversized.ts\n@@ diff omitted: file state exceeded display limit @@",
    );
    expect(diff).toMatchObject({ filePath: "oversized.ts" });
    // Neither the file contents nor counts we cannot derive are retained.
    expect(diff?.before).toBeUndefined();
    expect(diff?.after).toBeUndefined();
    expect(diff?.additions).toBeUndefined();
    expect(diff?.deletions).toBeUndefined();
  });

  test("omits aggregate counts when any file diff has no countable stats", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-mixed" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "MIXEDSTATS: one countable, one not" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "mixed-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    // A partial sum would understate the change, so no counts are reported at
    // all — but both files' renderings still appear.
    expect(diff?.additions).toBeUndefined();
    expect(diff?.deletions).toBeUndefined();
    expect(diff?.diff).toContain("-before");
    expect(diff?.diff).toContain("+after");
    expect(diff?.diff).toContain("@@ diff omitted: file state exceeded display limit @@");
  });

  test("falls back to a bounded block diff when an edit exceeds the search distance", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-wide" }),
    }).then((response) => response.json()) as { id: string };

    const startedAt = Date.now();
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "WIDEEDIT: rewrite every line" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    // The unbounded search spent ~150ms of blocked read loop and ~340MB of heap
    // on an input this shape before discarding the result.
    expect(Date.now() - startedAt).toBeLessThan(3_000);

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "wide-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    expect(diff).toMatchObject({ filePath: "src/wide.ts", additions: 4000, deletions: 4000 });
    const rendered = diff?.diff as string;
    // Shared prefix and suffix survive as context; everything between them is
    // one removed block followed by one added block.
    expect(rendered).toContain(" const keep = true;");
    expect(rendered).toContain(" export {};");
    expect(rendered.indexOf("-const before_0 = 0;")).toBeLessThan(rendered.indexOf("+const after_0 = 0;"));
    expect(rendered).toContain("-const before_3999 = 3999;");
    expect(rendered).toContain("+const after_3999 = 7998;");
  });

  test("ignores an empty supplied diff and renders the file states instead", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-empty" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "EMPTYDIFF: unfilled diff field" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "empty-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    expect(diff).toMatchObject({ filePath: "src/empty.ts", additions: 1, deletions: 1 });
    expect(diff?.diff).toContain("-const value = 1;");
    expect(diff?.diff).toContain("+const value = 2;");
  });

  test("resumes a flattened resource-exhausted turn with exponential backoff", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-prompts.log");
    const promptBlocksFile = resolve(directory, "resource-retry-blocks.log");
    const { base, headers } = await spawnBridge({ env: {
      ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
      FAKE_ACP_COUNTER_FILE: counterFile,
      FAKE_ACP_PROMPT_BLOCKS_FILE: promptBlocksFile,
      FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "2",
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: finish without repeating completed work",
        requestId: "resource-retry-1",
      }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{
            role: string;
            content: string;
            parts: Array<Record<string, unknown>>;
          }>;
        }>,
      (value) => value.status === "idle",
    );

    expect(session.error).toBeUndefined();
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.messages.at(-1)?.content).toContain("Recovered and finished the original request.");
    expect(session.messages.at(-1)?.content).not.toContain("resource_exhausted");
    expect(session.messages.at(-1)?.parts.find((part) => part.toolUseId === "resource-safe-1"))
      .toMatchObject({ toolState: "success" });
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(3);

    const promptBlocks = (await fs.readFile(promptBlocksFile, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Array<{ type?: string; text?: string }>);
    expect(promptBlocks[0]?.[0]?.text).toBe(
      "RESOURCEEXHAUSTED: finish without repeating completed work",
    );
    expect(promptBlocks.slice(1).every((blocks) =>
      blocks[0]?.text?.startsWith("Continue from where the interrupted turn stopped.")))
      .toBe(true);
  });

  test("retries a structured ACP resource-exhausted response", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-rpc-retry-prompts.log");
    const { base, headers } = await spawnBridge({ env: {
      ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
      FAKE_ACP_COUNTER_FILE: counterFile,
      FAKE_ACP_RPC_RESOURCE_EXHAUSTED_ATTEMPTS: "2",
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTEDRPC: retry the typed failure",
        requestId: "resource-rpc-retry-1",
      }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "idle",
    );

    expect(session.error).toBeUndefined();
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.messages.at(-1)?.content).toBe("Recovered from the structured RPC error.");
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(3);
  });

  test("fails visibly after three resource-exhausted retries", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-exhausted.log");
    const { base, headers } = await spawnBridge({ env: {
      ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
      FAKE_ACP_COUNTER_FILE: counterFile,
      FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "4",
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "RESOURCEEXHAUSTED: keep failing", requestId: "resource-retry-2" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "error",
    );

    expect(session.error).toBe("cursor remained resource exhausted after 3 retries");
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.messages.at(-1)?.content).toContain(
      "Error: RetriableError: [resource_exhausted] Error",
    );
    // Initial dispatch plus exactly three retries.
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(4);
  });

  test("cancels a resource-exhausted turn while it is in backoff", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-cancelled.log");
    const { base, headers } = await spawnBridge({ env: {
      ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "500",
      FAKE_ACP_COUNTER_FILE: counterFile,
      FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "4",
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "RESOURCEEXHAUSTED: cancel me", requestId: "resource-retry-3" }),
    });
    await waitFor(
      () => fs.readFile(counterFile, "utf8").catch(() => ""),
      (contents) => contents.trim().split("\n").filter(Boolean).length === 1,
    );
    const cancelled = await nativeFetch(`${base}/session/${created.id}/cancel`, {
      method: "POST",
      headers,
    });
    expect(cancelled.status).toBe(202);
    await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );
    await Bun.sleep(100);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("retries a flattened error whose class name is not RetriableError", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-other-class.log");
    const { base, headers } = await spawnBridge({ env: {
      ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
      FAKE_ACP_COUNTER_FILE: counterFile,
      FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "1",
      // The class name is whatever the provider's error carried. Matching only
      // `RetriableError` would leave every other name dead in the transcript.
      FAKE_ACP_FLATTENED_ERROR_NAME: "GoogleGenerativeAIFetchError",
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: unfamiliar error class",
        requestId: "resource-retry-class-1",
      }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "idle" || value.status === "error",
    );

    expect(session.status).toBe("idle");
    expect(session.error).toBeUndefined();
    expect(session.messages.at(-1)?.content).toContain("Recovered and finished the original request.");
    expect(session.messages.at(-1)?.content).not.toContain("resource_exhausted");
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  test("recovers a structured turn without replaying the interrupted attempt's output", async () => {
    const directory = await temporaryDirectory();
    const promptBlocksFile = resolve(directory, "structured-rpc-retry-blocks.log");
    const { base, headers } = await spawnBridge({ env: {
      ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
      FAKE_ACP_PROMPT_BLOCKS_FILE: promptBlocksFile,
      FAKE_ACP_RPC_RESOURCE_EXHAUSTED_ATTEMPTS: "1",
      // The interrupted attempt streams a JSON prefix. Carrying it into the
      // continuation would concatenate into a value that cannot parse.
      FAKE_ACP_RESOURCE_EXHAUSTED_PARTIAL: "{\"answer\":\"par",
      FAKE_ACP_RESOURCE_EXHAUSTED_FINAL: "{\"answer\":\"recovered\"}",
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTEDRPC: produce the structured value",
        requestId: "structured-retry-1",
        outputSchema: { type: "object", properties: { answer: { type: "string" } } },
      }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{ status: string; error?: string }>,
      (value) => value.status === "idle" || value.status === "error",
    );
    expect(session.status).toBe("idle");
    expect(session.error).toBeUndefined();

    const structured = await waitFor(
      async () => nativeFetch(
        `${base}/session/${created.id}/structured-output?requestId=structured-retry-1`,
        { headers },
      ).then((response) => response.json()) as Promise<{ structuredOutput: unknown }>,
      (value) => value.structuredOutput !== null,
    );
    expect(structured.structuredOutput).toMatchObject({
      ok: true,
      value: { answer: "recovered" },
    });

    // The continuation replaces the original prompt on the wire, so it has to
    // restate the contract the structured turn must still satisfy.
    const promptBlocks = (await fs.readFile(promptBlocksFile, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Array<{ type?: string; text?: string }>);
    expect(promptBlocks).toHaveLength(2);
    expect(promptBlocks[1]?.[0]?.text).toContain(
      "Return only one JSON value matching this JSON Schema.",
    );
    expect(promptBlocks[1]?.[0]?.text).toContain("\"answer\"");
  });

  test("recovers a structured turn interrupted by a flattened resource-exhausted error", async () => {
    const directory = await temporaryDirectory();
    const { base, headers } = await spawnBridge({ env: {
      ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
      FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "1",
      FAKE_ACP_RESOURCE_EXHAUSTED_PARTIAL: "{\"answer\":\"par",
      FAKE_ACP_RESOURCE_EXHAUSTED_FINAL: "{\"answer\":\"flattened-recovered\"}",
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: produce the structured value",
        requestId: "structured-retry-2",
        outputSchema: { type: "object", properties: { answer: { type: "string" } } },
      }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{ status: string; error?: string }>,
      (value) => value.status === "idle" || value.status === "error",
    );
    expect(session.status).toBe("idle");
    expect(session.error).toBeUndefined();

    const structured = await waitFor(
      async () => nativeFetch(
        `${base}/session/${created.id}/structured-output?requestId=structured-retry-2`,
        { headers },
      ).then((response) => response.json()) as Promise<{ structuredOutput: unknown }>,
      (value) => value.structuredOutput !== null,
    );
    expect(structured.structuredOutput).toMatchObject({
      ok: true,
      value: { answer: "flattened-recovered" },
    });
  });

  test("rejects a concurrent prompt while a resource-exhausted turn is in backoff", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-busy.log");
    const { base, headers } = await spawnBridge({ env: {
      ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "800",
      FAKE_ACP_COUNTER_FILE: counterFile,
      FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "1",
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "RESOURCEEXHAUSTED: stay busy", requestId: "resource-busy-1" }),
    });
    await waitFor(
      () => fs.readFile(counterFile, "utf8").catch(() => ""),
      (contents) => contents.trim().split("\n").filter(Boolean).length === 1,
    );

    // A turn parked in backoff still owns the session: it has not finished, and
    // a second dispatch would race the continuation onto the same thread.
    const busy = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "second turn", requestId: "resource-busy-2" }),
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "Session is already running" });

    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "idle" || value.status === "error",
    );
    expect(session.status).toBe("idle");
    expect(session.messages.at(-1)?.content).toContain("Recovered and finished the original request.");
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(2);
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

  test("suppresses resource-exhausted retries for a turn cancelled while it was dispatching", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-cancel-dispatch.log");
    const { base, headers } = await spawnBridge({ env: {
      ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
      FAKE_ACP_COUNTER_FILE: counterFile,
      FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "4",
      // Holds `session/load` open, so the respawn below keeps the prompt claim
      // in its dispatching window long enough to cancel inside it.
      FAKE_ACP_LOAD_DELAY_MS: "800",
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    // Kill the child so the next prompt has to respawn, which is what makes the
    // dispatching window wide instead of a single microtask.
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CRASH now", requestId: "resource-dispatch-crash" }),
    });
    await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "error",
    );

    // Deliberately not awaited: the response only arrives once the turn has been
    // dispatched, and the cancel has to land before that.
    const dispatched = nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: cancel during dispatch",
        requestId: "resource-dispatch-1",
      }),
    });
    await Bun.sleep(200);
    const cancelled = await nativeFetch(`${base}/session/${created.id}/cancel`, {
      method: "POST",
      headers,
    });
    expect(cancelled.status).toBe(202);
    expect((await dispatched).status).toBe(202);

    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "idle" || value.status === "error",
    );
    expect(session.status).toBe("idle");
    await Bun.sleep(100);
    // One dispatch, no retries: the cancel that arrived before the turn took its
    // sequence still applies to it.
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("deduplicates session creation and prompt dispatch by durable keys", async () => {
    const stateDirectory = await temporaryDirectory();
    const counterFile = resolve(stateDirectory, "prompts.log");
    const first = await spawnBridge({ stateDirectory, env: { FAKE_ACP_COUNTER_FILE: counterFile } });
    const create = () => nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    }).then((response) => response.json()) as Promise<{ id: string }>;
    const [created, duplicateCreation] = await Promise.all([create(), create()]);
    expect(duplicateCreation.id).toBe(created.id);

    const send = () => nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "DIRECT:once", requestId: "request-1" }),
    });
    expect((await send()).status).toBe(202);
    await waitFor(
      async () => nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );
    expect((await send()).status).toBe(202);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(["prompt"]);

    await stopChild(first.child);
    const second = await spawnBridge({ stateDirectory, env: { FAKE_ACP_COUNTER_FILE: counterFile } });
    const restored = await nativeFetch(`${second.base}/session/create`, {
      method: "POST",
      headers: second.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    }).then((response) => response.json()) as { id: string };
    expect(restored.id).toBe(created.id);
    const duplicateAfterRestart = await nativeFetch(`${second.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: second.headers,
      body: JSON.stringify({ prompt: "DIRECT:once", requestId: "request-1" }),
    });
    expect(duplicateAfterRestart.status).toBe(202);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(["prompt"]);
  });

  test("rolls back a keyed session when initial configuration fails", async () => {
    const directory = await temporaryDirectory();
    const failureFile = resolve(directory, "config-failed.log");
    const lifecycleFile = resolve(directory, "config-lifecycle.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_FAIL_CONFIG_ONCE_FILE: failureFile,
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      ACP_MAX_SESSIONS: "1",
    } });
    const create = () => nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({
        clientSessionKey: "env-1:configured-tab",
        reasoningId: "high",
      }),
    });

    const failed = await create();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: "fake configuration failure" });

    const retried = await create();
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({
      composer: { selectedReasoningId: "high" },
    });
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (contents) => (contents.match(/^start:/gm)?.length ?? 0) === 2,
    );
  });

  test("rejects unsupported vendor requests instead of acknowledging them", async () => {
    const directory = await temporaryDirectory();
    const responseFile = resolve(directory, "vendor-response.log");
    const bridge = await spawnBridge({ env: { FAKE_ACP_VENDOR_REQUEST_FILE: responseFile } });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    });
    expect(created.status).toBe(201);
    const response = await waitFor(
      () => fs.readFile(responseFile, "utf8").then((value) => JSON.parse(value.trim())).catch(() => null) as Promise<Record<string, unknown> | null>,
      Boolean,
    );
    expect(response).toMatchObject({
      id: 901,
      error: { code: -32601, message: "Unsupported ACP client method: x.ai/ask_user_question" },
    });
    expect(response).not.toHaveProperty("result");
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

  test("rejects a second composer patch that races one already applying", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "config-race-lifecycle.log");
    const { base, headers } = await spawnBridge({ env: {
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    // `applyComposerPatch` yields on every RPC. Without a claim taken before
    // the first await, both patches plan against the same stale sessionConfig
    // and the loser silently overwrites the winner's result.
    const patch = (modelId: string) => nativeFetch(`${base}/session/${created.id}/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ modelId }),
    });
    const [first, second] = await Promise.all([patch("gpt-5.5"), patch("composer-2.5")]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = first.status === 200 ? "gpt-5.5" : "composer-2.5";
    const config = await nativeFetch(`${base}/session/${created.id}/config`, { headers })
      .then((response) => response.json()) as { selectedModelId?: string };
    expect(config.selectedModelId).toBe(winner);
  });

  test("rejects a prompt that races an in-flight composer patch", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    const [config, prompt] = await Promise.all([
      nativeFetch(`${base}/session/${created.id}/config`, {
        method: "POST",
        headers,
        body: JSON.stringify({ modelId: "gpt-5.5" }),
      }),
      nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "hello", requestId: "race-1" }),
      }),
    ]);
    // Whichever request the server reads first claims the session; the point is
    // that they can never both proceed, because a composer patch and a turn
    // would otherwise interleave their RPCs on one agent.
    expect([config.status, prompt.status].filter((status) => status === 409)).toHaveLength(1);
    if (prompt.status === 409) {
      // The refused turn was never journaled, so the same requestId can retry.
      const retried = await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "hello", requestId: "race-1" }),
      });
      expect(retried.status).toBe(202);
    }
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

  test("reaps a session process when the creating HTTP client disconnects", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "lifecycle.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_HANG_INITIALIZE: "1",
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      ACP_RPC_TIMEOUT_MS: "100",
    } });
    const controller = new AbortController();
    const request = nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: "{}",
      signal: controller.signal,
    }).catch(() => undefined);
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (contents) => contents.includes("start:"),
    );
    controller.abort();
    await request;
    const lifecycle = await fs.readFile(lifecycleFile, "utf8");
    const agentPid = Number(/^start:(\d+)$/m.exec(lifecycle)?.[1]);
    expect(Number.isSafeInteger(agentPid)).toBe(true);
    await waitFor(async () => {
      try {
        process.kill(agentPid, 0);
        return false;
      } catch {
        return true;
      }
    }, Boolean);
    expect(lifecycle.match(/^start:/gm)).toHaveLength(1);
    expect((await nativeFetch(`${bridge.base}/global/health`)).ok).toBe(true);
  });

  test("bounds one oversized response without failing the session", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "OVERSIZED", requestId: "oversized-1" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string; error?: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "idle",
    );
    expect(session.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(session.messages))).toBeLessThan(8 * 1024 * 1024);
    // Bounded, and the cut is announced in the transcript the user reads.
    expect(session.messages[1]?.content.endsWith("[output truncated by Orkestrator]")).toBe(true);
  });

  test("announces overflow when earlier stream chunks leave no room for the marker", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "STREAMOVERFLOW: cross the cap in two chunks" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ content: string; parts: Array<{ type: string; content: string }> }>;
        }>,
      (value) => value.status === "idle",
    );

    const assistant = session.messages[1]!;
    const textPart = assistant.parts.find((part) => part.type === "text")!;
    expect(session.error).toBeUndefined();
    expect(Buffer.byteLength(assistant.content)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Buffer.byteLength(textPart.content)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(assistant.content.endsWith("[output truncated by Orkestrator]")).toBe(true);
    expect(textPart.content.endsWith("[output truncated by Orkestrator]")).toBe(true);
    expect(assistant.content).not.toContain("�");
    expect(textPart.content).not.toContain("�");
  });

  test("discards a chunk small enough to fit in what truncation left over", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "SATURATEDSTREAM: one chunk past the cap" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ content: string; parts: Array<{ type: string; content: string }> }>;
        }>,
      (value) => value.status === "idle",
    );

    const assistant = session.messages[1]!;
    const textPart = assistant.parts.find((part) => part.type === "text")!;
    const marker = "[output truncated by Orkestrator]";
    expect(session.error).toBeUndefined();
    expect(Buffer.byteLength(assistant.content)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Buffer.byteLength(textPart.content)).toBeLessThanOrEqual(2 * 1024 * 1024);
    // The cut is announced exactly once and the announcement stays terminal.
    // Truncation leaves the buffer a byte under the cap, and a chunk small
    // enough to fit in it must still be discarded: appending it would render
    // as `…[output truncated by Orkestrator]!`, which reads as corruption
    // rather than as a response that was cut short.
    expect(assistant.content.split(marker)).toHaveLength(2);
    expect(textPart.content.split(marker)).toHaveLength(2);
    expect(assistant.content.endsWith(marker)).toBe(true);
    expect(textPart.content.endsWith(marker)).toBe(true);
    expect(assistant.content).not.toContain("!");
    expect(textPart.content).not.toContain("!");
    // The backed-off code point must not have decoded into a replacement char.
    expect(assistant.content).not.toContain("�");
  });

  test("fails an oversized structured turn rather than parsing a cut answer", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "OVERSIZED",
        requestId: "oversized-structured-1",
        outputSchema: { type: "object" },
      }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string; error?: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "error",
    );
    expect(session.error).toContain("transcript limit");
    expect(Buffer.byteLength(JSON.stringify(session.messages))).toBeLessThan(8 * 1024 * 1024);
  });

  test("uses only the current turn when parsing structured output", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    const prompt = async (text: string, requestId: string) => {
      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: `DIRECT:${text}`,
          requestId,
          outputSchema: { type: "object" },
        }),
      });
      await waitFor(
        async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string }>,
        (session) => session.status === "idle",
      );
    };
    await prompt('{"turn":1}', "turn-1");
    await prompt("not-json", "turn-2");
    const result = await nativeFetch(
      `${base}/session/${created.id}/structured-output?requestId=turn-2`,
      { headers },
    ).then((response) => response.json()) as { structuredOutput: { ok: boolean; error?: { code?: string } } };
    expect(result.structuredOutput).toMatchObject({ ok: false, error: { code: "malformed_output" } });
  });

  test("denies pending permission when cancelled", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "needs permission", requestId: "cancel-1" }),
    });
    await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) => response.json()) as Promise<{ approvals: unknown[] }>,
      (value) => value.approvals.length === 1,
    );
    await nativeFetch(`${base}/session/${created.id}/cancel`, { method: "POST", headers });
    const approvals = await nativeFetch(`${base}/session/${created.id}/approvals`, { headers })
      .then((response) => response.json()) as { approvals: unknown[] };
    expect(approvals.approvals).toEqual([]);
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

  test("keeps serving when writes go to an agent that stopped reading", async () => {
    // The agent answers, then closes its read end and stays alive, so every
    // later write lands on a pipe nobody drains while the bridge still has the
    // child attached. Writing there must never escape into the request handler
    // or take the bridge down with all of its other sessions.
    const { base, headers, child } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CLOSESTDIN", requestId: "closed-input-1" }),
    });
    await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const cancelled = await nativeFetch(`${base}/session/${created.id}/cancel`, { method: "POST", headers });
      expect(cancelled.status).toBe(202);
      await Bun.sleep(20);
    }

    expect(child.exitCode).toBe(null);
    expect((await nativeFetch(`${base}/global/health`)).ok).toBe(true);
    expect((await nativeFetch(`${base}/session/${created.id}`, { headers })).status).toBe(200);
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

  test("reattaches a detached session through session/load and reports a refusal", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "reattach-lifecycle.log");
    const bridge = await spawnBridge({ env: { FAKE_ACP_LIFECYCLE_FILE: lifecycleFile } });
    const created = await nativeFetch(`${bridge.base}/session/create`, { method: "POST", headers: bridge.headers })
      .then((response) => response.json()) as { id: string };

    // Kill the agent underneath the bridge; the session must survive as state.
    const firstPid = Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]);
    process.kill(firstPid, "SIGKILL");
    await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "error",
    );

    // The next prompt transparently spawns a replacement and resumes the thread.
    const resumed = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:back online", requestId: "reattach-1" }),
    });
    expect(resumed.status).toBe(202);
    const session = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers }).then((response) => response.json()) as Promise<{ status: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "idle",
    );
    expect(session.messages.map((message) => message.content)).toEqual([
      "DIRECT:back online",
      "back online",
    ]);
    const lifecycle = await fs.readFile(lifecycleFile, "utf8");
    expect(lifecycle.match(/^start:/gm)).toHaveLength(2);
    expect(lifecycle).toContain("load:");
  });

  test("refuses to reattach when the agent cannot reload sessions", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "no-load-lifecycle.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      FAKE_ACP_NO_LOAD_SESSION: "1",
    } });
    const created = await nativeFetch(`${bridge.base}/session/create`, { method: "POST", headers: bridge.headers })
      .then((response) => response.json()) as { id: string };
    process.kill(
      Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]),
      "SIGKILL",
    );
    await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}/status`, { headers: bridge.headers }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "error",
    );

    // Reattaching would silently start a *different* conversation, so the
    // bridge must refuse rather than resume against an agent with no rollout.
    const refused = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:hello", requestId: "no-load-1" }),
    });
    expect(refused.status).toBe(410);
    expect(await refused.json()).toMatchObject({
      error: "cursor cannot reload persisted ACP sessions",
    });
    expect((await fs.readFile(lifecycleFile, "utf8"))).not.toContain("load:");
    // The refusal released the claim, so the same requestId is not journaled
    // as an already-dispatched duplicate.
    const retried = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:hello", requestId: "no-load-1" }),
    });
    expect(retried.status).toBe(410);
  });

  test("rejects a failed reattach and lets the same requestId be retried", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "failed-load-lifecycle.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      FAKE_ACP_FAIL_LOAD_SESSION: "1",
    } });
    const created = await nativeFetch(`${bridge.base}/session/create`, { method: "POST", headers: bridge.headers })
      .then((response) => response.json()) as { id: string };
    process.kill(
      Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]),
      "SIGKILL",
    );
    await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}/status`, { headers: bridge.headers }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "error",
    );

    const send = () => nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:retry", requestId: "retry-me" }),
    });
    const first = await send();
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ error: "fake agent cannot load that session" });
    // The turn provably never ran, so the claim must be released rather than
    // leaving the requestId permanently journaled as a duplicate.
    const second = await send();
    expect(second.status).toBe(500);
    expect((await nativeFetch(`${bridge.base}/global/health`)).ok).toBe(true);
  });

  test("refuses to redispatch a prompt whose outcome a crash left unknown", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    const dispatch = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "Do the work", requestId: "request-1" }),
    });
    expect(dispatch.status).toBe(202);
    // The fake agent parks a permission, so the turn is still in flight and the
    // journal is still "accepted" when the bridge dies — it restores as
    // "ambiguous" on the next process.
    await waitFor(
      async () => nativeFetch(`${first.base}/session/${created.id}/approvals`, { headers: first.headers })
        .then((response) => response.json()) as Promise<{ approvals: unknown[] }>,
      (value) => value.approvals.length === 1,
    );

    first.child.kill("SIGKILL");
    await waitForExit(first.child);

    const second = await spawnBridge({ stateDirectory });
    const redelivery = await nativeFetch(`${second.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: second.headers,
      body: JSON.stringify({ prompt: "Do the work", requestId: "request-1" }),
    });
    expect(redelivery.status).toBe(410);
    expect(await redelivery.json()).toMatchObject({
      error: "cursor prompt outcome is unknown after a bridge restart; resubmit with a new requestId",
    });

    // The at-most-once work was never re-executed and a fresh requestId still
    // recovers the session through session/load.
    const recovered = await nativeFetch(`${second.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: second.headers,
      body: JSON.stringify({ prompt: "DIRECT:recovered", requestId: "request-2" }),
    });
    expect(recovered.status).toBe(202);
    const session = await waitFor(
      async () => nativeFetch(`${second.base}/session/${created.id}`, { headers: second.headers })
        .then((response) => response.json()) as Promise<{ status: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "idle",
    );
    expect(session.messages.map((message) => message.content)).toContain("recovered");
  });

  test("dispatches a prompt at most once when concurrent requests race a reattach", async () => {
    // Reattaching spawns a process and performs two round trips, so it is the
    // window where a second request can slip between the duplicate check and
    // the claim. The turn must still reach the agent exactly once, and only
    // one replacement child may be started.
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "concurrent-prompts.log");
    const lifecycleFile = resolve(directory, "concurrent-lifecycle.log");
    const { base, headers } = await spawnBridge({ env: {
      FAKE_ACP_COUNTER_FILE: counterFile,
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    process.kill(
      Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]),
      "SIGKILL",
    );
    await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}/status`, { headers }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "error",
    );

    const send = () => nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIRECT:only once", requestId: "concurrent-1" }),
    });
    const responses = await Promise.all([send(), send(), send(), send()]);
    expect(responses.map((response) => response.status).filter((status) => status === 202).length)
      .toBeGreaterThan(0);
    expect(responses.every((response) => response.status === 202 || response.status === 409))
      .toBe(true);
    await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(["prompt"]);
    // One original agent plus exactly one replacement.
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^start:/gm)).toHaveLength(2);
  });

  test("rejects a concurrent second turn that carries a different requestId", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "distinct-prompts.log");
    const { base, headers } = await spawnBridge({ env: { FAKE_ACP_COUNTER_FILE: counterFile } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    // The first prompt parks on a permission, so the turn is still running.
    const [first, second] = await Promise.all([
      nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "needs permission", requestId: "turn-a" }),
      }),
      nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "needs permission too", requestId: "turn-b" }),
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([202, 409]);
    await waitFor(
      () => fs.readFile(counterFile, "utf8").catch(() => ""),
      (contents) => contents.trim() === "prompt",
    );
  });

  test("keeps live approvals when a superseded agent process exits", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "needs permission", requestId: "approval-live-1" }),
    });
    const parked = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) => response.json()) as Promise<{ approvals: Array<{ id: string; expiresAt: number; requestedAt: number }> }>,
      (value) => value.approvals.length === 1,
    );
    const approval = parked.approvals[0]!;
    // Approvals carry a bounded lifetime; nothing may park indefinitely.
    expect(approval.expiresAt - approval.requestedAt).toBe(5 * 60_000);

    // The approval belongs to the attached child and must outlive unrelated
    // churn, staying answerable rather than being silently dropped.
    await Bun.sleep(100);
    const stillParked = await nativeFetch(`${base}/session/${created.id}/approvals`, { headers })
      .then((response) => response.json()) as { approvals: unknown[] };
    expect(stillParked.approvals).toHaveLength(1);
    const resolved = await nativeFetch(
      `${base}/session/${created.id}/approvals/${approval.id}`,
      { method: "POST", headers, body: JSON.stringify({ decision: "deny" }) },
    );
    expect(resolved.ok).toBe(true);
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "idle",
    );
    expect(session.messages.at(-1)?.content).toBe("approved:deny");
  });

  test("drops approvals when the agent that parked them dies", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "approval-death.log");
    const { base, headers } = await spawnBridge({ env: { FAKE_ACP_LIFECYCLE_FILE: lifecycleFile } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "needs permission", requestId: "approval-death-1" }),
    });
    await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) => response.json()) as Promise<{ approvals: unknown[] }>,
      (value) => value.approvals.length === 1,
    );

    process.kill(
      Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]),
      "SIGKILL",
    );
    const cleared = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) => response.json()) as Promise<{ approvals: unknown[] }>,
      (value) => value.approvals.length === 0,
    );
    expect(cleared.approvals).toEqual([]);
    const status = await nativeFetch(`${base}/session/${created.id}/status`, { headers })
      .then((response) => response.json()) as { status: string };
    expect(status.status).toBe("error");
  });

  test("serves an incremental transcript window anchored to an absolute index", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    for (const [index, text] of ["first", "second"].entries()) {
      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: `DIRECT:${text}`, requestId: `window-${index}` }),
      });
      await waitFor(
        async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string }>,
        (session) => session.status === "idle",
      );
    }

    const full = await nativeFetch(`${base}/session/${created.id}/messages`, { headers })
      .then((response) => response.json()) as { messages: Array<{ content: string }>; baseIndex: number; totalMessages: number };
    expect(full.messages.map((message) => message.content))
      .toEqual(["DIRECT:first", "first", "DIRECT:second", "second"]);
    expect(full.baseIndex).toBe(0);
    expect(full.totalMessages).toBe(4);

    const tail = await nativeFetch(`${base}/session/${created.id}/messages?fromIndex=3`, { headers })
      .then((response) => response.json()) as { messages: Array<{ content: string }>; baseIndex: number };
    expect(tail.messages.map((message) => message.content)).toEqual(["second"]);
    expect(tail.baseIndex).toBe(3);

    // Past the end and unparseable cursors clamp instead of throwing.
    const beyond = await nativeFetch(`${base}/session/${created.id}/messages?fromIndex=99`, { headers })
      .then((response) => response.json()) as { messages: unknown[]; baseIndex: number };
    expect(beyond.messages).toEqual([]);
    expect(beyond.baseIndex).toBe(4);
    const garbage = await nativeFetch(`${base}/session/${created.id}/messages?fromIndex=not-a-number`, { headers })
      .then((response) => response.json()) as { messages: unknown[]; baseIndex: number };
    expect(garbage.baseIndex).toBe(0);
    expect(garbage.messages).toHaveLength(4);
  });

  test("quarantines an unusable state file instead of refusing to start", async () => {
    const stateDirectory = await temporaryDirectory();
    const stateFile = resolve(stateDirectory, "state.json");

    // Seed a real state file so the restart path is genuine, then corrupt it.
    const seeded = await spawnBridge({ stateDirectory });
    await nativeFetch(`${seeded.base}/session/create`, {
      method: "POST",
      headers: seeded.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    });
    await waitFor(() => fs.readFile(stateFile, "utf8").catch(() => ""), Boolean);
    await stopChild(seeded.child);
    await fs.writeFile(stateFile, "{ this is not json");

    const restarted = await spawnBridge({ stateDirectory });
    expect((await nativeFetch(`${restarted.base}/global/health`)).ok).toBe(true);
    // Started clean: the old client key no longer resolves to a session.
    const created = await nativeFetch(`${restarted.base}/session/create`, {
      method: "POST",
      headers: restarted.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    });
    expect(created.status).toBe(201);
    const quarantined = await fs.readdir(stateDirectory);
    expect(quarantined.some((entry) => entry.includes("corrupt"))).toBe(true);
    // The damaged bytes are moved aside, not silently rewritten in place.
    expect(await fs.readFile(stateFile, "utf8")).not.toBe("{ this is not json");
  });

  test("restores a normalized composer across a bridge restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const stateFile = resolve(stateDirectory, "state.json");
    const seeded = await spawnBridge({ stateDirectory });
    const created = await nativeFetch(`${seeded.base}/session/create`, {
      method: "POST",
      headers: seeded.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    }).then((response) => response.json()) as { id: string };
    await waitFor(() => fs.readFile(stateFile, "utf8").catch(() => ""), Boolean);
    await stopChild(seeded.child);

    // The persisted-state validator is deliberately strict, so a healthy
    // round-trip has to be asserted too: a validator stricter than the
    // normalizer that produced the state would silently reset every composer.
    const restarted = await spawnBridge({ stateDirectory });
    const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json()) as {
      composer: {
        models: Array<{ id: string }>;
        selectedModelId?: string;
        selectedReasoningId?: string;
        modes: Array<{ id: string }>;
      };
    };
    expect(restored.composer.models.map((model) => model.id)).toEqual(["composer-2.5", "gpt-5.5"]);
    expect(restored.composer.selectedModelId).toBe("composer-2.5");
    expect(restored.composer.selectedReasoningId).toBe("medium");
    expect(restored.composer.modes.map((mode) => mode.id)).toEqual(["build", "plan"]);
    expect((await fs.readdir(stateDirectory)).some((entry) => entry.includes("corrupt"))).toBe(false);
  });

  test("resets one malformed composer without discarding its sibling sessions", async () => {
    const stateDirectory = await temporaryDirectory();
    const stateFile = resolve(stateDirectory, "state.json");
    const seeded = await spawnBridge({ stateDirectory });
    const [healthy, damaged] = await Promise.all([
      nativeFetch(`${seeded.base}/session/create`, {
        method: "POST",
        headers: seeded.headers,
        body: JSON.stringify({ clientSessionKey: "env-1:healthy" }),
      }).then((response) => response.json()) as Promise<{ id: string }>,
      nativeFetch(`${seeded.base}/session/create`, {
        method: "POST",
        headers: seeded.headers,
        body: JSON.stringify({ clientSessionKey: "env-1:damaged" }),
      }).then((response) => response.json()) as Promise<{ id: string }>,
    ]);
    await waitFor(
      () => fs.readFile(stateFile, "utf8").catch(() => ""),
      (contents) => contents.includes(healthy.id) && contents.includes(damaged.id),
    );
    await stopChild(seeded.child);

    const persisted = JSON.parse(await fs.readFile(stateFile, "utf8")) as {
      sessions: Array<{ id: string; sessionConfig?: unknown; composer?: unknown }>;
    };
    const target = persisted.sessions.find((session) => session.id === damaged.id)!;
    target.sessionConfig = { composer: {}, wire: {} };
    delete target.composer;
    await fs.writeFile(stateFile, JSON.stringify(persisted));

    // Composer configuration is a cache the next session/load rebuilds. Losing
    // it must not take the transcript, the client-key mapping or the prompt
    // journal of every *other* session with it.
    const restarted = await spawnBridge({ stateDirectory });
    const survivor = await nativeFetch(`${restarted.base}/session/${healthy.id}`, {
      headers: restarted.headers,
    });
    expect(survivor.status).toBe(200);
    expect((await survivor.json() as { composer: { models: unknown[] } }).composer.models)
      .toHaveLength(2);
    const reset = await nativeFetch(`${restarted.base}/session/${damaged.id}`, {
      headers: restarted.headers,
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ composer: { models: [], modes: [] } });
    // Nothing was quarantined: the file itself was never unreadable.
    expect((await fs.readdir(stateDirectory)).some((entry) => entry.includes("corrupt"))).toBe(false);
    // The damaged session kept its durable identity, so its key still resolves.
    const rebound = await nativeFetch(`${restarted.base}/session/create`, {
      method: "POST",
      headers: restarted.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:damaged" }),
    });
    expect(await rebound.json()).toMatchObject({ id: damaged.id });
  });

  test("starts clean when the state file belongs to another provider", async () => {
    const stateDirectory = await temporaryDirectory();
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({ version: 1, provider: "grok", sessions: [] }),
    );
    const bridge = await spawnBridge({ stateDirectory });
    expect((await nativeFetch(`${bridge.base}/global/health`)).ok).toBe(true);
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    });
    expect(created.status).toBe(201);
  });

  // A v1 file is what every already-installed bridge left on disk. Its parts
  // use the pre-consolidation `{ type: "reasoning", text }` wire shape, which
  // the renderer no longer converts, so the load path has to upgrade them or
  // the restored transcript renders as empty rows.
  test("upgrades v1 persisted messages to the neutral part shape", async () => {
    const stateDirectory = await temporaryDirectory();
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({
        version: 1,
        provider: "cursor",
        sessions: [{
          id: "session-v1",
          clientSessionKey: "env-1:tab-1",
          acpSessionId: "acp-session-v1",
          status: "idle",
          revision: 7,
          structured: [],
          promptJournal: [],
          messages: [
            {
              id: "message-user",
              role: "user",
              content: "Do the work",
              parts: [{ type: "text", text: "Do the work" }],
              createdAt: "2026-08-01T00:00:00.000Z",
            },
            {
              id: "message-assistant",
              role: "assistant",
              content: "approved:once",
              parts: [
                { type: "reasoning", text: "Checking permission. " },
                { type: "text", text: "approved:once" },
              ],
              createdAt: "2026-08-01T00:00:01.000Z",
            },
          ],
        }],
      }),
    );

    const bridge = await spawnBridge({ stateDirectory });
    const session = await nativeFetch(`${bridge.base}/session/session-v1`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as {
      revision: number;
      messages: Array<{
        id: string;
        parts: Array<Record<string, unknown>>;
      }>;
    };

    expect(session.revision).toBe(7);
    expect(session.messages.map((message) => message.id))
      .toEqual(["message-user", "message-assistant"]);
    // `reasoning` becomes `thinking`, `text` becomes `content`, and the part
    // identity the renderer keys off is synthesized rather than left absent.
    expect(session.messages[1]?.parts).toEqual([
      {
        type: "thinking",
        content: "Checking permission. ",
        sourcePartId: "message-assistant:0",
        sourceMessageId: "message-assistant",
      },
      {
        type: "text",
        content: "approved:once",
        sourcePartId: "message-assistant:1",
        sourceMessageId: "message-assistant",
      },
    ]);
    expect(session.messages[0]?.parts).toEqual([
      {
        type: "text",
        content: "Do the work",
        sourcePartId: "message-user:0",
        sourceMessageId: "message-user",
      },
    ]);

    // Loading alone does not rewrite the file; the next persist does, and it
    // must write the current shape with upgraded parts so this migration runs only once.
    const createdAfterLoad = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-2" }),
    });
    expect(createdAfterLoad.status).toBe(201);

    const rewritten = await waitFor(
      async () => JSON.parse(
        await fs.readFile(resolve(stateDirectory, "state.json"), "utf8"),
      ) as {
        version: number;
        sessions: Array<{ id: string; messages: Array<{ parts: Array<{ type: string }> }> }>;
      },
      (value) => value.version === 3,
    );
    expect(
      rewritten.sessions
        .find((persisted) => persisted.id === "session-v1")
        ?.messages[1]?.parts.map((part) => part.type),
    ).toEqual(["thinking", "text"]);
  });

  test("normalizes Cursor ACP config into composer state and applies patches", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const session = await created.json() as {
      id: string;
      composer: {
        models: Array<{ id: string; label: string; platform: string }>;
        selectedModelId?: string;
        selectedReasoningId?: string;
        fastModeAvailable: boolean;
        selectedModeId?: string;
        modes: Array<{ id: string }>;
      };
    };
    expect(session.composer.models.map((model) => model.id)).toEqual(["composer-2.5", "gpt-5.5"]);
    expect(session.composer.models[0]).toMatchObject({
      platform: "cursor",
      label: "Composer 2.5",
    });
    expect(session.composer.selectedModelId).toBe("composer-2.5");
    expect(session.composer.selectedReasoningId).toBe("medium");
    expect(session.composer.fastModeAvailable).toBe(true);
    expect(session.composer.selectedModeId).toBe("build");
    expect(JSON.stringify(session)).not.toContain("configOptions");
    expect(JSON.stringify(session)).not.toContain("_meta");

    const catalog = await nativeFetch(`${base}/global/models`, { headers })
      .then((response) => response.json()) as { models: Array<{ id: string }> };
    expect(catalog.models.map((model) => model.id)).toEqual(["composer-2.5", "gpt-5.5"]);

    const updated = await nativeFetch(`${base}/session/${session.id}/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        modelId: "gpt-5.5",
        reasoningId: "high",
        fastMode: true,
        mode: "plan",
      }),
    });
    expect(updated.status).toBe(200);
    const composer = await updated.json() as {
      selectedModelId?: string;
      selectedReasoningId?: string;
      fastModeEnabled: boolean | null;
      selectedModeId?: string;
    };
    expect(composer.selectedModelId).toBe("gpt-5.5");
    expect(composer.selectedReasoningId).toBe("high");
    expect(composer.fastModeEnabled).toBe(true);
    expect(composer.selectedModeId).toBe("plan");
  });

  test("normalizes Grok ACP models and reasoning without leaking vendor wire", async () => {
    const { base, headers } = await spawnBridge({ env: { ACP_PROVIDER: "grok" } });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const session = await created.json() as {
      id: string;
      composer: {
        models: Array<{ id: string; reasoning?: Array<{ id: string; label: string }> }>;
        selectedModelId?: string;
        selectedReasoningId?: string;
      };
    };
    expect(session.composer.selectedModelId).toBe("grok-build");
    expect(session.composer.selectedReasoningId).toBe("high");
    expect(session.composer.models[0]?.reasoning?.map((option) => option.id)).toEqual(["low", "high", "xhigh"]);
    expect(JSON.stringify(session)).not.toContain("reasoningEfforts");

    const updated = await nativeFetch(`${base}/session/${session.id}/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reasoningId: "low" }),
    });
    expect(updated.status).toBe(200);
    const composer = await updated.json() as { selectedReasoningId?: string };
    expect(composer.selectedReasoningId).toBe("low");
  });

  test("applies Grok vendor catalogue updates to session and global snapshots", async () => {
    const { base, headers } = await spawnBridge({ env: {
      ACP_PROVIDER: "grok",
      FAKE_ACP_EMIT_MODEL_UPDATE: "1",
    } });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };
    const dispatched = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIRECT:update models", requestId: "model-update" }),
    });
    expect(dispatched.status).toBe(202);

    const session = await waitFor(
      () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{
        status: string;
        composer: { selectedModelId?: string; models: Array<{ id: string }> };
      }>,
      (value) => value.status === "idle" && value.composer.models.some((model) => model.id === "grok-next"),
    );
    expect(session.composer.selectedModelId).toBe("grok-next");
    const catalog = await nativeFetch(`${base}/global/models`, { headers })
      .then((response) => response.json()) as { models: Array<{ id: string }> };
    expect(catalog.models.map((model) => model.id)).toContain("grok-next");
  });

  for (const acpProvider of ["cursor", "grok"] as const) {
    test(`sends and rehydrates workspace images for ${acpProvider}`, async () => {
      const workspace = await temporaryDirectory();
      const stateDirectory = await temporaryDirectory();
      const blocksFile = resolve(workspace, "prompt-blocks.log");
      const filename = "screen #1?.png";
      const imagePath = resolve(workspace, filename);
      await fs.writeFile(imagePath, ONE_PIXEL_PNG);
      const bridgeEnv = {
        ACP_PROVIDER: acpProvider,
        CWD: workspace,
        FAKE_ACP_PROMPT_BLOCKS_FILE: blocksFile,
        // Grok currently understates this capability but accepts the standard
        // image block; keep that compatibility case explicit in the harness.
        FAKE_ACP_IMAGE_CAPABILITY: acpProvider === "cursor" ? "true" : "false",
      };
      const first = await spawnBridge({ stateDirectory, env: bridgeEnv });
      const created = await nativeFetch(`${first.base}/session/create`, {
        method: "POST",
        headers: first.headers,
      }).then((response) => response.json()) as { id: string };

      const dispatched = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
        method: "POST",
        headers: first.headers,
        body: JSON.stringify({
          prompt: "DIRECT:describe it",
          requestId: "image-1",
          // Relative to the workspace, as a renderer pick from the file tree is.
          attachments: [{ type: "image", path: filename, filename }],
        }),
      });
      expect(dispatched.status).toBe(202);
      await waitFor(
        () => nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers })
          .then((response) => response.json()) as Promise<{ status: string }>,
        (session) => session.status === "idle",
      );

      const blocks = JSON.parse((await fs.readFile(blocksFile, "utf8")).trim()) as Array<{
        type: string;
        text?: string;
        mimeType?: string;
        data?: string;
      }>;
      expect(blocks[0]).toMatchObject({ type: "text", text: "DIRECT:describe it" });
      // The bytes must reach the model natively; a path in the prompt text only
      // works if the agent happens to open it, and neither agent reads images
      // through its own file tools.
      expect(blocks[1]).toEqual({
        type: "image",
        mimeType: "image/png",
        data: ONE_PIXEL_PNG.toString("base64"),
      });

      const transcript = await nativeFetch(`${first.base}/session/${created.id}`, {
        headers: first.headers,
      }).then((response) => response.json()) as {
        messages: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      };
      const user = transcript.messages.find((message) => message.role === "user");
      const filePart = user?.parts.find((part) => part.type === "file");
      // The encoded basename is pinned literally rather than recomputed with
      // `pathToFileURL`: restating the implementation would still pass against
      // the `file://${path}` template this replaced, which leaves `#` parsing as
      // a fragment and resolves the preview to the wrong file or none at all.
      // Only the temporary directory is derived, since it varies per run.
      expect(filePart).toEqual({
        type: "file",
        content: filename,
        fileUrl: `${pathToFileURL(workspace).href}/screen%20%231%3F.png`,
        sourcePartId: expect.any(String),
        sourceMessageId: expect.any(String),
      });

      await stopChild(first.child);
      const restarted = await spawnBridge({ stateDirectory, env: bridgeEnv });
      const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
        headers: restarted.headers,
      }).then((response) => response.json()) as {
        messages: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      };
      expect(restored.messages.find((message) => message.role === "user")?.parts)
        .toContainEqual(filePart);
    });
  }

  test("dispatches an image-only prompt and indexes every attachment part", async () => {
    const workspace = await temporaryDirectory();
    const blocksFile = resolve(workspace, "prompt-blocks.log");
    await fs.writeFile(resolve(workspace, "first.png"), ONE_PIXEL_PNG);
    await fs.writeFile(resolve(workspace, "second.png"), ONE_PIXEL_PNG);
    const { base, headers } = await spawnBridge({ env: {
      CWD: workspace,
      FAKE_ACP_PROMPT_BLOCKS_FILE: blocksFile,
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    const dispatched = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        // Attaching a picture with no message at all is a normal send, so an
        // empty prompt with attachments must not be refused as an empty turn.
        prompt: "",
        requestId: "image-only-1",
        attachments: [
          { type: "image", path: "first.png", filename: "first.png" },
          { type: "image", path: "second.png", filename: "second.png" },
        ],
      }),
    });
    expect(dispatched.status).toBe(202);
    await waitFor(
      () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );

    const blocks = JSON.parse((await fs.readFile(blocksFile, "utf8")).trim()) as Array<{
      type: string;
    }>;
    // No empty text block: an agent handed `{ type: "text", text: "" }` can read
    // it as an instruction, and both agents accept an image-only prompt.
    expect(blocks.map((block) => block.type)).toEqual(["image", "image"]);

    const user = await nativeFetch(`${base}/session/${created.id}`, { headers })
      .then((response) => response.json())
      .then((session) => (session as {
        messages: Array<{ role: string; content: string; parts: Array<Record<string, unknown>> }>;
      }).messages.find((message) => message.role === "user"));
    expect(user?.content).toBe("");
    expect(user?.parts.map((part) => part.type)).toEqual(["file", "file"]);
    expect(user?.parts.map((part) => part.content)).toEqual(["first.png", "second.png"]);
    // Part ids stay one-based across the attachments so the second image cannot
    // reuse the id the text part would have taken.
    const messageId = user?.parts[0]?.sourceMessageId;
    expect(typeof messageId).toBe("string");
    expect(user?.parts.map((part) => part.sourcePartId))
      .toEqual([`${messageId}:1`, `${messageId}:2`]);
  });

  test("refuses attachments the bridge cannot safely read and leaves the turn dispatchable", async () => {
    const workspace = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const blocksFile = resolve(workspace, "prompt-blocks.log");
    await fs.writeFile(resolve(outside, "secret.png"), ONE_PIXEL_PNG);
    await fs.writeFile(resolve(workspace, "notes.txt"), "not an image");
    const { base, headers } = await spawnBridge({ env: {
      CWD: workspace,
      FAKE_ACP_PROMPT_BLOCKS_FILE: blocksFile,
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    const send = (attachment: unknown) => nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "DIRECT:describe it",
        requestId: "rejected-1",
        attachments: [attachment],
      }),
    });

    const escaped = await send({ type: "image", path: resolve(outside, "secret.png") });
    expect(escaped.status).toBe(400);
    expect(await escaped.json()).toMatchObject({
      error: expect.stringContaining("workspace") as never,
    });

    const notAnImage = await send({ type: "image", path: "notes.txt" });
    expect(notAnImage.status).toBe(400);

    const notAnAttachment = await send({ type: "file", path: "notes.txt" });
    expect(notAnAttachment.status).toBe(400);

    // A rejected attachment never started a turn, so the same requestId must
    // still be dispatchable rather than parked as an accepted prompt.
    await fs.writeFile(resolve(workspace, "ok.png"), ONE_PIXEL_PNG);
    const accepted = await send({ type: "image", path: "ok.png" });
    expect(accepted.status).toBe(202);
    await waitFor(
      () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );
    expect((await fs.readFile(blocksFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });
});
