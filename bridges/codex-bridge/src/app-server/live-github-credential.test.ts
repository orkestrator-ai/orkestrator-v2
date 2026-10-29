/**
 * Whether the **real** pinned `codex app-server` keeps the GitHub credential
 * out of one thread's commands while another thread of the same process
 * still has it (graphs item 209).
 *
 * The bridge runs one app-server per environment, so the credential cannot
 * leave the process environment for one session. It withholds it per thread
 * instead, through `shell_environment_policy` in the thread configuration
 * (`github-credential-config.ts`). This test starts one app-server whose
 * environment carries fake GitHub tokens and inherited Git configuration
 * entries, opens a thread with a graph node's policy (denies `github.write`)
 * and a thread without it, and has a loopback Responses endpoint play the
 * model: each turn runs one code-mode cell that prints the command
 * environment. Nothing reaches a model and no credits are spent. Gated like
 * the other live contract tests because it needs the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-github-credential.test.ts
 *
 * Verified against 0.164.0: the withheld thread's command sees no token, no
 * credential file path, `GH_CONFIG_DIR` at the empty directory and the
 * helper resets numbered from 0, before and after the thread is resumed from
 * its rollout, while the control thread sees the tokens.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { codexAppServerConfigOverrides } from "../codex-config.js";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineEvent, EngineTurnConfig } from "../engine/types.js";
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

/** Fake values only: nothing here can authenticate anywhere. */
const FAKE_CREDENTIALS = {
  GH_TOKEN: "gho_orkestrator_live_probe_gh",
  GITHUB_TOKEN: "ghs_orkestrator_live_probe_github",
  GITHUB_PERSONAL_ACCESS_TOKEN: "github_pat_orkestrator_live_probe",
  ORKESTRATOR_GITHUB_CREDENTIAL_FILE: "/tmp/orkestrator-live-probe/github-token",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "orkestrator-live-probe-helper",
} as const;

/** Prints the command environment, one `NAME=value` per line. */
const CELL = 'text(JSON.stringify(await tools.exec_command({ cmd: "env" })));';

/**
 * A Responses WebSocket that answers each turn's first request with
 * {@link CELL} and the follow-up (which carries the cell's output) with a
 * closing message, recording what Codex told the model per turn.
 */
function startScriptedResponses() {
  const outputs: string[] = [];
  let calls = 0;
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
        const id = `resp_${Math.random().toString(36).slice(2)}`;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        send({ type: "response.created", response: { id } });
        if (frame.generate !== false) {
          const answered = (frame.input ?? []).filter(
            (item) =>
              item.type === "custom_tool_call_output" && item.call_id === `call_env_${calls}`,
          );
          let item: unknown;
          if (answered.length > 0) {
            outputs.push(JSON.stringify(answered[0]!.output));
            item = {
              type: "message",
              id: `msg_env_${calls}`,
              role: "assistant",
              content: [{ type: "output_text", text: "done", annotations: [] }],
              status: "completed",
            };
          } else {
            calls += 1;
            item = {
              type: "custom_tool_call",
              id: `ctc_env_${calls}`,
              call_id: `call_env_${calls}`,
              name: "exec",
              input: CELL,
              status: "completed",
            };
          }
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
    outputs,
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

function graphPolicy(capabilityPolicy: NativeAgentExecutionPolicy["capabilityPolicy"]) {
  return {
    id: "pipeline",
    sandbox: "none",
    approvals: "auto-approve",
    projectResources: true,
    networkAccess: "full",
    capabilityPolicy,
  } satisfies NativeAgentExecutionPolicy;
}

describeLive("live GitHub credential withholding", () => {
  test("one thread's commands lose the credential while a sibling thread keeps it", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "ork-gh-withheld-home-"));
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "ork-gh-withheld-ws-")));
    const ghConfigDir = await mkdtemp(join(tmpdir(), "ork-gh-withheld-config-"));
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    // Never a real key: the only server it can reach is the loopback fake.
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
      { mode: 0o600 },
    );
    // app-server inherits the bridge's environment at spawn.
    const previous = Object.fromEntries(
      Object.keys(FAKE_CREDENTIALS).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, FAKE_CREDENTIALS);
    const responses = startScriptedResponses();
    const engine = new AppServerEngine({
      codexPath: await resolveCodexBinary(),
      cwd: workspace,
      codexHome,
      clientInfo: CLIENT_INFO,
      ghConfigDir: async () => ghConfigDir,
      configOverrides: {
        ...codexAppServerConfigOverrides({}),
        openai_base_url: JSON.stringify(responses.baseUrl),
      },
      supervisorOverrides: { pidFileEnabled: false },
    });
    let completed: (() => void) | undefined;
    engine.subscribe((event: EngineEvent) => {
      if (event.kind === "turn.completed") completed?.();
    });
    const runTurn = async (config: EngineTurnConfig, reloadHandle?: string) => {
      const done = new Promise<void>((resolve) => {
        completed = resolve;
      });
      // A reload unsubscribes first, so the resume rebuilds the thread from its
      // rollout and applies the thread configuration again.
      const thread = reloadHandle
        ? await engine.reloadThread(reloadHandle, { config })
        : await engine.startThread({ config });
      await engine.startTurn({
        handle: thread.handle,
        input: [{ type: "text", text: "Print the environment." }],
        config,
      });
      await withTimeout(done, 60_000, "the turn to complete");
      return thread.handle;
    };
    const base = {
      mode: "build" as const,
      cwd: workspace,
      approvalPolicy: "never" as const,
      sandbox: "workspace-write" as const,
    };
    try {
      await engine.start();
      const graphConfig = {
        ...base,
        policy: graphPolicy({ deny: ["file.write"], extendedDeny: ["github.write"] }),
      };
      const handle = await runTurn(graphConfig);
      await runTurn(graphConfig, handle);
      await runTurn({ ...base, policy: graphPolicy({ deny: [] }) });
      expect(responses.outputs).toHaveLength(3);
      const [withheld, resumed, control] = responses.outputs as [string, string, string];

      for (const output of [withheld, resumed]) {
        for (const value of [
          FAKE_CREDENTIALS.GH_TOKEN,
          FAKE_CREDENTIALS.GITHUB_TOKEN,
          FAKE_CREDENTIALS.GITHUB_PERSONAL_ACCESS_TOKEN,
          FAKE_CREDENTIALS.ORKESTRATOR_GITHUB_CREDENTIAL_FILE,
          FAKE_CREDENTIALS.GIT_CONFIG_VALUE_0,
        ]) {
          expect(output).not.toContain(value);
        }
        expect(output).toContain(`GH_CONFIG_DIR=${ghConfigDir}`);
        expect(output).toContain("GIT_CONFIG_COUNT=3");
        expect(output).toContain("GIT_CONFIG_KEY_0=credential.helper");
        expect(output).toContain("GIT_CONFIG_KEY_1=credential.https://github.com.helper");
        expect(output).toContain("GIT_CONFIG_KEY_2=credential.https://gist.github.com.helper");
      }

      // The same process, without the policy: the credential is there, so the
      // first thread's absence is the thread configuration's doing.
      expect(control).toContain(FAKE_CREDENTIALS.GH_TOKEN);
      expect(control).toContain(FAKE_CREDENTIALS.GITHUB_TOKEN);
      expect(control).not.toContain(`GH_CONFIG_DIR=${ghConfigDir}`);
    } finally {
      await engine.stop();
      await responses.stop();
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 120_000);
});
