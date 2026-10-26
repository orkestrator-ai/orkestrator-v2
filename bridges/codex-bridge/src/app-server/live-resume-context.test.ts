/**
 * A resumed transcript against the **real** pinned `codex app-server` binary.
 *
 * Codex writes blocks of its own into the rollout as user messages: the
 * `<environment_context>` that opens a thread, a skill's `<skill>`
 * instructions after the `$name` prompt that invoked it, and a
 * `<turn_aborted>` note after an interrupt. The live tab shows none of them,
 * so a reload from the rollout must not either. Nor may it show the text the
 * bridge sent in place of what the user typed (plan-mode preamble, `$name`,
 * an expanded template, the recovered transcript). A loopback Responses endpoint
 * plays the model, so this runs real turns without calling a model or
 * spending credits. Gated like the other live contract tests because it needs
 * the pinned binary:
 *
 *   RUN_LIVE_CODEX_APP_SERVER=1 \
 *     bun test bridges/codex-bridge/src/app-server/live-resume-context.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAppServerConfigOverrides } from "../codex-config.js";
import { AppServerEngine } from "../engine/app-server-engine.js";
import type { EngineEvent, EngineTurnConfig, EngineUserInput } from "../engine/types.js";
import { hydrateMessagesFromPersistedSession } from "../history/rollout.js";
import { resolveCodexBinary } from "./live-binary.js";
import { buildRecoveredContextPrompt } from "../app-server-runtime-base.js";
import { wrapPromptForConversationMode } from "../prompts/slash-commands.js";
import { recordTypedPrompt } from "../sessions/typed-prompts.js";

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
/** The loopback model never answers a request whose input holds this. */
const HANG = "Stop there";

/**
 * A Responses WebSocket that answers every sample with one short assistant
 * message, except a turn whose prompt is `HANG`, which it leaves open so the
 * test can interrupt it.
 */
function startScriptedResponses() {
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
          input?: unknown[];
        };
        if (frame.type !== "response.create") return;
        const id = `resp_${Math.random().toString(36).slice(2)}`;
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        send({ type: "response.created", response: { id } });
        if (frame.generate !== false) {
          const last = JSON.stringify(frame.input?.at(-1) ?? null);
          if (last.includes(HANG)) return;
          send({
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "message",
              id: `msg_${id}`,
              role: "assistant",
              content: [{ type: "output_text", text: "done", annotations: [] }],
              status: "completed",
            },
          });
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
 * A real app-server on a fresh CODEX_HOME holding one `tidy` skill, whose
 * model is the loopback fake. No AGENTS.md anywhere: the shape of an
 * isolated profile, where the environment block opens the thread as a
 * message of its own.
 */
async function startLiveCodex() {
  // Real paths: Codex matches a skill input against the skill roots it loaded.
  const codexHome = await realpath(await mkdtemp(join(tmpdir(), "ork-resume-context-home-")));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "ork-resume-context-ws-")));
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  // Never a real key: the only server it can reach is the loopback fake.
  await writeFile(
    join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-orkestrator-loopback-probe" }),
    { mode: 0o600 },
  );
  const skillPath = join(codexHome, "skills", "tidy", "SKILL.md");
  await mkdir(join(codexHome, "skills", "tidy"), { recursive: true });
  await writeFile(
    skillPath,
    "---\nname: tidy\ndescription: Tidy the named thing.\n---\n\nTidy it and reply done.\n",
    "utf8",
  );

  const responses = startScriptedResponses();
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
  const completedTurns = new Map<string, string>();
  const waiters = new Map<string, () => void>();
  engine.subscribe((event: EngineEvent) => {
    if (event.kind !== "turn.completed") return;
    completedTurns.set(event.turnId, event.status);
    waiters.get(event.turnId)?.();
  });
  const completion = (turnId: string) =>
    completedTurns.has(turnId)
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.set(turnId, resolve));
  const config: EngineTurnConfig = {
    mode: "build",
    cwd: workspace,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    policy: {
      id: "interactive-host",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "full",
    },
  };
  return { codexHome, skillPath, responses, engine, completedTurns, completion, config };
}

