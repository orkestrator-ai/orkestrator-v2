import { afterEach, describe, expect, mock, test } from "bun:test";
import { AGENT_VOICE_CHAT_INTERRUPT_OPEN_TAG } from "@orkestrator/protocol/agent-voice-chat";
import { readStoredValue, seedStore } from "./storage-test-support.js";
import { adapterError } from "./control-mcp-results.js";
import { AGENT_VOICE_CHAT_TOOL_NAMES } from "./control-mcp-agent-voice-chat.js";
import { controlMcpHarness } from "./control-mcp-test-support.js";
import { seedCoordinator } from "./public-api/test-coordinator.js";
import { cleanupSessionHarnesses, setActivity } from "./public-api/test-provider.js";

/**
 * Agent voice chat over the real Control MCP listener, public-action stack,
 * native-agent service and agent registry, with a scripted reply model in
 * place of the one-shot CLI run. Nothing spends tokens.
 */

const harnesses: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
  await cleanupSessionHarnesses();
});

type Reply = (input: { prompt: string; agent?: string }) => Promise<string>;

async function open(reply: Reply = async () => "The coordinator is working on the parser.") {
  const replies = mock(reply);
  const harness = await controlMcpHarness({ agentVoiceChatReply: replies });
  harnesses.push(harness);
  const seeded = await seedCoordinator(harness);
  await harness.harness.storage.updateProject(harness.projectId, { name: "Atlas" });
  return { ...harness, ...seeded, replies };
}

function structured(result: { structuredContent?: Record<string, unknown> }) {
  return result.structuredContent as {
    ok: boolean;
    action: string;
    result?: Record<string, unknown>;
    error?: { code: string; message: string };
    receipt?: { state: string; action: string };
  };
}

function spoken(result: { content?: Array<{ text?: string }> }): string {
  return result.content?.[0]?.text ?? "";
}

function steerable(stub: Awaited<ReturnType<typeof open>>["stub"]) {
  const action = mock(async () => ({ outcome: "applied" }));
  Object.assign(stub.provider, {
    activeSteerRun: async () => ({ state: "running", runId: "provider-turn" }),
    steerSupported: async () => true,
    steerStatus: async () => "dispatched",
    performSessionAction: action,
  });
  return action;
}

