/**
 * Questions (`request_user_input`) against the **real** pinned
 * `codex app-server` binary.
 *
 * Every Orkestrator turn runs in Codex's Default collaboration mode, which
 * refuses `request_user_input` unless the thread turns on
 * `default_mode_request_user_input` (`codexRequestUserInputConfig`). A
 * loopback Responses endpoint plays the model: its first response calls
 * `request_user_input`, the next ends the turn. It records what Codex told
 * the model, so the tests prove the call reaches the bridge as a parked
 * question in a watched session and is refused in an unattended one, without
 * calling a model or spending credits. Gated like the other live contract
 * tests because it needs the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-request-user-input.test.ts
 *
 * Add `RUN_LIVE_CODEX_QUESTION_DEADLINES=1` for a fixed 10.5-minute
 * qualification: a held question survives the bridge's five-minute deadline
 * and the TUI's two-minute auto-resolution, while an unheld control expires.
 * Both use real elapsed time and run together against separate app-servers.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { codexAppServerConfigOverrides } from "../codex-config.js";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineEvent, EngineTurnConfig } from "../engine/types.js";
import type { InteractionRequest, InteractionResolution } from "./interactions.js";
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
const CALL_ID = "call_question_probe";
// A separate opt-in keeps the quick contract check useful while making the
// elapsed-time qualification impossible to shorten accidentally.
const DEADLINES = process.env.RUN_LIVE_CODEX_QUESTION_DEADLINES === "1";
const PAUSED_WAIT_MS = 10.5 * 60_000;
const QUESTION_ARGUMENTS = JSON.stringify({
  questions: [
    {
      id: "codeword",
      header: "Codeword",
      question: "Which codeword should I use?",
      options: [
        { label: "PROBE_ALPHA", description: "The first codeword" },
        { label: "PROBE_BETA", description: "The second codeword" },
      ],
    },
  ],
});

function policy(id: NativeAgentExecutionPolicy["id"]): NativeAgentExecutionPolicy {
  return {
    id,
    sandbox: "none",
    approvals: "auto-approve",
    projectResources: true,
    networkAccess: "full",
  };
}

interface FrameInput {
  type?: string;
  call_id?: string;
  output?: unknown;
}

/**
 * A Responses WebSocket: a prewarm gets an empty response, the turn's first
 * sample calls `request_user_input`, every later one ends the turn. It keeps
 * the tool output Codex sent back for the call and the tool names offered.
 */
