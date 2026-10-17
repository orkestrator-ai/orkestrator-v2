/**
 * What the **real** pinned `codex app-server` reports when a coordinator's
 * sandbox refuses a call.
 *
 * A loopback Responses endpoint plays the model: its first response is one
 * code-mode `exec` cell that tries to add a file, run `touch`, and run a
 * command that fails without the sandbox's help (the control). The second ends
 * the turn. Nothing reaches a model and no credits are spent. Gated like the
 * other live contract tests because it needs the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-refused-calls.test.ts
 *
 * Codex 0.162.1 refuses both mutations and tells the model so, but emits no
 * item for either: only the control becomes a `commandExecution`. The model's
 * call survives only in the rollout. The live coordinator suite reads the
 * rollout for that reason (`readCodexCoordinatorToolCalls` in
 * `apps/desktop/scripts/dev/coordinator-live.ts`). If this test starts failing
 * because the refusals now arrive as items, that reader can go.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * A Responses WebSocket that answers a prewarm with an empty response, the
 * turn's first request with {@link CELL}, and the next with a closing message.
 * It records the cell's output, which is what Codex told the model.
 */
function startScriptedResponses() {
  let sampled = 0;
  let cellOutput: unknown;
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
          input?: Array<{ type?: string; output?: unknown }>;
        };
        if (frame.type !== "response.create") return;
        const id = `resp_${randomSuffix()}`;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        send({ type: "response.created", response: { id } });
        if (frame.generate !== false) {
          sampled += 1;
          cellOutput ??= frame.input?.find(
            (item) => item.type === "custom_tool_call_output",
          )?.output;
          const item =
            sampled === 1
              ? {
                  type: "custom_tool_call",
                  id: "ctc_probe",
                  call_id: "call_probe",
                  name: "exec",
                  input: CELL,
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
      },
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    cellOutput: () => JSON.stringify(cellOutput ?? null),
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
    } finally {
      await engine.stop();
      await responses.stop();
    }
  }, 120_000);
});
