/**
 * A read-only turn without Codex's command sandbox reads through the bridge's
 * exec-policy rules and nothing else, against the **real** pinned
 * `codex app-server` binary.
 *
 * Such a turn runs `danger-full-access` under `untrusted` and the bridge
 * declines every approval it asks for (`codex-read-only-sandbox.ts`). The
 * pinned Codex asks under `untrusted` for every command no exec-policy rule
 * allows, reads included, so the bridge writes
 * `CODEX_HOME/rules/orkestrator-read-only.rules` before the thread starts
 * (`codex-read-only-exec-rules.ts`). A loopback Responses endpoint plays the
 * model: the turn runs one code-mode `exec` cell with a shell command, and the
 * endpoint keeps every request Codex sends it, so a read's output reaching the
 * next request proves the command ran. Every approval is refused through the
 * engine's `refuse` handler, as the runtime does. Nothing reaches a model and
 * no credits are spent. Gated like the other live contract tests because it
 * needs the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-read-only-exec-rules.test.ts
 *
 * The container itself (bubblewrap refused, the marker files) is not part of
 * this check: the exec-policy decision does not depend on the platform outside
 * Windows. A full reviewer turn in a container is to-do 7872.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { codexAppServerConfigOverrides, codexReadOnlyTurnPolicy } from "../codex-config.js";
import { ensureCodexReadOnlyExecRules } from "../codex-read-only-exec-rules.js";
import {
  CODEX_READ_ONLY_APPROVAL_REFUSAL,
  CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER,
} from "../codex-read-only-sandbox.js";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineEvent, EngineTurnConfig } from "../engine/types.js";
import type { ApprovalRefusalTarget } from "./server-request-router.js";
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
const SENTINEL_FILE = "sentinel.txt";
/** Appears in a request to the model only if a read printed the file. */
const SENTINEL_CONTENT = "orkestrator-read-probe-4f2a9c";

const CONTAINER_POLICY: NativeAgentExecutionPolicy = {
  id: "interactive-container",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess: "full",
};

/**
 * A Responses WebSocket: a prewarm gets an empty response, the turn's first
 * sample runs `cell`, and its second ends the turn. Keeps every frame.
 */
function startScriptedResponses(cell: string) {
  let sampled = 0;
  const frames: string[] = [];
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
        frames.push(String(message));
        const frame = JSON.parse(String(message)) as { type?: string; generate?: boolean };
        if (frame.type !== "response.create") return;
        const id = `resp_${Math.random().toString(36).slice(2)}`;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        send({ type: "response.created", response: { id } });
        if (frame.generate !== false) {
          sampled += 1;
          const item =
            sampled % 2 === 1
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
                  id: `msg_probe_${sampled}`,
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
    frames,
    stop: () => server.stop(true),
  };
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

/**
 * Runs one sandbox-off read-only turn whose cell runs `command` in a
 * throwaway workspace holding the sentinel file. Returns what Codex asked,
 * whether the read's output reached the model, and the sentinel afterwards.
 */
async function runReadOnlyTurn(command: string, options: { rules: boolean }) {
  const codexHome = await mkdtemp(join(tmpdir(), "ork-read-rules-home-"));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "ork-read-rules-ws-")));
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(join(workspace, SENTINEL_FILE), `${SENTINEL_CONTENT}\n`, "utf8");
  // Never a real key: the only server it can reach is the loopback fake.
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
    { mode: 0o600 },
  );
  if (options.rules) await ensureCodexReadOnlyExecRules(codexHome);
  const cell = `text(JSON.stringify(await tools.exec_command({ cmd: ${JSON.stringify(command)} })));`;
  const responses = startScriptedResponses(cell);
  const engine = new AppServerEngine({
    codexPath: await resolveCodexBinary(),
    cwd: workspace,
    codexHome,
    clientInfo: CLIENT_INFO,
    configOverrides: {
      ...codexAppServerConfigOverrides({}),
      openai_base_url: JSON.stringify(responses.baseUrl),
    },
    supervisorOverrides: { pidFileEnabled: false },
  });
  const refused: ApprovalRefusalTarget[] = [];
  let presented = 0;
  engine.setApprovalHandlers({
    present: () => {
      presented += 1;
      return false;
    },
    resolved: () => undefined,
    // What `approvalRefusal` answers for a sandbox-off read-only thread.
    refuse: (target) => {
      refused.push(target);
      return CODEX_READ_ONLY_APPROVAL_REFUSAL;
    },
  });
  let completed: (() => void) | undefined;
  engine.subscribe((event: EngineEvent) => {
    if (event.kind === "turn.completed") completed?.();
  });
  // What `app-server-runtime-prompt.ts` sends for a sandbox-off read-only turn.
  const config: EngineTurnConfig = {
    mode: "build",
    cwd: workspace,
    sandbox: "danger-full-access",
    networkAccessEnabled: false,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    policy: codexReadOnlyTurnPolicy(CONTAINER_POLICY),
    readOnlyCommandSandboxOff: CODEX_READ_ONLY_SANDBOX_OFF_IN_CONTAINER,
  };
  try {
    await engine.start();
    const thread = (await engine.startThread({ config })).handle;
    const turnCompleted = new Promise<void>((resolve) => {
      completed = resolve;
    });
    await engine.startTurn({
      handle: thread,
      input: [{ type: "text", text: "Run the probe." }],
      config,
    });
    await withTimeout(turnCompleted, 60_000, "the turn to complete");
    // The cell's own text never holds the content, only the command.
    const readReachedModel = responses.frames.some((frame) => frame.includes(SENTINEL_CONTENT));
    return {
      refused,
      presented,
      readReachedModel,
      sentinel: await readFile(join(workspace, SENTINEL_FILE), "utf8"),
    };
  } finally {
    await engine.stop();
    await responses.stop();
    await rm(codexHome, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

describeLive("live read-only exec-policy rules", () => {
  test("with the bridge's rules a chained read runs without asking", async () => {
    const result = await runReadOnlyTurn(
      `cat ${SENTINEL_FILE} | head -n 1 && grep -c probe ${SENTINEL_FILE}`,
      { rules: true },
    );
    expect(result.refused).toEqual([]);
    expect(result.presented).toBe(0);
    expect(result.readReachedModel).toBe(true);
  }, 180_000);

  test("without the rules the same read asks and is declined (control)", async () => {
    const result = await runReadOnlyTurn(`cat ${SENTINEL_FILE} | head -n 1`, { rules: false });
    expect(result.refused.length).toBeGreaterThan(0);
    expect(result.presented).toBe(0);
    expect(result.readReachedModel).toBe(false);
  }, 180_000);

  test("with the rules a redirection still asks, is declined and changes nothing", async () => {
    const result = await runReadOnlyTurn(`echo changed > ${SENTINEL_FILE}`, { rules: true });
    expect(result.refused.length).toBeGreaterThan(0);
    expect(result.presented).toBe(0);
    expect(result.sentinel).toBe(`${SENTINEL_CONTENT}\n`);
  }, 180_000);

  test("with the rules a reader the rules leave out still asks and is declined", async () => {
    const result = await runReadOnlyTurn(`sed -n 1p ${SENTINEL_FILE}`, { rules: true });
    expect(result.refused.length).toBeGreaterThan(0);
    expect(result.readReachedModel).toBe(false);
  }, 180_000);
});