function startScriptedResponses() {
  let sampled = 0;
  let toolOutput: unknown;
  const offeredTools = new Set<string>();
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
          input?: FrameInput[];
          tools?: Array<{ name?: string }>;
        };
        if (frame.type !== "response.create") return;
        for (const tool of frame.tools ?? []) if (tool.name) offeredTools.add(tool.name);
        const id = `resp_${Math.random().toString(36).slice(2)}`;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        send({ type: "response.created", response: { id } });
        if (frame.generate !== false) {
          sampled += 1;
          for (const item of frame.input ?? []) {
            if (item.type === "function_call_output" && item.call_id === CALL_ID) {
              toolOutput = item.output;
            }
          }
          const item =
            sampled === 1
              ? {
                  type: "function_call",
                  id: "fc_question_probe",
                  call_id: CALL_ID,
                  name: "request_user_input",
                  arguments: QUESTION_ARGUMENTS,
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
    toolOutput: () => (toolOutput === undefined ? undefined : JSON.stringify(toolOutput)),
    sampled: () => sampled,
    offeredTools: () => [...offeredTools],
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

async function runQuestionTurn(
  id: NativeAgentExecutionPolicy["id"],
  behavior: "answer" | "hold-past-deadline" | "expire" = "answer",
) {
  const codexHome = await mkdtemp(join(tmpdir(), "ork-question-home-"));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "ork-question-ws-")));
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
    // The bridge's own process overrides, as `index.ts` launches it.
    configOverrides: {
      ...codexAppServerConfigOverrides({}),
      openai_base_url: JSON.stringify(responses.baseUrl),
    },
    supervisorOverrides: { pidFileEnabled: false },
  });
  const questions: InteractionRequest[] = [];
  const resolutions: InteractionResolution[] = [];
  let samplesBeforeAnswer: number | undefined;
  let held: string | undefined;
  let answerAccepted: boolean | undefined;
  let pendingWork: Promise<void> = Promise.resolve();
  const abort = new AbortController();
  engine.setInteractionHandlers({
    present: (request) => {
      questions.push(request);
      // The router registers the question after present returns. Promise.then
      // also keeps assertion failures on a promise awaited by this test.
      pendingWork = Promise.resolve().then(async () => {
        if (behavior === "expire") return;
        const hold = engine.holdInteraction(request.interactionId, true);
        held = hold.status;
        expect(held).toBe("applied");
        const waitMs = behavior === "hold-past-deadline" ? PAUSED_WAIT_MS : 2_000;
        const until = Date.now() + waitMs;
        while (Date.now() < until) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, Math.min(30_000, until - Date.now()));
            abort.signal.addEventListener("abort", finish, { once: true });
          });
          if (abort.signal.aborted) return;
          const parked = engine.getParkedInteractions();
          expect(parked).toHaveLength(1);
          expect(parked[0]?.interactionId).toBe(request.interactionId);
          expect(parked[0]?.hold?.heldAt).toBeNumber();
          expect(parked[0]?.expiresAt).toBeGreaterThan(Date.now());
          expect(resolutions).toEqual([]);
          expect(responses.sampled()).toBe(1);
          if (behavior === "hold-past-deadline") {
            console.log("[live-question] held question still parked; model sampled once");
          }
        }
        if (behavior === "hold-past-deadline") {
          expect(Date.now() - request.requestedAt).toBeGreaterThanOrEqual(PAUSED_WAIT_MS);
          expect(Date.now()).toBeGreaterThan(request.expiresAt!);
        }
        samplesBeforeAnswer = responses.sampled();
        answerAccepted = engine.resolveInteraction(request.interactionId, {
          action: "accept",
          answers: { codeword: ["PROBE_BETA"] },
        });
      });
      // Attach immediately: a failed observation must fail the turn wait rather
      // than becoming an unhandled rejection while Codex remains parked.
      void pendingWork.catch(failed);
      return true;
    },
    resolved: (_request, _answer, resolution) => {
      resolutions.push(resolution);
    },
  });
  let completed!: () => void;
  let failed!: (error: unknown) => void;
  const turnCompleted = new Promise<void>((resolve, reject) => {
    completed = resolve;
    failed = reject;
  });
  engine.subscribe((event: EngineEvent) => {
    if (event.kind === "turn.completed") completed();
  });
  const config: EngineTurnConfig = {
    mode: "build",
    cwd: workspace,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    policy: policy(id),
  };
  try {
    await engine.start();
    const thread = await engine.startThread({ config });
    await engine.startTurn({
      handle: thread.handle,
      input: [{ type: "text", text: "Ask me which codeword to use." }],
      config,
    });
    await withTimeout(turnCompleted, 60_000 + PAUSED_WAIT_MS, "the turn to complete");
    await pendingWork;
    return {
      questions,
      resolutions,
      samplesBeforeAnswer,
      held,
      answerAccepted,
      pending: engine.getParkedInteractions(),
      elapsedMs: Date.now() - (questions[0]?.requestedAt ?? Date.now()),
      toolOutput: responses.toolOutput(),
      offeredTools: responses.offeredTools(),
    };
  } finally {
    abort.abort();
    await engine.stop();
    await responses.stop();
    await Promise.all([
      rm(codexHome, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  }
}

describeLive("live request_user_input", () => {
  test("a watched session's question parks as a card and its answer reaches the model", async () => {
    const result = await runQuestionTurn("interactive-host");
    expect(result.questions).toHaveLength(1);
    // Codex 0.164.0 sends it with `isBlocking: false` but still waits for the
    // answer, so the bridge publishes it blocking, with a deadline the card
    // can pause.
    expect(result.questions[0]).toMatchObject({
      kind: "question",
      method: "item/tool/requestUserInput",
      isBlocking: true,
    });
    expect(JSON.stringify(result.questions[0])).toContain("Which codeword should I use?");
    // Only a wire `isBlocking: true` drops the deadline, so this proves the
    // hint was still false.
    expect(result.questions[0]?.expiresAt).toBeNumber();
    expect(result.held).toBe("applied");
    expect(result.answerAccepted).toBe(true);
    expect(result.pending).toEqual([]);
    // Neither app-server nor the bridge settled it before the answer.
    expect(result.resolutions).toEqual(["answered"]);
    expect(result.samplesBeforeAnswer).toBe(1);
    expect(result.toolOutput).toContain("PROBE_BETA");
    expect(result.toolOutput).not.toContain("unavailable in Default mode");
  }, 120_000);

  test("an unattended session keeps Codex's Default-mode refusal (control)", async () => {
    const result = await runQuestionTurn("pipeline");
    expect(result.questions).toEqual([]);
    expect(result.toolOutput).toContain("unavailable in Default mode");
  }, 120_000);
});

const describeDeadlines = LIVE && DEADLINES ? describe : describe.skip;
describeDeadlines("live request_user_input elapsed deadlines", () => {
  test(
    "a paused question survives 10.5 minutes while an unheld control expires",
    async () => {
      const [held, expired] = await Promise.all([
        runQuestionTurn("interactive-host", "hold-past-deadline"),
        runQuestionTurn("interactive-host", "expire"),
      ]);
      expect(held.questions).toHaveLength(1);
      expect(held.answerAccepted).toBe(true);
      expect(held.resolutions).toEqual(["answered"]);
      expect(held.samplesBeforeAnswer).toBe(1);
      expect(held.toolOutput).toContain("PROBE_BETA");
      expect(held.elapsedMs).toBeGreaterThanOrEqual(PAUSED_WAIT_MS);
      expect(held.pending).toEqual([]);

      expect(expired.questions).toHaveLength(1);
      const question = expired.questions[0]!;
      expect(question.expiresAt! - question.requestedAt).toBe(5 * 60_000);
      expect(expired.elapsedMs).toBeGreaterThanOrEqual(5 * 60_000);
      expect(expired.resolutions).toEqual(["timed-out"]);
      expect(JSON.parse(JSON.parse(expired.toolOutput!))).toEqual({ answers: {} });
      expect(expired.toolOutput).not.toContain("PROBE_BETA");
      expect(expired.pending).toEqual([]);
    },
    PAUSED_WAIT_MS + 120_000,
  );
});
