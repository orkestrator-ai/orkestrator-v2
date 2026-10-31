/**
 * Hosted web search against the **real** pinned `codex app-server` binary.
 *
 * A coordinator's permission profile turns the network off for commands, but
 * web search is a hosted tool: OpenAI's servers fetch the page, so the profile
 * never sees it. These tests point Codex at a loopback Responses endpoint and
 * read the tool list from the first model request, so they prove what the
 * model is offered without calling a model or spending credits. Gated like the
 * other live contract tests because they need the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-network-lock.test.ts
 *
 * The first test is the control: an ordinary thread is offered web search, so
 * a probe that saw nothing cannot pass the others by accident.
 *
 * What the request cannot show is the difference between `cached` and `live`
 * search: Codex sends the same tool either way and applies the mode when the
 * tool runs. A separately gated canary proves it with real turns. It copies
 * the local auth file and spends a few short model turns:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 RUN_LIVE_CODEX_WEB_SEARCH_CANARY=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-network-lock.test.ts
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { COORDINATOR_WEB_RESEARCH_ENV } from "@orkestrator/protocol/coordinator-web-research";
import {
  codexAppServerConfigOverrides,
  codexCoordinatorPolicy,
  codexHostedNetworkLockGaps,
  codexReadOnlyTurnPolicy,
} from "../codex-config.js";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineTurnConfig } from "../engine/types.js";
import { JsonlRpcClient } from "./jsonl-rpc-client.js";
import { resolveCodexBinary } from "./live-binary.js";

// See `live-contract.test.ts`: the test preload replaces `Response`, and
// `Bun.serve` only accepts its own.
const NATIVE_WEB_PLATFORM_KEY = Symbol.for("orkestrator.tests.native-web-platform");
const NativeResponse =
  (globalThis as typeof globalThis & { [key: symbol]: { Response?: typeof Response } | undefined })[
    NATIVE_WEB_PLATFORM_KEY
  ]?.Response ?? Response;

const LIVE = process.env.RUN_LIVE_CODEX_APP_SERVER === "1";
const describeLive = LIVE ? describe : describe.skip;
const describeLiveSearchCanary =
  LIVE && process.env.RUN_LIVE_CODEX_WEB_SEARCH_CANARY === "1" ? describe : describe.skip;

const CLIENT_INFO = { name: "orkestrator", title: "Orkestrator", version: "2.4.9" };
const PROFILE = "coordinator-network-lock";
const PROMPT = "Search the web for https://example.com and tell me its title.";

interface FakeResponses {
  baseUrl: string;
  /** The first `response.create` frame Codex sends. */
  firstRequest: Promise<Record<string, unknown>>;
  stop: () => Promise<void>;
}

/**
 * A Responses endpoint that records the request and fails it.
 *
 * Codex opens the Responses API as a WebSocket and sends each request as one
 * `response.create` frame, its tools in an `additional_tools` input item.
 * Since 0.164.0 a turn starts with a prewarm frame (`generate: false`, no
 * input, no tools). A prewarm is never the request these tests read; closing
 * its socket makes Codex reconnect and send the real one, and closing that one
 * makes the turn fail, which is all these tests need.
 */
function startFakeResponses(): FakeResponses {
  let capture!: (frame: Record<string, unknown>) => void;
  const firstRequest = new Promise<Record<string, unknown>>((resolve) => {
    capture = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && bun.upgrade(request)) {
        return undefined;
      }
      return new NativeResponse("not served", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        try {
          const frame = JSON.parse(String(message)) as Record<string, unknown>;
          if (isModelRequest(frame)) capture(frame);
        } catch {
          // Only the request frame matters.
        }
        socket.close(1011, "recorded");
      },
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    firstRequest,
    stop: async () => {
      await server.stop(true);
    },
  };
}

/** A `response.create` frame that samples, as opposed to a `generate: false` prewarm. */
function isModelRequest(frame: Record<string, unknown>): boolean {
  return frame.type === "response.create" && frame.generate !== false;
}

/**
 * Whether a model request declares hosted web search anywhere: in a top-level
 * `tools` array or in any `additional_tools` input item, history included.
 *
 * With `incremental_tools` on (the 0.164.0 default) each turn's tools are
 * appended to the history, so a resumed thread's request kept an earlier
 * turn's `web__run` after a later turn dropped it. The bridge turns the
 * feature off, and these tests require that no declaration survives at all.
 */
