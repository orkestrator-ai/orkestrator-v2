/**
 * What the **real** pinned `codex app-server` reports when a sandbox refuses a
 * call, and how the bridge still shows it.
 *
 * A loopback Responses endpoint plays the model: its first response is one
 * code-mode `exec` cell that tries to add a file, run `touch`, and run a
 * command that fails without the sandbox's help (the control). The next two
 * are cells that each attempt one of those mutations, and the last ends the
 * turn. Nothing reaches a model and no credits are spent. Gated like the
 * other live contract tests because it needs the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-refused-calls.test.ts
 *
 * Codex 0.164.0 refuses both mutations and tells the model so, but emits no
 * item for either: only the control becomes a `commandExecution`. The model's
 * call survives only in the rollout, with the refusal in the cell's output.
 * The bridge reads it there (`RefusedCellTail`) and shows the cell as a failed
 * `exec` row; the second test runs that path through the runtime with the
 * real file watch. If the refusals ever arrive as items, the tail can go.
 *
 * The third pins the exception: with `code_mode_interrupt` on (the 0.164.0
 * default), an interrupt stops a running cell and records "aborted by user
 * after …" as its output, also with no item. That is not a refusal, so the
 * bridge shows no row for it.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRuntime } from "../app-server-runtime.js";
import type { RuntimeSseEvent } from "../app-server-runtime-base.js";
import { codexAppServerConfigOverrides, codexCoordinatorPolicy } from "../codex-config.js";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineEvent, EngineItem } from "../engine/types.js";
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

const CLIENT_INFO = { name: "orkestrator", title: "Orkestrator", version: "2.4.9" };
const PROFILE = "coordinator-refused-calls";
const CREATED = "coordinator-live-created.txt";
const TOUCHED = "coordinator-live-shell.txt";

/** The model's one cell: two calls the sandbox refuses, then the control. */
const CELL = [
  `const patch = "*** Begin Patch\\n*** Add File: ${CREATED}\\n+probe\\n*** End Patch\\n";`,
  'try { text(JSON.stringify(await tools.apply_patch(patch))); } catch (error) { text("create: " + String(error)); }',
  `text(JSON.stringify(await tools.exec_command({ cmd: "touch ${TOUCHED}" })));`,
  'text(JSON.stringify(await tools.exec_command({ cmd: "false" })));',
].join("\n");

/**
 * Cells that each attempt one mutation, as a model working step by step
 * writes them: an uncaught rejected patch, then a command whose result is
 * printed.
 */
const SINGLE_CELLS = [
  `await tools.apply_patch("*** Begin Patch\\n*** Add File: ${CREATED}\\n+probe\\n*** End Patch\\n");`,
  `text(JSON.stringify(await tools.exec_command({ cmd: "touch ${TOUCHED}" })));`,
];

/**
 * A Responses WebSocket that answers a prewarm with an empty response, the
 * turn's first request with {@link CELL}, the next ones with
 * {@link SINGLE_CELLS}, and the last with a closing message. It records each
 * cell's output, which is what Codex told the model.
 */
function startScriptedResponses(cells: readonly string[] = [CELL, ...SINGLE_CELLS]) {
  let sampled = 0;
  const cellOutputs = new Map<string, unknown>();
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
        const frame = JSON.parse(String(message)) as {
          type?: string;
          generate?: boolean;
          input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
        };
        if (frame.type !== "response.create") return;
        respond(socket, frame);
      },
    },
  });

  function respond(
    socket: { send: (data: string) => void },
    frame: {
      type?: string;
      generate?: boolean;
      input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
    },
  ): void {
    const id = `resp_${randomSuffix()}`;
    const send = (event: unknown) => socket.send(JSON.stringify(event));
    send({ type: "response.created", response: { id } });
    if (frame.generate !== false) {
      sampled += 1;
      for (const item of frame.input ?? []) {
        if (item.type === "custom_tool_call_output" && item.call_id) {
          cellOutputs.set(item.call_id, item.output);
        }
      }
      const cell = cells[sampled - 1];
      const item =
        cell !== undefined
          ? {
              type: "custom_tool_call",
              id: `ctc_probe_${sampled}`,
              call_id: `call_probe_${sampled}`,
              name: "exec",
              input: cell,
              status: "completed",
            }
          : {
              type: "message",
              id: "msg_probe",
              role: "assistant",
              content: [{ type: "output_text", text: "done", annotations: [] }],
              status: "completed",
            };
      send({ type: "response.output_item.done", output_index: 0, item });
    }
    send({
      type: "response.completed",
      response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    });
  }

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    cellOutput: (index = 1) => JSON.stringify(cellOutputs.get(`call_probe_${index}`) ?? null),
    sampled: () => sampled,
    stop: () => server.stop(true),
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2);
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

