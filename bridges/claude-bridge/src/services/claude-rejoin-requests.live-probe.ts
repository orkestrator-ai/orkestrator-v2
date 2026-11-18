// Uses the pinned CLI and disposable loopback fixtures to exercise permission
// redelivery, inventory during a real MCP elicitation, and bridge follow-ups
// on the same idle and background-busy process. The stdout tap simulates a
// lost permission frame and holds a real background hook until the follow-up
// is written. No credentials or external model are needed.
import {
  query,
  type Options,
  type SDKUserMessage,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ClaudeControlRequests } from "./claude-control-requests.js";
import { reinitializeLiveClaude } from "./live-claude-control.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { setClaudeHomeForTesting } from "./claude-home.js";
import { claudeExecutableOptions, createSession } from "./session-manager-core.js";
import { answerQuestion, getPendingQuestions } from "./session-manager-interactions.js";

import { sendPrompt } from "./session-manager-prompt.js";
import { claudeRuntimeOwesWork } from "./session-manager-runtime.js";

export const REJOIN_RESULT_SENTINEL = "__CLAUDE_REJOIN_REQUESTS_RESULT__";
const DENIAL = "Fixture: denied after the rejoin.";
const WAIT_MS = 30_000;

async function runMcpFixture(): Promise<void> {
  const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: "ask", description: "Ask for a team", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => {
    const answer = await server.elicitInput({
      mode: "form",
      message: "Choose a team",
      requestedSchema: { type: "object", properties: { team: { type: "string" } } },
    });
    return { content: [{ type: "text", text: answer.action }] };
  });
  await server.connect(new StdioServerTransport());
}