function offersWebSearch(frame: Record<string, unknown>): boolean {
  const text = JSON.stringify(frame);
  // Code mode (the default model and most of the 0.164.0 catalog) nests it in
  // the `exec` declaration as `web__run`; outside code mode it is a
  // `web_search` tool.
  return text.includes("web__run") || /"type":"web_search/.test(text);
}

/** Codex's goal tools, offered while `features.goals` is on (its default). */
const GOAL_TOOLS = ["create_goal", "get_goal", "update_goal"];

function offeredGoalTools(frame: Record<string, unknown>): string[] {
  const text = JSON.stringify(frame);
  return GOAL_TOOLS.filter((name) => text.includes(name));
}

/** Whether a model request still carries tools at all, so absence means something. */
function offersTools(frame: Record<string, unknown>): boolean {
  return JSON.stringify(frame).includes('"name":"exec"');
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A throwaway CODEX_HOME holding a placeholder API key, and a git workspace. */
async function sandbox(): Promise<{ codexHome: string; workspace: string }> {
  const codexHome = await mkdtemp(join(tmpdir(), "ork-netlock-home-"));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "ork-netlock-ws-")));
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  // Never a real key: the only server it can reach is the loopback fake.
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
    { mode: 0o600 },
  );
  return { codexHome, workspace };
}

function engineFor(options: {
  codexPath: string;
  codexHome: string;
  workspace: string;
  configOverrides: Record<string, string>;
}): AppServerEngine {
  return new AppServerEngine({
    codexPath: options.codexPath,
    cwd: options.workspace,
    codexHome: options.codexHome,
    clientInfo: CLIENT_INFO,
    configOverrides: options.configOverrides,
    supervisorOverrides: { pidFileEnabled: false },
  });
}

/** Starts one thread and one turn through the bridge's engine, returning the model request. */
async function firstModelRequest(
  engine: AppServerEngine,
  responses: FakeResponses,
  config: EngineTurnConfig,
): Promise<Record<string, unknown>> {
  await engine.start();
  const thread = await engine.startThread({ config });
  await engine.startTurn({
    handle: thread.handle,
    input: [{ type: "text", text: PROMPT }],
    config,
  });
  return withTimeout(responses.firstRequest, 60_000, "the model request");
}

