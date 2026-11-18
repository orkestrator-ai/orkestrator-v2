// Qualifies an actual rejoin on the real pinned Claude CLI: what
// `recoverClaudeRequestsOnRejoin` (`live-claude-control.ts`) and
// `ClaudeControlRequests` rely on when a prompt is written into a CLI that
// outlived its turn. A tab remount never reaches the CLI; this does.
//
// 1. A permission request only the CLI knows of. The stdout tap drops the
//    CLI's first `can_use_tool` frame, as a lost frame would, so the SDK never
//    sees it and the CLI waits. Re-sending `initialize` lists it and the SDK
//    redelivers it to `canUseTool`, where the ledger makes it one card; the
//    answer reaches the CLI (the model is told of the denial).
// 2. A replay that overlaps a card still open: the re-read lists the request
//    the bridge is answering, and the SDK does not deliver it again.
// 3. A request from a CLI that dies: the callback's signal aborts, so the card
//    withdraws, and the ledger refuses anything after the end.
// 4. What the SDK hands the caller: none of the inventory lists, so the
//    elicitation inventory stays unknown to the bridge.
//
// Credential-free: a temporary home and configuration directory, non-essential
// traffic off, and a deterministic loopback model that asks to write a file
// three times. Every call is denied, so nothing is written. Run by
// `claude-rejoin-requests.live.test.ts` in its own process, because the
// session-manager suites replace the SDK with a mock.
import { query, type SDKUserMessage, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ClaudeControlRequests } from "./claude-control-requests.js";
import { reinitializeLiveClaude } from "./live-claude-control.js";
import { claudeExecutableOptions } from "./session-manager-core.js";

export const REJOIN_RESULT_SENTINEL = "__CLAUDE_REJOIN_REQUESTS_RESULT__";
const DENIAL = "Fixture: denied after the rejoin.";
const WAIT_MS = 30_000;

/** Minimal Anthropic streaming response asking for one Write, or ending the turn. */
function modelResponse(model: string, write?: { id: string; path: string }): Response {
  const usage = { input_tokens: 1, output_tokens: 1 };
  const block = write
    ? {
        start: { type: "tool_use", id: write.id, name: "Write", input: {} },
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({ file_path: write.path, content: "fixture" }),
        },
      }
    : { start: { type: "text", text: "" }, delta: { type: "text_delta", text: "done" } };
  const events: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_${write?.id ?? "end"}`,
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
        delta: { stop_reason: write ? "tool_use" : "end_turn", stop_sequence: null },
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

  // The model asks for one Write per round and reads the earlier answers.
  const toolResults: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/count_tokens"))
        return Response.json({ input_tokens: 1 });
      const body = (await request.json()) as {
        model: string;
        messages: Array<{ role: string; content: unknown }>;
      };
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
      if (round >= 3) return modelResponse(body.model);
      return modelResponse(body.model, {
        id: `toolu_fixture_${round}`,
        path: join(cwd, `round-${round}.txt`),
      });
    },
  });

  // The stdout tap: drop the first permission frame (a lost frame) and keep
  // what each `initialize` answer listed, which the SDK hands nobody.
  let dropped: string | undefined;
  const inventories: Array<Record<string, string[] | null>> = [];
  const tap = (line: string): boolean => {
    let frame: {
      type?: string;
      request_id?: string;
      request?: { subtype?: string };
      response?: Record<string, unknown> & { subtype?: string };
    };
    try {
      frame = JSON.parse(line);
    } catch {
      return true;
    }
    if (
      frame.type === "control_request" &&
      frame.request?.subtype === "can_use_tool" &&
      dropped === undefined
    ) {
      dropped = frame.request_id;
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
    return true;
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
  const control = query({
    prompt,
    options: {
      cwd,
      ...claudeExecutableOptions(),
      spawnClaudeCodeProcess: (options) => {
        const child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ["pipe", "pipe", "ignore"],
        });
        exited = new Promise((resolve) => {
          child.once("exit", () => resolve());
          child.once("error", () => resolve());
        });
        killChild = () => child.kill("SIGKILL");
        const filtered = new PassThrough();
        let buffered = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          let newline = buffered.indexOf("\n");
          while (newline >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (tap(line)) filtered.write(`${line}\n`);
            newline = buffered.indexOf("\n");
          }
        });
        child.stdout!.once("end", () => filtered.end());
        // `child` delivers every event this adapter forwards.
        const listen =
          (method: "on" | "once" | "off") =>
          (event: string, listener: (...args: never[]) => void) =>
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
      },
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
      env: {
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
      },
    },
  });
  const stop = () => {
    release();
    control.close();
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

    const result = {
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
      answeredStillListed: (inventories.at(-1)?.permissions ?? []).includes(second.requestId!),
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
      cliListsElicitations: inventories.every((inventory) => inventory.elicitations !== null),
      cliListsPermissions: inventories.every((inventory) => inventory.permissions !== null),
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
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
