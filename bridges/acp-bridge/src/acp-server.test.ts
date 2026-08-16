import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import {
  children,
  here,
  nativeFetch,
  spawnBridge,
  stopChild,
  temporaryDirectory,
  waitFor,
} from "./acp-test-harness.js";


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