describeLive("live hosted network lock", () => {
  test("an ordinary thread is offered hosted web search (control)", async () => {
    const { codexHome, workspace } = await sandbox();
    const responses = startFakeResponses();
    const child = spawn(
      await resolveCodexBinary(),
      ["app-server", "--stdio", "-c", `openai_base_url=${JSON.stringify(responses.baseUrl)}`],
      {
        cwd: workspace,
        env: { ...process.env, CODEX_HOME: codexHome, LOG_FORMAT: "json" },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    child.stderr.resume();
    const client = new JsonlRpcClient({
      generation: 1,
      stdin: child.stdin,
      stdout: child.stdout,
      onNotification: () => undefined,
      onServerRequest: () => undefined,
    });
    try {
      await client.request("initialize", {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      await client.notify("initialized");
      // Network off for commands: what a coordinator had before this lock.
      const started = await client.request<{ thread: { id: string } }>("thread/start", {
        cwd: workspace,
        sandbox: "read-only",
        approvalPolicy: "never",
      });
      await client.request("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: PROMPT, text_elements: [] }],
      });
      const frame = await withTimeout(responses.firstRequest, 60_000, "the model request");
      expect(offersTools(frame)).toBe(true);
      expect(offersWebSearch(frame)).toBe(true);
    } finally {
      client.close();
      child.stdin.end();
      child.kill("SIGTERM");
      await responses.stop();
    }
  }, 120_000);

  test("Codex's goal tools are offered by default and not on a bridge thread", async () => {
    // Control: Codex's own default offers them, so their absence below
    // means the bridge's override removed them.
    const control = await sandbox();
    const controlResponses = startFakeResponses();
    const { "features.goals": _goals, ...withoutGoalsOverride } = codexAppServerConfigOverrides({});
    const controlEngine = engineFor({
      codexPath: await resolveCodexBinary(),
      codexHome: control.codexHome,
      workspace: control.workspace,
      configOverrides: {
        ...withoutGoalsOverride,
        openai_base_url: JSON.stringify(controlResponses.baseUrl),
      },
    });
    const { codexHome, workspace } = await sandbox();
    const responses = startFakeResponses();
    const engine = engineFor({
      codexPath: await resolveCodexBinary(),
      codexHome,
      workspace,
      configOverrides: {
        ...codexAppServerConfigOverrides({}),
        openai_base_url: JSON.stringify(responses.baseUrl),
      },
    });
    const turn = (cwd: string): EngineTurnConfig => ({
      mode: "build",
      cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      networkAccessEnabled: true,
      policy: {
        id: "interactive-host",
        sandbox: "none",
        approvals: "auto-approve",
        projectResources: true,
        networkAccess: "full",
      },
    });
    try {
      const controlFrame = await firstModelRequest(
        controlEngine,
        controlResponses,
        turn(control.workspace),
      );
      expect(offeredGoalTools(controlFrame)).toEqual(GOAL_TOOLS);
      const frame = await firstModelRequest(engine, responses, turn(workspace));
      expect(offersTools(frame)).toBe(true);
      expect(offeredGoalTools(frame)).toEqual([]);
    } finally {
      await controlEngine.stop();
      await engine.stop();
      await controlResponses.stop();
      await responses.stop();
    }
  }, 120_000);

  test("a coordinator's effective configuration reads back with web search off", async () => {
    const { codexHome, workspace } = await sandbox();
    const engine = engineFor({
      codexPath: await resolveCodexBinary(),
      codexHome,
      workspace,
      configOverrides: codexAppServerConfigOverrides({
        ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
        CODEX_BRIDGE_PERMISSION_PROFILE: PROFILE,
        CODEX_BRIDGE_READABLE_RUNTIME_ROOT: workspace,
        CWD: workspace,
      }),
    });
    try {
      await engine.start();
      // The same request the engine makes before a coordinator thread, under
      // the bridge's own non-experimental client capabilities.
      const read = await engine
        .getSupervisor()
        .request<{ config?: unknown }>("config/read", { cwd: workspace });
      expect(codexHostedNetworkLockGaps(read.config)).toEqual([]);
    } finally {
      await engine.stop();
    }
  }, 120_000);

  test("a coordinator thread is never offered hosted web search", async () => {
    const { codexHome, workspace } = await sandbox();
    const responses = startFakeResponses();
    const engine = engineFor({
      codexPath: await resolveCodexBinary(),
      codexHome,
      workspace,
      configOverrides: {
        ...codexAppServerConfigOverrides({
          ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
          CODEX_BRIDGE_PERMISSION_PROFILE: PROFILE,
          CODEX_BRIDGE_READABLE_RUNTIME_ROOT: workspace,
          CWD: workspace,
        }),
        openai_base_url: JSON.stringify(responses.baseUrl),
      },
    });
    try {
      // What `toEngineConfig` builds for a coordinator process.
      const frame = await firstModelRequest(engine, responses, {
        mode: "build",
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
        networkAccessEnabled: false,
        permissionProfile: PROFILE,
        policy: codexCoordinatorPolicy({}),
      });
      expect(offersTools(frame)).toBe(true);
      expect(offersWebSearch(frame)).toBe(false);
    } finally {
      await engine.stop();
      await responses.stop();
    }
  }, 120_000);

  test("a researching coordinator is offered search, read back as cached", async () => {
    const { codexHome, workspace } = await sandbox();
    const responses = startFakeResponses();
    const env = {
      ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
      CODEX_BRIDGE_PERMISSION_PROFILE: PROFILE,
      CODEX_BRIDGE_READABLE_RUNTIME_ROOT: workspace,
      CWD: workspace,
      [COORDINATOR_WEB_RESEARCH_ENV]: "search",
    };
    const engine = engineFor({
      codexPath: await resolveCodexBinary(),
      codexHome,
      workspace,
      configOverrides: {
        ...codexAppServerConfigOverrides(env),
        openai_base_url: JSON.stringify(responses.baseUrl),
      },
    });
    try {
      // The engine refuses the thread unless `config/read` says `cached`, so a
      // request arriving at all is the readback passing.
      const frame = await firstModelRequest(engine, responses, {
        mode: "build",
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
        networkAccessEnabled: false,
        permissionProfile: PROFILE,
        policy: codexCoordinatorPolicy(env),
      });
      expect(offersWebSearch(frame)).toBe(true);
      const read = await engine
        .getSupervisor()
        .request<{ config?: unknown }>("config/read", { cwd: workspace });
      expect(codexHostedNetworkLockGaps(read.config, "cached")).toEqual([]);
    } finally {
      await engine.stop();
      await responses.stop();
    }
  }, 120_000);

  test("a network-denied thread on an ordinary bridge is not offered web search", async () => {
    const { codexHome, workspace } = await sandbox();
    const responses = startFakeResponses();
    // No coordinator overrides: the thread's own config is the whole lock.
    const engine = engineFor({
      codexPath: await resolveCodexBinary(),
      codexHome,
      workspace,
      configOverrides: {
        ...codexAppServerConfigOverrides({}),
        openai_base_url: JSON.stringify(responses.baseUrl),
      },
    });
    try {
      const frame = await firstModelRequest(engine, responses, {
        mode: "build",
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        networkAccessEnabled: false,
        policy: {
          id: "pipeline",
          sandbox: "provider",
          approvals: "auto-approve",
          projectResources: false,
          capabilityPolicy: { deny: ["network"] },
          networkAccess: "restricted",
        },
      });
      expect(offersTools(frame)).toBe(true);
      expect(offersWebSearch(frame)).toBe(false);
    } finally {
      await engine.stop();
      await responses.stop();
    }
  }, 120_000);
});

/**
 * Every sampling `response.create` frame Codex sends, in order (prewarms are
 * skipped, see `startFakeResponses`). Codex retries a closed
 * socket, so one turn can send several; a caller reads the first after a mark.
 */
function startRecordingResponses(): {
  baseUrl: string;
  frames: Record<string, unknown>[];
  frameAfter: (index: number) => Promise<Record<string, unknown>>;
  stop: () => Promise<void>;
} {
  const frames: Record<string, unknown>[] = [];
  let waiters: Array<() => void> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && bun.upgrade(request)) {
        return undefined;
      }
      return new NativeResponse("not served", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        try {
          const frame = JSON.parse(String(message)) as Record<string, unknown>;
          if (isModelRequest(frame)) {
            frames.push(frame);
            const ready = waiters;
            waiters = [];
            for (const wake of ready) wake();
          }
        } catch {
          // Only the request frame matters.
        }
        socket.close(1011, "recorded");
      },
    },
  });
  const frameAfter = async (index: number): Promise<Record<string, unknown>> => {
    while (frames.length <= index) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return frames[index]!;
  };
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    frames,
    frameAfter,
    stop: async () => {
      await server.stop(true);
    },
  };
}