describeLive("live resumed transcript", () => {
  test("a reload shows only the prompts the user sent, not Codex's own user blocks", async () => {
    const { codexHome, skillPath, responses, engine, completedTurns, completion, config } =
      await startLiveCodex();
    // What the live tab shows for each turn is the prompt as sent; the skill
    // turn's wire text is the `$name` marker the bridge builds for it.
    const turns: Array<{ input: EngineUserInput[]; interrupt?: true }> = [
      { input: [{ type: "text", text: "Open the design canvas" }] },
      {
        input: [
          { type: "text", text: "$tidy the header" },
          { type: "skill", name: "tidy", path: skillPath },
        ],
      },
      { input: [{ type: "text", text: HANG }], interrupt: true },
      { input: [{ type: "text", text: "<environment_context> looks wrong, why?" }] },
    ];
    const sent = turns.map((turn) => (turn.input[0] as { text: string }).text);

    let threadId: string | null = null;
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      await engine.start();
      const thread = await engine.startThread({ config });
      for (const turn of turns) {
        const started = await engine.startTurn({
          handle: thread.handle,
          input: turn.input,
          config,
        });
        threadId ??= started.threadId;
        if (turn.interrupt) {
          // Let the request reach the model before stopping it.
          await Bun.sleep(1_000);
          await engine.interruptTurn(thread.handle, started.turnId);
        }
        await withTimeout(completion(started.turnId), 60_000, `turn ${started.turnId}`);
      }
    } finally {
      await engine.stop();
      await responses.stop();
    }
    expect(threadId).toBeString();
    expect([...completedTurns.values()]).toEqual([
      "completed",
      "completed",
      "interrupted",
      "completed",
    ]);

    process.env.CODEX_HOME = codexHome;
    try {
      const hydrated = await hydrateMessagesFromPersistedSession(threadId!);
      expect(hydrated.transcriptStatus).not.toBe("unavailable");

      // The rollout really holds Codex's own blocks as user messages.
      const rolloutName = (await readdir(join(codexHome, "sessions"), { recursive: true })).find(
        (name) => name.endsWith(`${threadId}.jsonl`),
      );
      expect(rolloutName).toBeString();
      const rollout = await readFile(join(codexHome, "sessions", rolloutName!), "utf8");
      const messageOpenings = rollout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> })
        .filter((record) => record.type === "response_item" && record.payload?.type === "message")
        .map((record) => ({
          role: record.payload!.role,
          text: (record.payload!.content as Array<{ text?: string }>)
            .map((segment) => segment.text ?? "")
            .join("\n")
            .trim(),
        }));
      const roleOf = (tag: string) =>
        messageOpenings.find(({ text }) => text.startsWith(tag))?.role;
      expect(roleOf("<environment_context>")).toBe("user");
      expect(roleOf("<skill>")).toBe("user");
      // 0.164.0 writes the interrupt note as a developer message; earlier
      // releases wrote it as a user message, which the reader also drops.
      expect(roleOf("<turn_aborted>")).toBe("developer");

      expect(
        hydrated.messages.filter((message) => message.role === "user").map((m) => m.content),
      ).toEqual(sent);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  }, 180_000);

  test("a reload shows a prompt the bridge rewrote as the user typed it", async () => {
    const { codexHome, skillPath, responses, engine, completedTurns, completion, config } =
      await startLiveCodex();
    const ownReminder = "<system-reminder>Keep mine</system-reminder>\n\nPlan it";
    // Each turn as the runtime builds it: the text it sends, and the typed
    // text it records when that cannot be read back from what was sent.
    const turns: Array<{ typed: string; input: EngineUserInput[]; records: boolean }> = [
      {
        typed: "Continue now",
        input: [
          {
            type: "text",
            text: buildRecoveredContextPrompt(
              [
                { id: "u", role: "user", content: "Remember this", parts: [], createdAt: "" },
                { id: "a", role: "assistant", content: "Kept.", parts: [], createdAt: "" },
              ],
              "Continue now",
            ),
          },
        ],
        records: true,
      },
      {
        typed: "/skill:tidy the header",
        input: [
          { type: "text", text: "$tidy the header" },
          { type: "skill", name: "tidy", path: skillPath },
        ],
        records: true,
      },
      {
        typed: "/review src/a.ts",
        input: [{ type: "text", text: "Review src/a.ts and report." }],
        records: true,
      },
      {
        typed: "Plan the header",
        input: [{ type: "text", text: wrapPromptForConversationMode("Plan the header", "plan") }],
        records: false,
      },
      {
        typed: ownReminder,
        input: [{ type: "text", text: wrapPromptForConversationMode(ownReminder, "plan") }],
        records: false,
      },
    ];

    let threadId: string | null = null;
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      await engine.start();
      const thread = await engine.startThread({ config });
      for (const turn of turns) {
        const started = await engine.startTurn({
          handle: thread.handle,
          input: turn.input,
          config,
        });
        threadId ??= started.threadId;
        if (turn.records) {
          await recordTypedPrompt(
            codexHome,
            started.threadId,
            started.turnId,
            (turn.input[0] as { text: string }).text,
            turn.typed,
          );
        }
        await withTimeout(completion(started.turnId), 60_000, `turn ${started.turnId}`);
      }
    } finally {
      await engine.stop();
      await responses.stop();
    }
    expect(threadId).toBeString();
    expect([...completedTurns.values()]).toEqual(turns.map(() => "completed"));

    process.env.CODEX_HOME = codexHome;
    try {
      const hydrated = await hydrateMessagesFromPersistedSession(threadId!);
      expect(hydrated.transcriptStatus).not.toBe("unavailable");
      expect(
        hydrated.messages.filter((message) => message.role === "user").map((m) => m.content),
      ).toEqual(turns.map((turn) => turn.typed));
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  }, 180_000);
});