async function rolloutText(codexHome: string): Promise<string> {
  const sessions = join(codexHome, "sessions");
  const files = (await readdir(sessions, { recursive: true })).filter((file) =>
    /rollout-.*\.jsonl$/.test(file),
  );
  return (await Promise.all(files.map((file) => readFile(join(sessions, file), "utf8")))).join(
    "\n",
  );
}

describeLive("live refused calls", () => {
  test("a refused patch and a refused command reach the model and the rollout, but no item", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "ork-refused-home-"));
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "ork-refused-ws-")));
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    // Never a real key: the only server it can reach is the loopback fake.
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
      { mode: 0o600 },
    );
    const responses = startScriptedResponses();
    const engine = new AppServerEngine({
      codexPath: await resolveCodexBinary(),
      cwd: workspace,
      codexHome,
      clientInfo: CLIENT_INFO,
      configOverrides: {
        ...codexAppServerConfigOverrides({
          ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
          CODEX_BRIDGE_PERMISSION_PROFILE: PROFILE,
          CODEX_BRIDGE_READABLE_RUNTIME_ROOT: workspace,
          CWD: workspace,
        }),
        openai_base_url: JSON.stringify(responses.baseUrl),
      },
      supervisorOverrides: { pidFileEnabled: false },
    });
    const items: EngineItem[] = [];
    let completed!: () => void;
    const turnCompleted = new Promise<void>((resolve) => {
      completed = resolve;
    });
    engine.subscribe((event: EngineEvent) => {
      if (event.kind === "item.completed") items.push(event.item);
      if (event.kind === "turn.completed") completed();
    });
    try {
      // What `toEngineConfig` builds for a coordinator process.
      const config = {
        mode: "build" as const,
        cwd: workspace,
        approvalPolicy: "never" as const,
        sandbox: "read-only" as const,
        networkAccessEnabled: false,
        permissionProfile: PROFILE,
        policy: codexCoordinatorPolicy({}),
      };
      await engine.start();
      const thread = await engine.startThread({ config });
      await engine.startTurn({
        handle: thread.handle,
        input: [{ type: "text", text: "Run the probe." }],
        config,
      });
      await withTimeout(turnCompleted, 60_000, "the turn to complete");

      // Codex refused both and said so to the model.
      const told = responses.cellOutput();
      expect(told).toContain("patch rejected");
      expect(told).toContain("Operation not permitted");

      // The control became an item, so the item stream was being read...
      const commands = items.filter((item) => item.type === "command_execution");
      expect(commands.map((item) => item.command)).toEqual([expect.stringContaining("false")]);
      // ...but neither refusal did.
      expect(items.some((item) => item.type === "file_change")).toBe(false);
      expect(JSON.stringify(items)).not.toContain(TOUCHED);

      // The rollout keeps the model's call, with both targets in its source.
      const rollout = await rolloutText(codexHome);
      const cell = rollout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> })
        .find(
          (record) =>
            record.type === "response_item" &&
            record.payload?.type === "custom_tool_call" &&
            record.payload.name === "exec",
        );
      expect(String(cell?.payload?.input)).toContain(CREATED);
      expect(String(cell?.payload?.input)).toContain(TOUCHED);
      // A cell attempting one mutation gets that call's refusal back, which is
      // the execution evidence the live suite's reader requires.
      expect(responses.cellOutput(2)).toContain(
        "patch rejected: writing is blocked by read-only sandbox",
      );
      expect(responses.cellOutput(3)).toContain(`${TOUCHED}: Operation not permitted`);
      expect(rollout).toContain("call_probe_2");
      expect(rollout).toContain("call_probe_3");
    } finally {
      await engine.stop();
      await responses.stop();
    }
  }, 120_000);

  test("the bridge recovers refused cells with immediate model responses and the default watcher", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "ork-refused-runtime-home-"));
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "ork-refused-runtime-ws-")));
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
      { mode: 0o600 },
    );
    // History lookups resolve through CODEX_HOME; keep them off the real one.
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const responses = startScriptedResponses();
    const engine = new AppServerEngine({
      codexPath: await resolveCodexBinary(),
      cwd: workspace,
      codexHome,
      clientInfo: CLIENT_INFO,
      // The bridge's own process overrides, as `index.ts` launches it.
      configOverrides: {
        ...codexAppServerConfigOverrides({}),
        openai_base_url: JSON.stringify(responses.baseUrl),
      },
      supervisorOverrides: { pidFileEnabled: false },
    });
    let idle!: () => void;
    const turnIdle = new Promise<void>((resolve) => {
      idle = resolve;
    });
    const runtime = new AppServerRuntime({
      engine,
      codexHome,
      cwd: workspace,
      emit: (event: RuntimeSseEvent) => {
        if (event.type === "session.idle") idle();
      },
      loadCachedModels: async () => ({ models: [], source: "fallback" }),
      sweepIntervalMs: 0,
    });
    try {
      await runtime.start();
      const { sessionId } = runtime.createSession({ mode: "build" });
      // A Multi Review reviewer's turn: read-only whatever the session allows.
      await runtime.prompt(sessionId, {
        prompt: "Run the probe.",
        requestId: "refused-cells-probe",
        attachments: [],
        readOnly: true,
      });
      await withTimeout(turnIdle, 90_000, "the turn to finish");
      await runtime.drainPendingWork();

      const parts = (await runtime.getMessages(sessionId))!
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.parts);
      const cells = parts.filter((part) => part.toolName === "exec");
      // Each row lands where its cell ran: before the turn's closing message.
      expect(parts.map((part) => part.toolUseId ?? part.type).slice(-4)).toEqual([
        "call_probe_1",
        "call_probe_2",
        "call_probe_3",
        "text",
      ]);
      expect(cells.map((part) => [part.toolUseId, part.toolState])).toEqual([
        ["call_probe_1", "failure"],
        ["call_probe_2", "failure"],
        ["call_probe_3", "failure"],
      ]);
      expect(cells[0]?.toolError).toContain("Operation not permitted");
      expect(cells[1]?.toolError).toContain("patch rejected");
      expect(cells[2]?.toolError).toContain(`${TOUCHED}: Operation not permitted`);
      // The control still has its own row; the cell holding it is shown for
      // the refusals beside it.
      expect(
        parts.some((part) => part.toolName === "bash" && part.content?.includes("false")),
      ).toBe(true);
    } finally {
      await runtime.stop();
      await engine.stop();
      await responses.stop();
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  }, 120_000);
  test("a cell an interrupt stops is not shown as a refused cell", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "ork-interrupted-cell-home-"));
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "ork-interrupted-cell-ws-")));
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
      { mode: 0o600 },
    );
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    // A cell that calls nothing and never ends: only an interrupt stops it,
    // and no item ever starts while it runs.
    const responses = startScriptedResponses(['text("probe"); while (true) {}']);
    const engine = new AppServerEngine({
      codexPath: await resolveCodexBinary(),
      cwd: workspace,
      codexHome,
      clientInfo: CLIENT_INFO,
      // The bridge's own process overrides, as `index.ts` launches it.
      configOverrides: {
        ...codexAppServerConfigOverrides({}),
        openai_base_url: JSON.stringify(responses.baseUrl),
      },
      supervisorOverrides: { pidFileEnabled: false },
    });
    let started!: (turn: { threadId: string; turnId: string }) => void;
    const turnStarted = new Promise<{ threadId: string; turnId: string }>((resolve) => {
      started = resolve;
    });
    engine.subscribe((event: EngineEvent) => {
      if (event.kind === "turn.started" && event.threadId) {
        started({ threadId: event.threadId, turnId: event.turnId });
      }
    });
    let idle!: () => void;
    const turnIdle = new Promise<void>((resolve) => {
      idle = resolve;
    });
    const runtime = new AppServerRuntime({
      engine,
      codexHome,
      cwd: workspace,
      emit: (event: RuntimeSseEvent) => {
        if (event.type === "session.idle") idle();
      },
      loadCachedModels: async () => ({ models: [], source: "fallback" }),
      sweepIntervalMs: 0,
    });
    try {
      await runtime.start();
      const { sessionId } = runtime.createSession({ mode: "build" });
      await runtime.prompt(sessionId, {
        prompt: "Run the probe.",
        requestId: "interrupted-cell-probe",
        attachments: [],
      });
      const turn = await withTimeout(turnStarted, 30_000, "the turn to start");
      const deadline = Date.now() + 30_000;
      while (responses.sampled() < 1 && Date.now() < deadline) await Bun.sleep(50);
      // Let the cell run, and the tail read it, before the stop.
      await Bun.sleep(1_000);
      // Straight to the engine, as another client or a closing tab would: the
      // runtime's own stop closes the tail first and would prove nothing.
      await engine.interruptTurn(turn.threadId, turn.turnId);
      await withTimeout(turnIdle, 60_000, "the turn to finish");
      await runtime.drainPendingWork();

      // Codex recorded the stop as the cell's output...
      const rollout = await rolloutText(codexHome);
      expect(rollout).toMatch(/"output":"aborted by user after [\d.]+s"/);
      // ...and the bridge shows no row for it, live or reloaded.
      const parts = (await runtime.getMessages(sessionId))!
        .filter((message) => message.role === "assistant")
        .flatMap((message) => message.parts);
      expect(parts.filter((part) => part.toolName === "exec")).toEqual([]);
    } finally {
      await runtime.stop();
      await engine.stop();
      await responses.stop();
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  }, 120_000);
});
