/**
 * Approving a Codex command never saves a rule, against the **real** pinned
 * `codex app-server` binary (todo 0160).
 *
 * Codex proposes an exec-policy amendment on a command approval, and
 * accepting it writes a rule into `CODEX_HOME/rules/` that every later Codex
 * session on the host obeys. app-server has no method to list or remove
 * those rules, so the bridge neither offers nor sends the amendment. A
 * loopback Responses endpoint plays the model: each turn runs one code-mode
 * `exec` cell with the same command, which an `untrusted` approval policy
 * sends for approval. The test watches the raw request (proving Codex did
 * propose an amendment), approves through the bridge, and checks that the
 * throwaway Codex home holds no rule and the identical command asks again in
 * the next turn. A control answers the same request with the amendment
 * itself, written straight to app-server's stdin as the bridge did before,
 * and finds the saved rule; that proves the check looks in the right place.
 * Nothing reaches a model and no credits are spent. Gated like the other live
 * contract tests because it needs the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-policy-amendment.test.ts
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { codexAppServerConfigOverrides } from "../codex-config.js";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineEvent, EngineTurnConfig } from "../engine/types.js";
import type { ApprovalRequest } from "./approvals.js";
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
const TOUCHED = "policy-amendment-probe.txt";
const CELL = `text(JSON.stringify(await tools.exec_command({ cmd: "touch ${TOUCHED}" })));`;
const APPROVAL_METHOD = "item/commandExecution/requestApproval";

const POLICY: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "ask",
  projectResources: true,
  networkAccess: "full",
};

/**
 * A Responses WebSocket: a prewarm gets an empty response, each turn's first
 * sample runs {@link CELL}, and its second ends the turn.
 */
function startScriptedResponses() {
  let sampled = 0;
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
                  input: CELL,
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
    stop: () => server.stop(true),
  };
}

interface RawApproval {
  id: unknown;
  params: Record<string, unknown>;
}

/**
 * The real spawn, with a second reader on the child's stdout that keeps every
 * approval request. It only observes: the supervisor's own reader still
 * answers each request. `child` is kept for the control's direct answer.
 */
function observingSpawn(probe: {
  seen: RawApproval[];
  child?: ReturnType<typeof spawn>;
}): typeof spawn {
  return ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    probe.child = child;
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
        try {
          const message = JSON.parse(line) as { id?: unknown; method?: string; params?: unknown };
          if (message.method === APPROVAL_METHOD && message.params) {
            probe.seen.push({
              id: message.id,
              params: message.params as Record<string, unknown>,
            });
          }
        } catch {
          // Not a JSON-RPC line; the supervisor's reader reports those.
        }
      }
    });
    return child;
  }) as typeof spawn;
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

async function savedRules(codexHome: string): Promise<string[]> {
  const rules = join(codexHome, "rules");
  return existsSync(rules) ? await readdir(rules, { recursive: true }) : [];
}

/**
 * Runs two turns of the same command, answering each approval with `answer`.
 * `bridge` approves through the bridge, as the card's Approve does; `raw`
 * writes app-server's own amendment straight to its stdin, which is what the
 * bridge sent for "Approve with command policy" before todo 0160.
 */
async function runProbe(answer: "bridge" | "raw-amendment") {
  const codexHome = await mkdtemp(join(tmpdir(), "ork-amendment-home-"));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "ork-amendment-ws-")));
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  // Never a real key: the only server it can reach is the loopback fake.
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
    { mode: 0o600 },
  );
  const responses = startScriptedResponses();
  const probe: { seen: RawApproval[]; child?: ReturnType<typeof spawn> } = { seen: [] };
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
    supervisorOverrides: { pidFileEnabled: false, spawnProcess: observingSpawn(probe) },
  });
  const presented: ApprovalRequest[] = [];
  const rulesAfterTurn: string[][] = [];
  engine.setApprovalHandlers({
    present: (request) => {
      presented.push(request);
      setTimeout(() => {
        if (answer === "bridge") {
          // Approve alone: the card's only approve button.
          engine.resolveApproval(request.approvalId, "approve");
          return;
        }
        const raw = probe.seen.at(-1)!;
        probe.child!.stdin!.write(
          `${JSON.stringify({
            id: raw.id,
            result: {
              decision: {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: raw.params.proposedExecpolicyAmendment,
                },
              },
            },
          })}\n`,
        );
      }, 50);
      return true;
    },
    resolved: () => undefined,
  });
  let completed: (() => void) | undefined;
  engine.subscribe((event: EngineEvent) => {
    if (event.kind === "turn.completed") completed?.();
  });
  const config: EngineTurnConfig = {
    mode: "build",
    cwd: workspace,
    sandbox: "read-only",
    approvalPolicy: "untrusted",
    policy: POLICY,
  };
  try {
    await engine.start();
    const thread = await engine.startThread({ config });
    for (let turn = 0; turn < 2; turn += 1) {
      const turnCompleted = new Promise<void>((resolve) => {
        completed = resolve;
      });
      await engine.startTurn({
        handle: thread.handle,
        input: [{ type: "text", text: "Run the probe." }],
        config,
      });
      await withTimeout(turnCompleted, 60_000, "the turn to complete");
      rulesAfterTurn.push(await savedRules(codexHome));
    }
    return { raw: probe.seen.map((entry) => entry.params), presented, rulesAfterTurn };
  } finally {
    await engine.stop();
    await responses.stop();
  }
}

describeLive("live policy amendment", () => {
  test("approving a command that proposes an exec-policy amendment saves no rule", async () => {
    const result = await runProbe("bridge");
    // Codex proposed a rule for the command...
    expect(result.raw[0]?.proposedExecpolicyAmendment).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    // ...the card was not offered it, and approving saved nothing.
    expect(result.presented[0]?.command).toContain(TOUCHED);
    expect(result.presented[0]).not.toHaveProperty("amendments");
    // The identical command asks again: nothing was remembered.
    expect(result.raw).toHaveLength(2);
    expect(result.presented).toHaveLength(2);
    expect(result.presented[1]?.command).toBe(result.presented[0]?.command);
    expect(result.rulesAfterTurn).toEqual([[], []]);
  }, 180_000);

  test("accepting the amendment itself saves a rule and stops the next ask (control)", async () => {
    const result = await runProbe("raw-amendment");
    expect(result.raw[0]?.proposedExecpolicyAmendment).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    expect(result.rulesAfterTurn[0]).toEqual(["default.rules"]);
    // The saved rule answers the identical command, so it never asks again.
    expect(result.raw).toHaveLength(1);
    expect(result.presented).toHaveLength(1);
  }, 180_000);
});