describeLive("live read-only turn network lock", () => {
  test("a read-only turn's reload takes web search away, and a build turn's gives it back", async () => {
    const { codexHome, workspace } = await sandbox();
    const responses = startRecordingResponses();
    // An ordinary bridge's own process overrides, `incremental_tools` off.
    const engine = engineFor({
      codexPath: await resolveCodexBinary(),
      codexHome,
      workspace,
      configOverrides: {
        ...codexAppServerConfigOverrides({}),
        openai_base_url: JSON.stringify(responses.baseUrl),
      },
    });
    // An ordinary worker session: no coordinator overrides, network allowed.
    const policy = {
      id: "interactive-host",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "full",
    } as const;
    const build: EngineTurnConfig = {
      mode: "build",
      cwd: workspace,
      policy,
      networkAccessEnabled: true,
    };
    // What `promptConfig` builds for a `readOnly` dispatch on that session.
    const readOnly: EngineTurnConfig = {
      ...build,
      networkAccessEnabled: false,
      sandbox: "read-only",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      policy: codexReadOnlyTurnPolicy(policy),
    };
    let commandRequests = 0;
    const loopback = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        commandRequests += 1;
        return new NativeResponse("reachable");
      },
    });
    // Use the turn's resolved read-only network flag with the real command
    // sandbox. Controls before and after rule out a broken curl/server probe.
    const shellRequest = (config: EngineTurnConfig) =>
      engine.getSupervisor().request<{ exitCode: number; stdout: string }>("command/exec", {
        command: [
          "/bin/sh",
          "-c",
          `exec /usr/bin/curl --noproxy '*' --max-time 3 --fail http://127.0.0.1:${loopback.port}/`,
        ],
        cwd: workspace,
        timeoutMs: 10_000,
        sandboxPolicy: { type: "readOnly", networkAccess: config.networkAccessEnabled },
      });
    /** One turn on the bound thread; returns its model request once the turn has ended. */
    const turnOn = async (
      handle: string,
      config: EngineTurnConfig,
    ): Promise<Record<string, unknown>> => {
      const mark = responses.frames.length;
      const turn = await engine.startTurn({
        handle,
        input: [{ type: "text", text: PROMPT }],
        config,
      });
      const frame = await withTimeout(responses.frameAfter(mark), 60_000, "the model request");
      // Stop Codex retrying the closed socket before the thread is reloaded.
      await engine.interruptTurn(handle, turn.turnId).catch(() => undefined);
      await engine.waitForTurnTerminal(handle, turn.turnId, { timeoutMs: 30_000 });
      return frame;
    };
    try {
      await engine.start();
      const thread = await engine.startThread({ config: build });
      const first = await turnOn(thread.handle, build);
      expect(offersTools(first)).toBe(true);
      expect(offersWebSearch(first)).toBe(true);
      expect(await shellRequest(build)).toMatchObject({ exitCode: 0, stdout: "reachable" });
      expect(commandRequests).toBe(1);

      // The runtime reloads the thread when a read-only turn changes the mode.
      const reviewing = await engine.reloadThread(thread.handle, { config: readOnly });
      const review = await turnOn(reviewing.handle, readOnly);
      // The resumed request carries the build turn's history (its prompt)...
      expect(JSON.stringify(review).split(PROMPT).length - 1).toBeGreaterThanOrEqual(2);
      expect(offersTools(review)).toBe(true);
      // ...but declares no web search anywhere: not this turn's tools, and not
      // the build turn's, which were never written into the history.
      expect(offersWebSearch(review)).toBe(false);
      expect((await shellRequest(readOnly)).exitCode).not.toBe(0);
      expect(commandRequests).toBe(1);

      // The rollout does not keep the thread override: the next build turn's
      // reload, which names no mode, is offered search again.
      const building = await engine.reloadThread(reviewing.handle, { config: build });
      const after = await turnOn(building.handle, build);
      expect(offersTools(after)).toBe(true);
      expect(offersWebSearch(after)).toBe(true);
      expect(await shellRequest(build)).toMatchObject({ exitCode: 0, stdout: "reachable" });
      expect(commandRequests).toBe(2);
    } finally {
      await loopback.stop(true);
      await engine.stop();
      await responses.stop();
    }
  }, 240_000);

  test("a thread whose history declares web search is refused a read-only turn", async () => {
    const { codexHome, workspace } = await sandbox();
    const responses = startRecordingResponses();
    const baseUrl = { openai_base_url: JSON.stringify(responses.baseUrl) };
    const policy = {
      id: "interactive-host",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "full",
    } as const;
    const build: EngineTurnConfig = { mode: "build", cwd: workspace, policy };
    const readOnly: EngineTurnConfig = {
      ...build,
      networkAccessEnabled: false,
      sandbox: "read-only",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      policy: codexReadOnlyTurnPolicy(policy),
    };
    // A thread written with `incremental_tools` on, as a bridge without the
    // override would: its build turn declares `web__run` into the history.
    const legacy = engineFor({
      codexPath: await resolveCodexBinary(),
      codexHome,
      workspace,
      configOverrides: baseUrl,
    });
    let threadId: string;
    try {
      await legacy.start();
      const thread = await legacy.startThread({ config: build });
      threadId = thread.id!;
      const turn = await legacy.startTurn({
        handle: thread.handle,
        input: [{ type: "text", text: PROMPT }],
        config: build,
      });
      expect(offersWebSearch(await withTimeout(responses.frameAfter(0), 60_000, "a request"))).toBe(
        true,
      );
      await legacy.interruptTurn(thread.handle, turn.turnId).catch(() => undefined);
      await legacy.waitForTurnTerminal(thread.handle, turn.turnId, { timeoutMs: 30_000 });
    } finally {
      await legacy.stop();
    }
    const rollout = legacy.rolloutPath(threadId) ?? "";
    expect(await readFile(rollout, "utf8")).toContain('"type":"additional_tools"');

    // The same thread on a bridge with the override: a build turn may resume
    // it, but a read-only one is refused before any request is made.
    const engine = engineFor({
      codexPath: await resolveCodexBinary(),
      codexHome,
      workspace,
      configOverrides: { ...codexAppServerConfigOverrides({}), ...baseUrl },
    });
    try {
      await engine.start();
      const sent = responses.frames.length;
      await expect(engine.resumeThread(threadId, { config: readOnly })).rejects.toThrow(
        "a turn with web search off was refused",
      );
      expect(responses.frames.length).toBe(sent);
      await expect(engine.forkThread(threadId, readOnly)).rejects.toThrow("web search off");
      expect((await engine.resumeThread(threadId, { config: build })).id).toBe(threadId);
    } finally {
      await engine.stop();
      await responses.stop();
    }
  }, 240_000);
});