describe("agent voice chat tools", () => {
  test("are listed for credentials that may prompt sessions, and only for them", async () => {
    const harness = await open();
    const names = async (token: string) =>
      (await harness.list(token)).tools.map((tool) => tool.name);
    const voice = await harness.credential("voice");
    const listed = await names(voice.token);
    expect(listed.filter((name) => name.startsWith("agent_voice_chat"))).toEqual(
      AGENT_VOICE_CHAT_TOOL_NAMES,
    );
    // After the voice core, before the gateway.
    expect(listed.indexOf("agent_voice_chat_say")).toBe(listed.indexOf("start_work") + 1);
    expect(listed.indexOf("find_actions")).toBe(listed.indexOf("agent_voice_chat_interrupt") + 1);
    expect(await names(harness.defaultToken)).toEqual(
      expect.arrayContaining(AGENT_VOICE_CHAT_TOOL_NAMES),
    );
    const readOnly = await harness.credential("read-only");
    expect((await names(readOnly.token)).some((name) => name.startsWith("agent_voice_chat"))).toBe(
      false,
    );
    const reader = await harness.credential("custom", { capabilities: ["sessions.read"] });
    expect((await names(reader.token)).some((name) => name.startsWith("agent_voice_chat"))).toBe(
      false,
    );
    const noStop = await harness.credential("voice", { deniedActions: ["session.stop"] });
    const partial = await names(noStop.token);
    expect(partial).toContain("agent_voice_chat_say");
    expect(partial).not.toContain("agent_voice_chat_interrupt");
  });

  test("a voice agent holds a short back-and-forth about the project", async () => {
    const answers = ["The coordinator is reviewing the parser.", "About ten minutes."];
    const harness = await open(async () => answers.shift() ?? "Nothing more.");
    harness.stub.messages.push(
      {
        id: "m1",
        role: "user",
        content: "Review the parser change",
        createdAt: new Date(1_000).toISOString(),
        parts: [],
      },
      {
        id: "m2",
        role: "assistant",
        content: "I launched a reviewer for the parser change.",
        createdAt: new Date(2_000).toISOString(),
        parts: [],
      },
    );
    const voice = await harness.credential("voice");
    const first = await harness.call(voice.token, "agent_voice_chat_say", {
      projectId: harness.projectId,
      text: "What is the coordinator doing?",
      requestId: "say-1",
    });
    const opened = structured(first);
    expect(opened).toMatchObject({
      ok: true,
      action: "agent_voice_chat_say",
      result: {
        reply: "The coordinator is reviewing the parser.",
        state: "idle",
        replayed: false,
        title: "What is the coordinator doing?",
      },
    });
    const chatId = opened.result!.chatId as string;
    expect(chatId).toMatch(/^avc_/);
    expect(spoken(first)).toStartWith("The coordinator is reviewing the parser.");
    expect(spoken(first)).toContain(`chatId=${chatId}`);

    const prompt = harness.replies.mock.calls[0]![0].prompt;
    expect(harness.replies.mock.calls[0]![0].agent).toBe("claude");
    expect(prompt).toContain("Project: Atlas");
    expect(prompt).toContain("Main coordinator: claude");
    expect(prompt).toContain("Coordinator said: I launched a reviewer for the parser change.");
    expect(prompt).toContain("User wrote: Review the parser change");
    expect(prompt).toContain("<message>\nWhat is the coordinator doing?\n</message>");

    const second = await harness.call(voice.token, "agent_voice_chat_say", {
      chatId,
      text: "How long will it take?",
      requestId: "say-2",
    });
    expect(structured(second).result?.reply).toBe("About ten minutes.");
    const followUp = harness.replies.mock.calls[1]![0].prompt;
    expect(followUp).toContain("Voice agent: What is the coordinator doing?");
    expect(followUp).toContain("You: The coordinator is reviewing the parser.");
    expect(followUp).toContain("<message>\nHow long will it take?\n</message>");

    // A retry repeats the reply without another model run.
    const retried = await harness.call(voice.token, "agent_voice_chat_say", {
      chatId,
      text: "How long will it take?",
      requestId: "say-2",
    });
    expect(structured(retried).result).toMatchObject({
      reply: "About ten minutes.",
      replayed: true,
    });
    expect(harness.replies).toHaveBeenCalledTimes(2);

    const heard = structured(
      await harness.call(voice.token, "agent_voice_chat_listen", { chatId }),
    );
    expect((heard.result!.turns as Array<{ role: string }>).map((turn) => turn.role)).toEqual([
      "voice",
      "agent",
      "voice",
      "agent",
    ]);

    // Another credential cannot see the chat.
    const other = await harness.credential("voice", { label: "other voice" });
    const foreign = structured(
      await harness.call(other.token, "agent_voice_chat_listen", { chatId }),
    );
    expect(foreign.error?.code).toBe("not-found");

    const ended = await harness.call(voice.token, "agent_voice_chat_end", { chatId });
    expect(spoken(ended)).toStartWith("Voice chat ended.");
    const gone = structured(await harness.call(voice.token, "agent_voice_chat_listen", { chatId }));
    expect(gone.error?.code).toBe("not-found");
    // The chat never created a coordinator conversation.
    const workspace = await harness.harness.storage.coordinators.getCoordinatorWorkspace(
      harness.projectId,
    );
    expect(workspace?.conversations).toHaveLength(3);
  });

  test("opening retries, including concurrent calls, share one chat and model run", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const input = { projectId: harness.projectId, text: "Status?", requestId: "opening" };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => harness.call(voice.token, "agent_voice_chat_say", input)),
    );
    const first = structured(results[0]!).result!;
    for (const result of results)
      expect(structured(result).result).toMatchObject({
        chatId: first.chatId,
        turnId: first.turnId,
      });
    expect(
      structured(await harness.call(voice.token, "agent_voice_chat_say", input)).result,
    ).toMatchObject({ chatId: first.chatId, turnId: first.turnId, replayed: true });
    expect(harness.replies).toHaveBeenCalledTimes(1);
    expect(
      structured(
        await harness.call(voice.token, "agent_voice_chat_say", { ...input, text: "Changed" }),
      ).error?.code,
    ).toBe("request-conflict");
  });

  test("blank openings at capacity preserve all eight conversations", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const ids: unknown[] = [];
    for (let i = 0; i < 8; i++)
      ids.push(
        structured(
          await harness.call(voice.token, "agent_voice_chat_say", {
            projectId: harness.projectId,
            text: "Hello",
            requestId: `fill-${i}`,
          }),
        ).result!.chatId,
      );
    for (const text of ["", " \n\t "])
      expect(
        structured(
          await harness.call(voice.token, "agent_voice_chat_say", {
            projectId: harness.projectId,
            text,
            requestId: "blank",
          }),
        ).error?.code,
      ).toBe("invalid-input");
    for (const chatId of ids)
      expect(
        structured(
          await harness.call(voice.token, "agent_voice_chat_listen", { chatId, waitMs: 0 }),
        ).ok,
      ).toBe(true);
    expect(harness.replies).toHaveBeenCalledTimes(8);
  });

  test("listen speaks pending and failed status instead of an older answer", async () => {
    // The reply starts only after the project digest is read, which can be
    // after `say` and `listen` have returned, so wait for it before failing it.
    const started = Promise.withResolvers<(error: Error) => void>();
    let count = 0;
    const harness = await open(async () =>
      ++count === 1
        ? "Old answer."
        : new Promise<string>((_resolve, fail) => {
            started.resolve(fail);
          }),
    );
    const voice = await harness.credential("voice");
    const first = structured(
      await harness.call(voice.token, "agent_voice_chat_say", {
        projectId: harness.projectId,
        text: "One",
        requestId: "one",
      }),
    );
    const chatId = first.result!.chatId;
    await harness.call(voice.token, "agent_voice_chat_say", {
      chatId,
      text: "Two",
      requestId: "two",
      waitMs: 0,
    });
    expect(
      spoken(await harness.call(voice.token, "agent_voice_chat_listen", { chatId, waitMs: 0 })),
    ).toStartWith("Still thinking.");
    (await started.promise)(new Error("private"));
    expect(
      spoken(await harness.call(voice.token, "agent_voice_chat_listen", { chatId, waitMs: 1000 })),
    ).toStartWith("No reply:");
  });

  test("denied session list or state reads do not reach the reply prompt", async () => {
    const harness = await open();
    for (const deniedActions of [
      ["session.list"],
      ["session.get"],
      ["session.list", "session.get"],
    ]) {
      const voice = await harness.credential("voice", { deniedActions });
      const result = structured(
        await harness.call(voice.token, "agent_voice_chat_say", {
          projectId: harness.projectId,
          text: "Status?",
          requestId: "denied",
        }),
      );
      expect(result.ok).toBe(true);
      const prompt = harness.replies.mock.calls.at(-1)![0].prompt;
      expect(prompt).toContain("agents could not be read");
      for (const denied of ["Main coordinator:", "agent tabs in", "goal ", "Coordinator said:"])
        expect(prompt).not.toContain(denied);
    }
  });

  test("a slow reply is heard later with listen", async () => {
    const reply = Promise.withResolvers<string>();
    const harness = await open(() => reply.promise);
    const voice = await harness.credential("voice");
    const pending = await harness.call(voice.token, "agent_voice_chat_say", {
      projectId: harness.projectId,
      text: "Anything failing?",
      requestId: "slow-1",
      waitMs: 20,
    });
    const result = structured(pending).result!;
    expect(result).toMatchObject({ state: "replying", reply: null });
    expect(spoken(pending)).toStartWith("Still thinking.");
    expect(spoken(pending)).toContain("agent_voice_chat_listen");
    const turnId = result.turnId as string;
    reply.resolve("Nothing is failing.");
    const heard = await harness.call(voice.token, "agent_voice_chat_listen", {
      chatId: result.chatId,
      afterTurnId: turnId,
      waitMs: 1_000,
    });
    expect(spoken(heard)).toStartWith("Nothing is failing.");
    expect((structured(heard).result!.turns as unknown[]).length).toBe(1);
  });

  test("a reply that cannot be written says so without its error text", async () => {
    const harness = await open(async () => {
      throw new Error("claude: Prompt was: very private words");
    });
    const voice = await harness.credential("voice");
    const failed = await harness.call(voice.token, "agent_voice_chat_say", {
      projectId: harness.projectId,
      text: "Status?",
      requestId: "fail-1",
    });
    expect(structured(failed).result).toMatchObject({ state: "failed", reply: null });
    expect(spoken(failed)).not.toContain("private");
    expect(spoken(failed)).toContain("same requestId");
  });

  test("starting needs a readable project", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const missing = structured(
      await harness.call(voice.token, "agent_voice_chat_say", {
        projectId: "no-such-project",
        text: "hi",
        requestId: "missing-1",
      }),
    );
    expect(missing.ok).toBe(false);
    expect(harness.replies).not.toHaveBeenCalled();
    const neither = structured(
      await harness.call(voice.token, "agent_voice_chat_say", { text: "hi", requestId: "none-1" }),
    );
    expect(neither.error?.code).toBe("invalid-input");
  });
});

