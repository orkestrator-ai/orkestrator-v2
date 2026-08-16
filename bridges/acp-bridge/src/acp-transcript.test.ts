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



  test("applies Cursor's cursor/task notification onto the matching Task launch", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORTASK: summarize" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.messages.some((message) =>
        message.parts.some((part) =>
          part.toolUseId === "cursor-task-1"
          && (part.toolArgs as { description?: string } | undefined)?.description
            === "Summarize two docs"
        )
      ),
    );
    expect(settled.messages.flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "cursor-task-1")).toMatchObject({
      toolName: "task",
      toolState: "success",
      agentState: "finished",
      toolArgs: {
        description: "Summarize two docs",
        prompt: "Read docs/upgrade-agents.md and docs/flaky-tests.md. Return one line each.",
        subagent_type: "explore",
        model: "composer-2.5",
        agentId: "bc-abc123",
        durationMs: 1_240,
      },
    });
  });



  test("acknowledges a cursor/task request instead of refusing it", async () => {
    const directory = await temporaryDirectory();
    const responseFile = resolve(directory, "cursor-task-response.log");
    const { base, headers } = await spawnBridge({
      env: { FAKE_ACP_CURSOR_TASK_REQUEST_FILE: responseFile },
    });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-request:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORTASKREQUEST: summarize" }),
    })).status).toBe(202);

    const response = await waitFor(
      () => fs.readFile(responseFile, "utf8")
        .then((value) => JSON.parse(value.trim()))
        .catch(() => null) as Promise<Record<string, unknown> | null>,
      Boolean,
    );
    expect(response).toMatchObject({
      id: 903,
      result: {},
    });
    expect(response).not.toHaveProperty("error");
    expect(response).not.toHaveProperty("result.outcome");

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.messages.some((message) =>
        message.parts.some((part) =>
          (part.toolArgs as { description?: string } | undefined)?.description
            === "Summarize two docs"
        )
      ),
    );
    expect(settled.messages.flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "cursor-task-1")).toMatchObject({
      agentState: "finished",
      toolArgs: { subagent_type: "explore" },
    });
  });



  test("keeps cursor/task launch args after a later generic Task rawInput patch", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-wipe:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORTASKWIPE: summarize" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    const parts = settled.messages.flatMap((message) => message.parts)
      .filter((part) => part.toolUseId === "cursor-task-wipe");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolName: "task",
      toolState: "success",
      toolArgs: {
        description: "Summarize two docs",
        prompt: "Read docs/upgrade-agents.md and docs/flaky-tests.md.",
        subagent_type: "explore",
        model: "composer-2.5",
        agentId: "bc-wipe",
        durationMs: 1_240,
      },
    });
  });



  test("creates a single Task part when cursor/task arrives before the tool_call", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-first:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORTASKFIRST: explore" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    const parts = settled.messages.flatMap((message) => message.parts)
      .filter((part) => part.toolUseId === "cursor-task-first");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolName: "task",
      toolTitle: "Task: Subagent task",
      agentState: "active",
      toolArgs: {
        description: "Explore the repo",
        prompt: "List the files that own native chat rendering.",
        subagent_type: "explore",
        model: "composer-2.5",
        agentId: "bc-first",
      },
    });
  });



  test("trims oldest parts when a synthetic cursor/task would exceed the per-message cap", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-cap:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORTASKCAP: overflow" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(settled.error).toBeUndefined();
    expect(settled.messages[1]?.parts).toHaveLength(512);
    expect(settled.messages[1]?.parts[0]).toMatchObject({
      type: "text",
      content: expect.stringContaining("Earlier steps in this response were dropped"),
    });
    expect(settled.messages[1]?.parts.at(-1)).toMatchObject({
      toolUseId: "cursor-task-cap",
      toolName: "task",
      toolArgs: { description: "Overflow task", subagent_type: "explore" },
    });
    expect(settled.messages[1]?.parts.filter((part) => part.toolUseId === "cursor-task-cap"))
      .toHaveLength(1);
  });



  test("charges a cursor/task prompt so a near-cap transcript stays inside the byte budget", async () => {
    const maximumTranscriptBytes = 1024 * 1024;
    const { base, headers } = await spawnBridge({
      env: { ACP_MAX_TRANSCRIPT_BYTES: String(maximumTranscriptBytes) },
    });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-charge:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORTASKCHARGE: fill then prompt" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(settled.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(settled.messages)))
      .toBeLessThanOrEqual(maximumTranscriptBytes);
    const charged = settled.messages.flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "cursor-task-charge");
    expect(charged).toMatchObject({
      toolName: "task",
      toolArgs: { description: "Charge the prompt", subagent_type: "explore" },
    });
    expect((charged?.toolArgs as { prompt?: string } | undefined)?.prompt?.length)
      .toBe(64 * 1024);
  });



  test("only accepts a real cursor/task duration, never a coerced null or blank", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-durations:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORTASKDURATIONS: coerce" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    const byId = new Map(settled.messages.flatMap((message) => message.parts)
      .map((part) => [part.toolUseId as string, part]));

    // Reportable durations settle the sub-agent and survive into the args.
    expect(byId.get("duration-zero")).toMatchObject({
      toolState: "success",
      agentState: "finished",
      toolArgs: { durationMs: 0 },
    });
    expect(byId.get("duration-string")).toMatchObject({
      toolState: "success",
      agentState: "finished",
      toolArgs: { durationMs: 1_500 },
    });
    expect(byId.get("duration-float")).toMatchObject({
      toolState: "success",
      toolArgs: { durationMs: 12 },
    });

    // Everything else means "no duration reported". `Number()` would turn
    // null/true/""/[] into 0 and finish a sub-agent that is still running, so
    // each must leave the part unsettled and carry no `durationMs` at all.
    for (const toolUseId of [
      "duration-negative",
      "duration-null",
      "duration-boolean",
      "duration-empty",
      "duration-array",
      "duration-text",
    ]) {
      const part = byId.get(toolUseId);
      expect({ toolUseId, part: part !== undefined }).toEqual({ toolUseId, part: true });
      expect({ toolUseId, durationMs: (part?.toolArgs as { durationMs?: unknown })?.durationMs })
        .toEqual({ toolUseId, durationMs: undefined });
      // Never reported complete, so the turn's own reconciliation settles it.
      expect({ toolUseId, agentState: part?.agentState })
        .toEqual({ toolUseId, agentState: "failed" });
    }
  });



  test("keeps a null-duration cursor/task running and still reports it as activity", async () => {
    const directory = await temporaryDirectory();
    const holdTurnFile = resolve(directory, "release-turn");
    const { base, headers } = await spawnBridge({
      env: { FAKE_ACP_HOLD_TURN_FILE: holdTurnFile },
    });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-held:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORTASKHELD: run" }),
    })).status).toBe(202);

    // Observed while the turn is genuinely still open, not by racing its end.
    const running = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "running"
        && value.messages.flatMap((message) => message.parts)
          .some((part) => part.toolUseId === "cursor-task-held"),
    );
    const live = running.messages.flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "cursor-task-held");
    expect(live).toMatchObject({
      toolName: "task",
      toolState: "pending",
      agentState: "active",
      toolArgs: { description: "Held task", subagent_type: "explore" },
    });
    expect((live?.toolArgs as { durationMs?: unknown }).durationMs).toBeUndefined();
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "working" });

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(settled.messages.flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "cursor-task-held")).toMatchObject({
      toolState: "success",
      agentState: "finished",
      toolArgs: { description: "Held task", durationMs: 2_400 },
    });
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });
  });



  test("drops a cursor/task whose launch part was already trimmed away", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-trimmed:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORTASKTRIMMED: overflow" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(settled.error).toBeUndefined();
    expect(settled.messages[1]?.parts).toHaveLength(512);
    expect(settled.messages[1]?.parts[0]).toMatchObject({
      type: "text",
      content: expect.stringContaining("Earlier steps in this response were dropped"),
    });
    // The launch was evicted on purpose. Rebuilding it here would append the
    // task *after* the notice saying those steps went, detached from the work
    // it launched, so the late metadata is dropped instead.
    expect(settled.messages.flatMap((message) => message.parts)
      .filter((part) => part.toolUseId === "cursor-task-trimmed")).toHaveLength(0);
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });
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

});