interface LiveTurn {
  /** `webSearch` items, as app-server reports them. */
  searches: Array<Record<string, unknown>>;
  /** `mcpToolCall` items. */
  mcpCalls: Array<Record<string, unknown>>;
  /** Every agent message of the turn, joined. */
  text: string;
}

/** One real coordinator turn under the given search mode, with a copy of the local login. */
async function liveCoordinatorTurn(
  research: "search" | "search-and-mcp",
  searchMode: "cached" | "live",
  prompt: string,
): Promise<LiveTurn> {
  const { codexHome, workspace } = await sandbox();
  const source = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
  await writeFile(join(codexHome, "auth.json"), await readFile(source, "utf8"), { mode: 0o600 });
  const overrides = codexAppServerConfigOverrides({
    ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
    CODEX_BRIDGE_PERMISSION_PROFILE: PROFILE,
    CODEX_BRIDGE_READABLE_RUNTIME_ROOT: workspace,
    CWD: workspace,
    [COORDINATOR_WEB_RESEARCH_ENV]: research,
    ORKESTRATOR_COORDINATOR_RESEARCH_MCP: JSON.stringify([
      { name: "context7", url: "https://mcp.context7.com/mcp" },
    ]),
  });
  // The control replaces the coordinator's `cached` with `live`.
  overrides.web_search = JSON.stringify(searchMode);
  const args = ["app-server", "--stdio"];
  for (const [key, value] of Object.entries(overrides)) args.push("-c", `${key}=${value}`);
  const child = spawn(await resolveCodexBinary(), args, {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: codexHome, LOG_FORMAT: "json" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  child.stderr.resume();
  const turn: LiveTurn = { searches: [], mcpCalls: [], text: "" };
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const client = new JsonlRpcClient({
    generation: 1,
    stdin: child.stdin,
    stdout: child.stdout,
    onNotification: (notification) => {
      const params = (notification as { params?: Record<string, unknown> }).params ?? {};
      if (notification.method === "item/completed") {
        const item = (params.item ?? {}) as Record<string, unknown>;
        if (item.type === "webSearch") turn.searches.push(item);
        if (item.type === "mcpToolCall") turn.mcpCalls.push(item);
        if (item.type === "agentMessage") turn.text += `${String(item.text ?? "")}\n`;
      }
      if (notification.method === "turn/completed") finish();
    },
    onServerRequest: () => undefined,
  });
  try {
    await client.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    await client.notify("initialized");
    const started = await client.request<{ thread: { id: string } }>("thread/start", {
      cwd: workspace,
      approvalPolicy: "never",
    });
    await client.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    await withTimeout(finished, 240_000, "the turn to complete");
    return turn;
  } finally {
    client.close();
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

/** A search URL no index can hold: Wikipedia echoes the fresh term in the page title. */
function freshPageUrl(): { url: string; token: string } {
  const token = `orkprobe${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return { url: `https://en.wikipedia.org/w/index.php?search=${token}&fulltext=1`, token };
}

const OPEN_PROMPT = (url: string) =>
  `Use your web tool to open exactly this URL and quote the page title verbatim: ${url} . ` +
  "Do not use shell commands. If you cannot open it, say exactly what the tool returned.";

describeLiveSearchCanary("live coordinator web search modes", () => {
  test("live search opens a page no index holds (control)", async () => {
    const { url, token } = freshPageUrl();
    const turn = await liveCoordinatorTurn("search", "live", OPEN_PROMPT(url));
    expect(turn.searches.length).toBeGreaterThan(0);
    // The page title, not just the URL, carries the fresh term.
    expect(turn.text).toContain(`${token} - Search results`);
  }, 300_000);

  test("a coordinator's cached search cannot open it", async () => {
    const { url, token } = freshPageUrl();
    const turn = await liveCoordinatorTurn("search", "cached", OPEN_PROMPT(url));
    expect(turn.searches.length).toBeGreaterThan(0);
    // Require an explicit tool refusal as well as absence of page content.
    // A differently worded successful fetch must never satisfy this canary.
    expect(turn.text).toMatch(/cache miss|not accessible via this tool/i);
    expect(turn.text).not.toContain(`${token} - Search results`);
  }, 300_000);

  test("a coordinator calls its research server from inside the permission profile", async () => {
    const turn = await liveCoordinatorTurn(
      "search-and-mcp",
      "cached",
      "Use the context7 MCP server's library-resolution tool to find the Context7 library ID for React, and reply with that ID only.",
    );
    expect(
      turn.mcpCalls.some((call) => call.server === "context7" && call.status === "completed"),
    ).toBe(true);
  }, 300_000);
});