describe("agent voice chat interrupts the main coordinator", () => {
  test("a working coordinator is steered with the person's words", async () => {
    const harness = await open();
    const action = steerable(harness.stub);
    setActivity(
      harness.service,
      "claude",
      harness.tabId,
      harness.providerSessionId,
      "working",
      harness.environmentId,
    );
    const voice = await harness.credential("voice");
    const chat = structured(
      await harness.call(voice.token, "agent_voice_chat_say", {
        projectId: harness.projectId,
        text: "Is the build green?",
        requestId: "say-1",
      }),
    );
    const chatId = chat.result!.chatId as string;
    const interrupted = await harness.call(voice.token, "agent_voice_chat_interrupt", {
      chatId,
      text: "Pause the parser review and check the build.",
      requestId: "interrupt-1",
    });
    expect(structured(interrupted)).toMatchObject({ ok: true, action: "session.steer" });
    expect(spoken(interrupted)).toStartWith("Interrupted the coordinator");
    expect(action).toHaveBeenCalledTimes(1);
    const steer = (action.mock.calls[0] as unknown[])[1] as { kind: string; text: string };
    expect(steer.kind).toBe("steer");
    expect(steer.text).toStartWith(AGENT_VOICE_CHAT_INTERRUPT_OPEN_TAG);
    expect(steer.text).toContain('agent voice chat "Is the build green?"');
    expect(steer.text).toEndWith("Pause the parser review and check the build.");
    // The coordinator's conversation got no new prompt; the chat noted the interrupt.
    expect(harness.stub.sends).toHaveLength(0);
    const view = structured(await harness.call(voice.token, "agent_voice_chat_listen", { chatId }));
    expect((view.result!.turns as Array<{ role: string; text: string }>).at(-1)).toMatchObject({
      role: "event",
      text: "The voice agent interrupted the coordinator: Pause the parser review and check the build.",
    });

    // A retry of the same request replays the same steer.
    const retried = structured(
      await harness.call(voice.token, "agent_voice_chat_interrupt", {
        chatId,
        text: "Pause the parser review and check the build.",
        requestId: "interrupt-1",
      }),
    );
    expect(retried).toMatchObject({ ok: true, action: "session.steer" });
    expect(action).toHaveBeenCalledTimes(1);
    const replayView = structured(
      await harness.call(voice.token, "agent_voice_chat_listen", { chatId, waitMs: 0 }),
    );
    expect(
      (replayView.result!.turns as Array<{ role: string }>).filter((turn) => turn.role === "event"),
    ).toHaveLength(1);
  });

  test("an idle coordinator gets the words as a new message", async () => {
    const harness = await open();
    setActivity(
      harness.service,
      "claude",
      harness.tabId,
      harness.providerSessionId,
      "idle",
      harness.environmentId,
    );
    const voice = await harness.credential("voice");
    const sent = await harness.call(voice.token, "agent_voice_chat_interrupt", {
      projectId: harness.projectId,
      text: "Start on the release notes.",
      requestId: "interrupt-idle",
    });
    expect(structured(sent)).toMatchObject({ ok: true, action: "session.prompt" });
    expect(spoken(sent)).toContain("idle");
    expect(harness.stub.sends).toHaveLength(1);
    expect(harness.stub.sends[0]!.prompt).toContain(AGENT_VOICE_CHAT_INTERRUPT_OPEN_TAG);
    expect(harness.stub.sends[0]!.prompt).toContain("Start on the release notes.");
  });

  test("interrupt replay survives a new listener and changed coordinator activity", async () => {
    const harness = await open();
    const action = steerable(harness.stub);
    setActivity(
      harness.service,
      "claude",
      harness.tabId,
      harness.providerSessionId,
      "idle",
      harness.environmentId,
    );
    const voice = await harness.credential("voice");
    const input = { projectId: harness.projectId, text: "Release notes", requestId: "durable" };
    const calls = await Promise.all([
      harness.call(voice.token, "agent_voice_chat_interrupt", input),
      harness.call(voice.token, "agent_voice_chat_interrupt", input),
    ]);
    expect(calls.map((call) => structured(call).action)).toEqual([
      "session.prompt",
      "session.prompt",
    ]);
    expect(harness.stub.sends).toHaveLength(1);
    // More than the former 256-entry cache: none may displace the original binding.
    for (let i = 0; i < 300; i++)
      harness.harness.storage.publicOperations.bindVoiceInterrupt({
        ownerId: voice.id,
        requestId: `later-${i}`,
        fingerprint: `hash-${i}`,
        choice: { sessionId: "later", action: "session.stop" },
      });
    await harness.server.stop();
    const { ControlMcpServer } = await import("./control-mcp-server.js");
    const { rpc } = await import("./control-mcp-test-support.js");
    const server = new ControlMcpServer(
      harness.harness.dataDir,
      async <T>(command: string, args: Record<string, unknown> = {}) =>
        (await harness.harness.commands.get(command)!(args, harness.harness.context)) as T,
      { port: 0 },
    );
    harnesses.push({ close: () => server.stop() });
    await server.start();
    setActivity(
      harness.service,
      "claude",
      harness.tabId,
      harness.providerSessionId,
      "working",
      harness.environmentId,
    );
    const replay = await rpc(server.getInfo()!.url, voice.token, "tools/call", {
      name: "agent_voice_chat_interrupt",
      arguments: input,
    });
    expect(structured(replay.body.result!)).toMatchObject({ ok: true, action: "session.prompt" });
    expect(harness.stub.sends).toHaveLength(1);
    expect(action).not.toHaveBeenCalled();
    const conflict = await rpc(server.getInfo()!.url, voice.token, "tools/call", {
      name: "agent_voice_chat_interrupt",
      arguments: { ...input, text: "Changed" },
    });
    expect(structured(conflict.body.result!).error?.code).toBe("request-conflict");
  });

  test("definitive refusals and ambiguous dispatch never switch an interrupt's action", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const original = harness.harness.commands.get("public_action")!;
    const attempts: string[] = [];
    let failure: "busy" | "session-idle" | "dispatch-unknown" = "busy";
    harness.harness.commands.set("public_action", async (args, context) => {
      if (args.action === "session.prompt" || args.action === "session.steer") {
        attempts.push(args.action);
        return adapterError(args.action, failure, "Scripted dispatch outcome");
      }
      return original(args, context);
    });
    for (const [state, code, action] of [
      ["idle", "busy", "session.prompt"],
      ["working", "session-idle", "session.steer"],
      ["idle", "dispatch-unknown", "session.prompt"],
    ] as const) {
      failure = code;
      setActivity(
        harness.service,
        "claude",
        harness.tabId,
        harness.providerSessionId,
        state,
        harness.environmentId,
      );
      const input = {
        projectId: harness.projectId,
        text: "Check build",
        requestId: `refused-${code}`,
      };
      expect(
        structured(await harness.call(voice.token, "agent_voice_chat_interrupt", input)).error
          ?.code,
      ).toBe(code);
      setActivity(
        harness.service,
        "claude",
        harness.tabId,
        harness.providerSessionId,
        state === "idle" ? "working" : "idle",
        harness.environmentId,
      );
      expect(
        structured(await harness.call(voice.token, "agent_voice_chat_interrupt", input)).error
          ?.code,
      ).toBe(code);
      expect(attempts.splice(0)).toEqual([action, action]);
    }
    expect(harness.stub.sends).toHaveLength(0);
  });

  test("durable binding capacity refuses new keys while retaining existing choices", async () => {
    const harness = await open();
    const storage = harness.harness.storage.publicOperations;
    const input = {
      ownerId: "voice",
      requestId: "original",
      fingerprint: "hash",
      choice: { sessionId: "original-target", action: "session.prompt" as const },
    };
    storage.bindVoiceInterrupt(input);
    const bindings = readStoredValue<Record<string, unknown>>(
      harness.harness.dataDir,
      "control-mcp-voice-interrupts.json",
    )!;
    for (let i = 0; i < 8191; i++)
      bindings[`filler-${i}`] = {
        fingerprint: "hash",
        sessionId: "later-target",
        action: "session.stop",
      };
    seedStore(harness.harness.dataDir, "control-mcp-voice-interrupts.json", bindings);
    expect(() => storage.bindVoiceInterrupt({ ...input, requestId: "overflow" })).toThrow(
      "storage is full",
    );
    expect(
      storage.bindVoiceInterrupt({
        ...input,
        choice: { sessionId: "new-target", action: "session.steer" },
      }),
    ).toMatchObject({ sessionId: "original-target", action: "session.prompt" });
    expect(() => storage.bindVoiceInterrupt({ ...input, fingerprint: "changed" })).toThrow(
      "different interrupt",
    );
    expect(
      storage.bindVoiceInterrupt({ ...input, ownerId: "other", choice: undefined }),
    ).toBeNull();
  });

  test("failed context reads are omitted without preventing a spoken reply", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const first = structured(
      await harness.call(voice.token, "agent_voice_chat_say", {
        projectId: harness.projectId,
        text: "One",
        requestId: "first",
      }),
    );
    const original = harness.harness.commands.get("public_action")!;
    harness.harness.commands.set("public_action", async (args, context) => {
      if (["project.get", "attention.list", "session.transcript"].includes(String(args.action)))
        throw new Error("private failed read");
      return original(args, context);
    });
    const result = structured(
      await harness.call(voice.token, "agent_voice_chat_say", {
        chatId: first.result!.chatId,
        text: "Two",
        requestId: "second",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.result!.state).toBe("idle");
    const prompt = harness.replies.mock.calls.at(-1)![0].prompt;
    expect(prompt).toContain("Project: unnamed");
    expect(prompt).not.toContain("private failed read");
    expect(prompt).not.toContain("Coordinator said:");
  });

  test("stop ends the coordinator's running turn", async () => {
    const harness = await open();
    setActivity(
      harness.service,
      "claude",
      harness.tabId,
      harness.providerSessionId,
      "working",
      harness.environmentId,
    );
    const voice = await harness.credential("voice");
    const stopped = await harness.call(voice.token, "agent_voice_chat_interrupt", {
      projectId: harness.projectId,
      mode: "stop",
      requestId: "stop-1",
    });
    expect(structured(stopped)).toMatchObject({ ok: true, action: "session.stop" });
    expect(spoken(stopped)).toStartWith("Stopping the coordinator's turn.");
    expect(harness.stub.provider.abort).toHaveBeenCalled();
  });

  test("a message needs words, and a project without a coordinator has nothing to interrupt", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const empty = structured(
      await harness.call(voice.token, "agent_voice_chat_interrupt", {
        projectId: harness.projectId,
        requestId: "empty-1",
      }),
    );
    expect(empty.error?.code).toBe("empty-input");
    await harness.harness.storage.coordinators.mutateCoordinatorWorkspace(
      harness.projectId,
      (current) => ({
        ...current!,
        conversations: current!.conversations.map((conversation) => ({
          ...conversation,
          closedAt: new Date(0).toISOString(),
        })),
      }),
    );
    const none = await harness.call(voice.token, "agent_voice_chat_interrupt", {
      projectId: harness.projectId,
      text: "Stop.",
      requestId: "none-1",
    });
    expect(structured(none).error?.code).toBe("not-found");
    expect(spoken(none)).toStartWith("The coordinator is not running");
    expect(harness.stub.sends).toHaveLength(0);
  });
});
