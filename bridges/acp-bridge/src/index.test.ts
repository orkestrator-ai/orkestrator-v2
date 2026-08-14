import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The repository-wide test preload installs a browser-like fetch for UI tests.
// Use Bun's native client for loopback bridge integration requests so browser
// CORS rules cannot turn these GETs into preflight requests.
const nativeFetch = Bun.fetch;
const children = new Set<ChildProcessWithoutNullStreams>();
const temporaryDirectories = new Set<string>();

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

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  let latest!: T;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ACP state: ${JSON.stringify(latest)}`);
}

async function spawnBridge(options: {
  port?: number;
  token?: string;
  stateDirectory?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<{ child: ChildProcessWithoutNullStreams; base: string; headers: Record<string, string> }> {
  const port = options.port ?? await unusedPort();
  const token = options.token ?? "integration-test-token";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ACP_PROVIDER: "cursor",
    ACP_AGENT_PATH: resolve(here, "testing/fake-agent.ts"),
    ACP_BRIDGE_TOKEN: token,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    ...(options.stateDirectory ? { ACP_STATE_DIR: options.stateDirectory } : {}),
    ...options.env,
  };
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
        type: "text",
        content: "approved:once",
        sourcePartId: expect.any(String),
        sourceMessageId: expect.any(String),
      },
    ]);
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

  test("bounds one oversized response and marks the turn failed", async () => {
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
    // must write v2 with the upgraded parts so this migration runs only once.
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
      (value) => value.version === 2,
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
});
