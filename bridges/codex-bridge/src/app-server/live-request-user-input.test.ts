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
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { codexAppServerConfigOverrides } from "../codex-config.js";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineEvent, EngineTurnConfig } from "../engine/types.js";
import type { InteractionRequest } from "./interactions.js";
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
const ANSWER_DELAY_MS = 2_000;
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

async function runQuestionTurn(id: NativeAgentExecutionPolicy["id"]) {
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
  let samplesBeforeAnswer: number | undefined;
  let held: string | undefined;
  engine.setInteractionHandlers({
    present: (request) => {
      questions.push(request);
      // Pause it and answer a while later, as a person at the card would. The
      // model must not be sampled again until the answer is in.
      setTimeout(() => {
        samplesBeforeAnswer = responses.sampled();
        held = engine.holdInteraction(request.interactionId, true).status;
        engine.resolveInteraction(request.interactionId, {
          action: "accept",
          answers: { codeword: ["PROBE_BETA"] },
        });
      }, ANSWER_DELAY_MS);
      return true;
    },
    resolved: () => undefined,
  });
  let completed!: () => void;
  const turnCompleted = new Promise<void>((resolve) => {
    completed = resolve;
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
    await withTimeout(turnCompleted, 60_000, "the turn to complete");
    return {
      questions,
      samplesBeforeAnswer,
      held,
      toolOutput: responses.toolOutput(),
      offeredTools: responses.offeredTools(),
    };
  } finally {
    await engine.stop();
    await responses.stop();
  }
}

describeLive("live request_user_input", () => {
  test("a watched session's question parks as a card and its answer reaches the model", async () => {
    const result = await runQuestionTurn("interactive-host");
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({
      kind: "question",
      method: "item/tool/requestUserInput",
      isBlocking: false,
    });
    expect(JSON.stringify(result.questions[0])).toContain("Which codeword should I use?");
    // Codex 0.164.0 marks it non-blocking but still waits for the answer, and
    // the question carries a deadline the card can pause.
    expect(result.questions[0]?.expiresAt).toBeNumber();
    expect(result.held).toBe("applied");
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