/** Minimal Anthropic streaming response asking for one tool, or ending the turn. */
function modelResponse(
  model: string,
  tool?: { id: string; name: string; input: Record<string, unknown> },
): Response {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const block = tool
    ? {
        start: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
        delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
      }
    : { start: { type: "text", text: "" }, delta: { type: "text_delta", text: "done" } };
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_${tool?.id ?? "end"}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      },
    ],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: block.start }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: block.delta }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
        usage,
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return new Response(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function until(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

interface Delivery {
  requestId: string | undefined;
  toolUseId: string | undefined;
  signal: AbortSignal;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "claude-rejoin-requests-"));
  const configDir = join(root, "config");
  const cwd = join(root, "project");
  await mkdir(configDir);
  await mkdir(cwd);
  await writeFile(
    join(configDir, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true }),
  );

  // The model issues scripted tool calls and reads the earlier answers.
  const toolResults: string[] = [];
  let bridgeScenario = false;
  let bridgeModelCalls = 0;
  let bridgeSecondPromptSeen = false;
  let recoveredQuestionAsked = false;
  const lostQuestionPrompt = "Simulate a lost question from the attached process";
  const allowBackgroundModel = Promise.withResolvers<void>();
  const subagentPrompt = "Use the fixture write tool once.";
  const backgroundPath = join(cwd, "background.txt");
  let backgroundAgentOffered = false;
  let backgroundWriteOffered = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/count_tokens"))
        return Response.json({ input_tokens: 1 });
      const body = (await request.json()) as {
        model: string;
        stream?: boolean;
        messages: Array<{ role: string; content: unknown }>;
      };
      if (!body.stream) {
        return Response.json({
          id: "msg_fixture_validation",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: "available" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      if (bridgeScenario) {
        bridgeModelCalls += 1;
        const lastUser = body.messages.filter((message) => message.role === "user").at(-1);
        const content = JSON.stringify(lastUser?.content ?? "");
        if (content.includes("Second bridge prompt")) bridgeSecondPromptSeen = true;
        if (content.includes(lostQuestionPrompt) && !recoveredQuestionAsked) {
          recoveredQuestionAsked = true;
          return modelResponse(body.model, {
            id: "toolu_bridge_question",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Which fixture team?",
                  header: "Team",
                  options: [
                    { label: "Core", description: "Core team" },
                    { label: "Docs", description: "Documentation team" },
                  ],
                  multiSelect: false,
                },
              ],
            },
          });
        }
        if (content.includes(subagentPrompt) && !backgroundWriteOffered) {
          backgroundWriteOffered = true;
          await allowBackgroundModel.promise;
          return modelResponse(body.model, {
            id: "toolu_background_write",
            name: "Write",
            input: { file_path: backgroundPath, content: "background completed" },
          });
        }
        if (content.includes("Start the background fixture") && !backgroundAgentOffered) {
          backgroundAgentOffered = true;
          return modelResponse(body.model, {
            id: "toolu_background_agent",
            name: "Agent",
            input: {
              description: "Run fixture",
              prompt: subagentPrompt,
              subagent_type: "general-purpose",
              run_in_background: true,
            },
          });
        }
        return modelResponse(body.model);
      }
      const results = body.messages.flatMap((message) =>
        message.role === "user" && Array.isArray(message.content)
          ? (message.content as Array<{ type?: string; content?: unknown }>).filter(
              (block) => block.type === "tool_result",
            )
          : [],
      );
      if (results.length > toolResults.length) {
        toolResults.length = 0;
        for (const result of results) toolResults.push(JSON.stringify(result.content ?? ""));
      }
      const round = results.length;
      if (round >= 4) return modelResponse(body.model);
      if (round === 2) {
        return modelResponse(body.model, {
          id: "toolu_elicitation",
          name: "mcp__fixture__ask",
          input: {},
        });
      }
      return modelResponse(body.model, {
        id: `toolu_fixture_${round}`,
        name: "Write",
        input: { file_path: join(cwd, `round-${round}.txt`), content: "fixture" },
      });
    },
  });

  // The stdout tap: drop the first permission frame (a lost frame) and keep
  // what each `initialize` answer listed, which the SDK hands nobody.
  let dropped: string | undefined;
  let droppedBridgeQuestion: string | undefined;
  let hidingBridgeFrames = false;
  let elicitationId: string | undefined;
  let releaseElicitationFrame: (() => void) | undefined;
  let heldHookId: string | undefined;
  let releaseHook: (() => void) | undefined;
  let hookCancelled = false;
  const inventories: Array<Record<string, string[] | null>> = [];
  const tap = (line: string, forward: () => void): boolean => {
    let frame: {
      type?: string;
      request_id?: string;
      request?: {
        subtype?: string;
        tool_name?: string;
        input?: { hook_event_name?: string; tool_use_id?: string };
      };
      response?: Record<string, unknown> & { subtype?: string };
    };
    try {
      frame = JSON.parse(line);
    } catch {
      return true;
    }
    if (
      heldHookId === undefined &&
      frame.type === "control_request" &&
      frame.request?.subtype === "hook_callback" &&
      frame.request.input?.hook_event_name === "PreToolUse" &&
      frame.request.input.tool_use_id === "toolu_background_write"
    ) {
      heldHookId = frame.request_id;
      releaseHook = forward;
      return false;
    }
    if (frame.type === "control_cancel_request" && frame.request_id === heldHookId) {
      hookCancelled = true;
    }
    if (
      bridgeScenario &&
      droppedBridgeQuestion === undefined &&
      frame.type === "control_request" &&
      frame.request?.subtype === "can_use_tool" &&
      frame.request.tool_name === "AskUserQuestion"
    ) {
      droppedBridgeQuestion = frame.request_id;
      hidingBridgeFrames = false;
      return false;
    }
    if (
      frame.type === "control_request" &&
      frame.request?.subtype === "can_use_tool" &&
      dropped === undefined
    ) {
      dropped = frame.request_id;
      return false;
    }
    if (
      elicitationId === undefined &&
      frame.type === "control_request" &&
      frame.request?.subtype === "elicitation"
    ) {
      elicitationId = frame.request_id;
      releaseElicitationFrame = forward;
      return false;
    }
    const response = frame.type === "control_response" ? frame.response : undefined;
    if (response && "commands" in ((response.response as object | undefined) ?? {})) {
      const ids = (key: string) => {
        const list = response[key];
        return Array.isArray(list)
          ? list.map((entry: { request_id?: string }) => entry.request_id ?? "")
          : null;
      };
      inventories.push({
        permissions: ids("pending_permission_requests"),
        dialogs: ids("pending_user_dialog_requests"),
        elicitations: ids("pending_elicitation_requests"),
      });
    }
    // The bridge never saw the extra foreground turn start. Keep control
    // traffic flowing so the CLI can reach its permission request.
    return !hidingBridgeFrames || frame.type?.startsWith("control_") === true;
  };

  const ledger = new ClaudeControlRequests();
  const deliveries: Delivery[] = [];
  const answers = new Map<string, (denial: string) => void>();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompt: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "user",
        message: { role: "user", content: "Write the fixture files." },
        parent_tool_use_id: null,
        session_id: "",
      };
      await held;
    },
  };
  let exited: Promise<void> = Promise.resolve();
  let killChild: () => void = () => {};
  let injectPrompt: ((message: SDKUserMessage) => void) | undefined;
  let launches = 0;
  const spawnClaudeCodeProcess: NonNullable<Options["spawnClaudeCodeProcess"]> = (options) => {
    launches += 1;
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: environment,
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
    });
    exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    killChild = () => child.kill("SIGKILL");
    injectPrompt = (message) => void child.stdin!.write(`${JSON.stringify(message)}\n`);
    const filtered = new PassThrough();
    let buffered = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const forward = () => void filtered.write(`${line}\n`);
        if (tap(line, forward)) forward();
        newline = buffered.indexOf("\n");
      }
    });
    child.stdout!.once("end", () => filtered.end());
    // `child` delivers every event this adapter forwards.
    const listen =
      (method: "on" | "once" | "off") => (event: string, listener: (...args: never[]) => void) =>
        void child[method](event, listener as (...args: unknown[]) => void);
    const spawned: SpawnedProcess = {
      stdin: child.stdin!,
      stdout: filtered,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: (signal) => child.kill(signal),
      on: listen("on") as SpawnedProcess["on"],
      once: listen("once") as SpawnedProcess["once"],
      off: listen("off") as SpawnedProcess["off"],
    };
    return spawned;
  };
  const environment = {
    PATH: process.env.PATH,
    HOME: root,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: server.url.origin,
    ANTHROPIC_API_KEY: "fixture-only",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    ENABLE_TOOL_SEARCH: "false",
  };
  const finishElicitation = Promise.withResolvers<{ action: "cancel" }>();
  let elicitationDeliveries = 0;
  const control = query({
    prompt,
    options: {
      cwd,
      ...claudeExecutableOptions(),
      mcpServersDelivery: "argv",
      spawnClaudeCodeProcess,
      settingSources: [],
      model: "claude-sonnet-4-6",
      maxTurns: 6,
      permissionMode: "default",
      // The bridge's wiring: every delivery goes through the ledger, and the
      // card is the open answer, settled here by `answers`.
      canUseTool: (_toolName, _input, options) =>
        ledger.answerOnce(
          options.requestId,
          options.signal,
          () => ({ behavior: "deny", message: "refused" }),
          (signal) => {
            deliveries.push({ requestId: options.requestId, toolUseId: options.toolUseID, signal });
            return new Promise((resolve) => {
              const answer = (message: string) => resolve({ behavior: "deny", message });
              if (options.requestId) answers.set(options.requestId, answer);
              signal.addEventListener("abort", () => answer("withdrawn"), { once: true });
            });
          },
        ),
      env: environment,
      allowedTools: ["mcp__fixture__ask"],
      mcpServers: {
        fixture: {
          type: "stdio",
          command: process.execPath,
          args: [import.meta.path, "--mcp-fixture"],
        },
      },
      onElicitation: () => {
        elicitationDeliveries += 1;
        return finishElicitation.promise;
      },
    },
  });
  const stop = () => {
    release();
    allowBackgroundModel.resolve();
    finishElicitation.resolve({ action: "cancel" });
    control.close();
    killChild();
  };
  process.once("SIGTERM", () => {
    stop();
    process.exit(143);
  });
  const frames = (async () => {
    for await (const message of control) if (message.type === "result") break;
  })().catch(() => undefined);
  try {
    // 1. The CLI asked; only the CLI knows of it.
    await until("the dropped permission frame", () => dropped !== undefined);
    await Bun.sleep(200);
    const beforeRejoin = deliveries.length;
    const reinitializeAnswer = (await control.reinitialize()) as unknown as Record<string, unknown>;
    await until("the redelivered request", () => deliveries.length > beforeRejoin);
    await Bun.sleep(200);
    const recovered = deliveries.filter((delivery) => delivery.requestId === dropped);
    answers.get(dropped!)?.(DENIAL);
    await until("the model to read the answer", () => toolResults.length >= 1);

    // 2. A card still open when the re-read lists it.
    await until("the second request", () => deliveries.length >= 2);
    const second = deliveries[1]!;
    const overlapOutcome = await reinitializeLiveClaude(control);
    await Bun.sleep(300);
    const secondDeliveries = deliveries.filter(
      (delivery) => delivery.requestId === second.requestId,
    ).length;
    answers.get(second.requestId!)?.(DENIAL);
    await until("the model to read the second answer", () => toolResults.length >= 2);
    const afterAnswer = await reinitializeLiveClaude(control);
    await Bun.sleep(300);

    await until("the real MCP elicitation", () => releaseElicitationFrame !== undefined);
    const elicitationInventory = await control.reinitialize();
    const cliListedPendingElicitation =
      inventories.at(-1)?.elicitations?.includes(elicitationId!) ?? false;
    const sdkReplayedElicitation = elicitationDeliveries > 0;
    releaseElicitationFrame!();
    await until("the original MCP elicitation to reach the SDK", () => elicitationDeliveries === 1);
    finishElicitation.resolve({ action: "cancel" });
    await until("the model to read the MCP tool result", () => toolResults.length >= 3);

    // 3. A card whose CLI dies.
    await until("the third request", () => deliveries.length >= 3);
    const third = deliveries[2]!;
    killChild();
    await until("the dead CLI's card to withdraw", () => third.signal.aborted);
    ledger.end();
    const afterEnd = await ledger.answerOnce(
      "after-end",
      undefined,
      (reason) => reason,
      async () => "answered" as const,
    );

    const permissionInventories = inventories.slice();
    await exited;
    bridgeScenario = true;
    setClaudeHomeForTesting(root);
    // The bridge's configuration readers and child both use the disposable home.
    Object.assign(process.env, environment, { CWD: cwd, GH_TOKEN: "fixture-only" });
    delete process.env.ORKESTRATOR_GITHUB_CREDENTIAL_FILE;
    const session = createSession("Warm rejoin fixture");
    const promptOptions = { model: "claude-sonnet-4-6" };
    const testHooks = { spawnClaudeCodeProcess };
    const first = sendPrompt(session.id, "First bridge prompt", promptOptions, testHooks);
    void first.catch(() => undefined);
    await until(
      "the first bridge prompt to release its CLI",
      () =>
        bridgeModelCalls >= 1 &&
        session.status === "idle" &&
        session.claudeRuntime?.state === "open",
    );
    const warmRuntime = session.claudeRuntime!;
    // Simulate an input sent by a previous attachment after the bridge has
    // released its foreground. The provider waits on a question whose lost
    // frame is invisible to both the bridge and the SDK.
    hidingBridgeFrames = true;
    injectPrompt!({
      type: "user",
      message: { role: "user", content: lostQuestionPrompt },
      parent_tool_use_id: null,
      session_id: "",
    });
    await until("the dropped bridge question", () => droppedBridgeQuestion !== undefined);
    if (
      session.status !== "idle" ||
      getPendingQuestions(session.id).length ||
      claudeRuntimeOwesWork(warmRuntime)
    ) {
      throw new Error("The lost question must be invisible before the warm join");
    }
    const inventoryCount = inventories.length;
    const secondPrompt = sendPrompt(session.id, "Second bridge prompt", promptOptions, testHooks);
    void secondPrompt.catch(() => undefined);
    await until(
      "the inventory response for the second prompt",
      () => inventories.length > inventoryCount,
    );
    if (!(inventories.at(-1)?.permissions ?? []).includes(droppedBridgeQuestion!)) {
      throw new Error("The CLI did not list the dropped question during the second prompt");
    }
    await until("the bridge to recover the question during the second prompt", () =>
      getPendingQuestions(session.id).some((card) => card.id === droppedBridgeQuestion),
    );
    const recoveredBridgeQuestion =
      getPendingQuestions(session.id).length === 1 &&
      (inventories.at(-1)?.permissions ?? []).includes(droppedBridgeQuestion!) &&
      answerQuestion(droppedBridgeQuestion!, { "Which fixture team?": "Core" });
    await until(
      "the second bridge prompt to finish",
      () => bridgeSecondPromptSeen && session.status === "idle",
    );
    const bridgeRejoined =
      session.claudeRuntime === warmRuntime &&
      launches === 2 &&
      warmRuntime.rejoins === 1 &&
      inventories.length === inventoryCount + 1;

    const thirdPrompt = sendPrompt(
      session.id,
      "Start the background fixture",
      promptOptions,
      testHooks,
    );
    void thirdPrompt.catch(() => undefined);
    await until(
      "the root turn to release its background agent",
      () =>
        backgroundWriteOffered && session.status === "idle" && claudeRuntimeOwesWork(warmRuntime),
    );
    allowBackgroundModel.resolve();
    await until("the real background PreToolUse callback", () => releaseHook !== undefined);
    const backgroundTurn = warmRuntime.latestTurn;
    const inventoriesBeforeBusyJoin = inventories.length;
    const fourthPrompt = sendPrompt(
      session.id,
      "Join while the hook waits",
      promptOptions,
      testHooks,
    );
    void fourthPrompt.catch(() => undefined);
    await until(
      "the busy follow-up to reach the same runtime",
      () => warmRuntime.latestTurn !== backgroundTurn,
    );
    releaseHook!();
    await until("the background tool to run", () => existsSync(backgroundPath));
    const liveBackgroundHookSurvived =
      !hookCancelled &&
      session.claudeRuntime === warmRuntime &&
      launches === 2 &&
      inventories.length === inventoriesBeforeBusyJoin &&
      (await readFile(backgroundPath, "utf8")) === "background completed";
    warmRuntime.control.close?.();
    await Promise.all([first, secondPrompt, thirdPrompt, fourthPrompt, exited]);

    const result = {
      bridgeRejoined,
      recoveredBridgeQuestion,
      liveBackgroundHookSurvived,
      elicitationDeliveries,
      sdkReplayedElicitation,
      cliListedPendingElicitation,
      sdkReturnedElicitationInventory: "pending_elicitation_requests" in elicitationInventory,
      dropped: dropped !== undefined,
      recoveredOnce: recovered.length === 1,
      recoveredToolUseId: recovered[0]?.toolUseId,
      answerReachedCli: toolResults[0]?.includes(DENIAL) ?? false,
      firstInventoryListedDropped:
        inventories.find((inventory) => (inventory.permissions ?? []).includes(dropped!)) !==
        undefined,
      overlapOutcome,
      secondDeliveries,
      secondAnswerReachedCli: toolResults[1]?.includes(DENIAL) ?? false,
      afterAnswer,
      // Once answered, the CLI no longer lists it.
      answeredStillListed: (permissionInventories.at(-1)?.permissions ?? []).includes(
        second.requestId!,
      ),
      // Whatever else the last re-read listed was already a card: no extra delivery.
      totalDeliveries: deliveries.length,
      deadCardWithdrawn: third.signal.aborted,
      afterEnd,
      // The answer `reinitialize()` hands the caller carries no inventory.
      callerSeesInventory: [
        "pending_permission_requests",
        "pending_user_dialog_requests",
        "pending_elicitation_requests",
      ].some((key) => key in reinitializeAnswer),
      cliListsElicitations: permissionInventories.every(
        (inventory) => inventory.elicitations !== null,
      ),
      cliListsPermissions: permissionInventories.every(
        (inventory) => inventory.permissions !== null,
      ),
    };
    process.stdout.write(`${REJOIN_RESULT_SENTINEL}${JSON.stringify(result)}\n`);
  } finally {
    stop();
    await frames;
    await exited;
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

// Only as a script: the test imports the sentinel from this module.
if (import.meta.main) {
  (process.argv.includes("--mcp-fixture") ? runMcpFixture() : main()).then(
    () => {
      if (!process.argv.includes("--mcp-fixture")) process.exit(0);
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
