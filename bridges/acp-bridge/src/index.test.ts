import { afterEach, describe, expect, test } from "bun:test";
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

  for (const acpProvider of ["cursor", "grok"] as const) {
    test(`lists and resumes provider-owned ${acpProvider} sessions`, async () => {
      const directory = await temporaryDirectory();
      const lifecycleFile = resolve(directory, `${acpProvider}-resume-lifecycle.log`);
      const bridge = await spawnBridge({ env: {
        ACP_PROVIDER: acpProvider,
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
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
          mode: "plan",
          reasoningId: "high",
        }),
      });
      expect(resumedResponse.status).toBe(201);
      const resumed = await resumedResponse.json() as {
        id: string;
        sessionId: string;
        status: string;
      };
      expect(resumed.id).toBe(resumed.sessionId);
      expect(resumed.id).not.toBe(external!.id);
      expect(resumed.status).toBe("idle");
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
      error: "cursor cannot list persisted ACP sessions",
    });
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
        before: "const value = 1;",
        after: "const value = 2;\nconst ready = true;",
      },
    });
    expect((assistantParts?.[1]?.toolDiff as { diff?: string } | undefined)?.diff).toContain(
      "-const value = 1;\n+const value = 2;\n+const ready = true;",
    );
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

  test("fails the session when tool parts exhaust the per-message limit", async () => {
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
      (value) => value.status === "error",
    );

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
