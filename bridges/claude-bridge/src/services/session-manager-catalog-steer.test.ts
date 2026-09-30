import { afterEach, describe, expect, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import {
  createSession,
  evictIdleHydratedTranscripts,
  getPromptDispatchState,
  getSessionMessages,
  hydratePersistedSessionMessages,
  IDLE_TRANSCRIPT_EVICTION_MS,
  nextQueryCall,
  persistSessionMetadata,
  readSessionPreferences,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import {
  answerIdleSteerPrompt,
  readClaudeSteerDispatch,
  sessions,
  setClaudeSteerTestHooks,
  steerClaudeSession,
} from "./session-manager.js";
import { steerJournalMapFromPreferences } from "./session-preferences.js";
import { sdkSessionIdFromBridgeId } from "./session-manager-core.js";

afterEach(() => {
  setClaudeSteerTestHooks();
});

describe("Claude steer journal and transcript", () => {
  test("pushes once, records the user row, and is idempotent for the same request", async () => {
    const session = createSession("Steer");
    track(session.id);
    const pushed: unknown[] = [];
    session.status = "running";
    session.latestTurnGeneration = 7;
    session.queryControl = {
      pushInput: (message) => {
        pushed.push(message);
        return true;
      },
    };

    expect(await steerClaudeSession(session.id, "narrow the scope", "steer-1", "7")).toBe(
      "applied",
    );
    expect(await steerClaudeSession(session.id, "narrow the scope", "steer-1", "7")).toBe(
      "applied",
    );
    expect(pushed).toHaveLength(1);
    expect(readClaudeSteerDispatch(session.id, "steer-1")).toBe("dispatched");
    expect(session.messages).toEqual([
      expect.objectContaining({
        id: "steer:steer-1",
        role: "user",
        content: "narrow the scope",
      }),
    ]);
  });

  test("refuses a reused request id that carries different text", async () => {
    const session = createSession("Steer conflict");
    track(session.id);
    session.status = "running";
    session.latestTurnGeneration = 3;
    session.queryControl = { pushInput: () => true };

    expect(await steerClaudeSession(session.id, "first", "steer-dup", "3")).toBe("applied");
    expect(await steerClaudeSession(session.id, "second", "steer-dup", "3")).toBe("unknown");
    expect(session.messages).toHaveLength(1);
  });

  test("answers idle when nothing is running and does not invent a turn", async () => {
    const session = createSession("Idle steer");
    track(session.id);
    expect(await steerClaudeSession(session.id, "too late", "steer-idle", "1")).toBe("idle");
    expect(readClaudeSteerDispatch(session.id, "steer-idle")).toBe("absent");
    expect(session.messages).toEqual([]);
  });

  test("pins the expected run and splits the live assistant row", async () => {
    const session = createSession("Split");
    track(session.id);
    const splits: string[] = [];
    session.status = "running";
    session.latestTurnGeneration = 2;
    session.queryControl = { pushInput: () => true };
    session.splitAssistantAfterSteer = () => {
      splits.push("split");
    };

    expect(await steerClaudeSession(session.id, "stop", "steer-split", "1")).toBe("mismatch");
    expect(await steerClaudeSession(session.id, "stop", "steer-split", "2")).toBe("applied");
    expect(splits).toEqual(["split"]);
    expect(session.steerJournal?.get("steer-split")?.inputDigest).toBe(
      createHash("sha256").update("stop").digest("hex"),
    );
  });

  test("does not push before a durable session key exists", async () => {
    const session = createSession("No key");
    track(session.id);
    sessions.delete(session.id);
    session.id = "not-a-uuid";
    session.sdkSessionId = undefined;
    sessions.set(session.id, session);
    session.status = "running";
    session.latestTurnGeneration = 1;
    const pushed: unknown[] = [];
    session.queryControl = {
      pushInput: (message) => {
        pushed.push(message);
        return true;
      },
    };

    expect(await steerClaudeSession(session.id, "too soon", "steer-early", "1")).toBe("unknown");
    expect(pushed).toEqual([]);
  });

  test("persists prepared before push and never redispatches after process-loss windows", async () => {
    const session = createSession("Durable steer");
    track(session.id);
    session.status = "running";
    session.latestTurnGeneration = 4;
    const pushed: unknown[] = [];
    session.queryControl = {
      pushInput: (message) => {
        pushed.push(message);
        return true;
      },
    };
    const sdkSessionId = sdkSessionIdFromBridgeId(session.id)!;

    let lostBeforePush = false;
    setClaudeSteerTestHooks({
      afterPersistPrepared: async () => {
        if (!lostBeforePush) {
          lostBeforePush = true;
          throw new Error("process lost after prepared write");
        }
      },
    });
    await expect(steerClaudeSession(session.id, "narrow", "steer-loss", "4")).rejects.toThrow(
      "process lost after prepared write",
    );
    expect(pushed).toEqual([]);
    expect((await readSessionPreferences(sdkSessionId))?.steerJournal?.[0]?.state).toBe("prepared");

    setClaudeSteerTestHooks();
    expect(await steerClaudeSession(session.id, "narrow", "steer-loss", "4")).toBe("unknown");
    expect(pushed).toEqual([]);

    session.steerJournal = undefined;
    setClaudeSteerTestHooks({ failPersistDispatched: true });
    expect(await steerClaudeSession(session.id, "other", "steer-after-push", "4")).toBe("unknown");
    expect(pushed).toHaveLength(1);
    expect(session.steerJournal?.get("steer-after-push")?.state).toBe("prepared");
    expect(await steerClaudeSession(session.id, "other", "steer-after-push", "4")).toBe("unknown");
    expect(pushed).toHaveLength(1);
  });

  test("restores the journal from preferences and refuses to push a retried id", async () => {
    const session = createSession("Restore journal");
    track(session.id);
    session.status = "running";
    session.latestTurnGeneration = 9;
    const pushed: unknown[] = [];
    session.queryControl = {
      pushInput: (message) => {
        pushed.push(message);
        return true;
      },
    };

    expect(await steerClaudeSession(session.id, "keep going", "steer-restore", "9")).toBe(
      "applied",
    );
    const sdkSessionId = sdkSessionIdFromBridgeId(session.id)!;
    const stored = await readSessionPreferences(sdkSessionId);
    session.steerJournal = steerJournalMapFromPreferences(stored?.steerJournal);
    expect(await steerClaudeSession(session.id, "keep going", "steer-restore", "9")).toBe(
      "applied",
    );
    expect(pushed).toHaveLength(1);
  });

  test("writes an idle /steer as a local transcript pair", async () => {
    const session = createSession("Local idle");
    track(session.id);
    const reply = await answerIdleSteerPrompt(session, "/steer keep going");
    expect(reply).toContain("no active Claude turn to steer");
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1]?.content).toContain("no active Claude turn to steer");
  });

  test("keeps the idle /steer pair across eviction and hydrate", async () => {
    const session = createSession("Idle persist");
    track(session.id);
    session.sdkSessionId = sdkSessionIdFromBridgeId(session.id) ?? undefined;
    session.persistedMessagesLoaded = true;
    session.lastAccessedAt = Date.now() - IDLE_TRANSCRIPT_EVICTION_MS - 1;
    await answerIdleSteerPrompt(session, "/steer keep going", "idle-persist");
    await persistSessionMetadata(session);

    expect(evictIdleHydratedTranscripts(Date.now())).toContain(session.id);
    expect(session.messages).toEqual([]);

    session.persistedMessagesLoaded = false;
    const messages = await hydratePersistedSessionMessages(session.id);
    expect(messages.map((message) => message.id)).toEqual([
      "idle-steer:idle-persist",
      "idle-steer-reply:idle-persist",
    ]);
  });

  test("records the idle /steer request id so a retry does not append again", async () => {
    const session = createSession("Idle journal");
    track(session.id);
    await answerIdleSteerPrompt(session, "/steer keep going", "idle-steer");
    await answerIdleSteerPrompt(session, "/steer keep going", "idle-steer");
    expect(session.messages).toHaveLength(2);
    expect(getPromptDispatchState(session.id, "idle-steer")).toBe("already-processed");
  });

  const textStream = (messageId: string, index: number, text: string) => [
    {
      type: "stream_event",
      event: { type: "message_start", message: { id: messageId, model: "claude-opus-test" } },
      parent_tool_use_id: null,
    },
    {
      type: "stream_event",
      event: { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      parent_tool_use_id: null,
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
    },
  ];
  const finalText = (messageId: string, text: string) => ({
    type: "assistant",
    message: { id: messageId, model: "claude-opus-test", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  });

  /** Start a turn, stream its first text, and steer it. */
  async function steerAfterFirstText(title: string) {
    const session = createSession(title);
    track(session.id);
    const prompt = sendPrompt(session.id, "Write the plan");
    const call = await nextQueryCall();
    const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    const first = await input.next();
    if (first.done) throw new Error("Held prompt closed before sending its user message");
    for (const frame of textStream("msg-plan", 0, "before steer")) call.push(frame);
    await waitFor(() =>
      getSessionMessages(session.id).some((message) => message.content === "before steer"),
    );
    const steerId = "steer-live";
    expect(
      await steerClaudeSession(
        session.id,
        "narrow the scope",
        steerId,
        String(session.latestTurnGeneration ?? ""),
      ),
    ).toBe("applied");
    const finish = async () => {
      call.push({
        type: "result",
        subtype: "success",
        result_index: 1,
        user_message_uuids: [steerId],
      });
      call.finish();
      await prompt;
      return getSessionMessages(session.id);
    };
    return { session, call, promptUuid: first.value.uuid!, finish };
  }

  test("keeps the interrupted message on its row and starts the steer's reply on a new one", async () => {
    const { call, promptUuid, finish } = await steerAfterFirstText("Live split");

    // CLI 2.1.284 aborts the interrupted message and writes its final record
    // only now, after the steer, then answers the steer in a new API message.
    call.push(finalText("msg-plan", "before steer"));
    call.push({
      type: "result",
      subtype: "success",
      result_index: 0,
      terminal_reason: "aborted_streaming",
      user_message_uuids: [promptUuid],
    });
    for (const frame of textStream("msg-steer", 0, "after steer")) call.push(frame);
    call.push(finalText("msg-steer", "after steer"));
    const transcript = await finish();

    expect(transcript.map((message) => ({ role: message.role, content: message.content }))).toEqual(
      [
        { role: "user", content: "Write the plan" },
        { role: "assistant", content: "before steer" },
        { role: "user", content: "narrow the scope" },
        { role: "assistant", content: "after steer" },
      ],
    );
    expect(transcript[1]?.id).not.toBe(transcript[3]?.id);
  });

  test("keeps blocks the in-flight message streams after a steer on the pre-steer row", async () => {
    const { call, finish } = await steerAfterFirstText("Continued split");

    // Anything more from the message under way was produced without the steer;
    // only the next API message can have seen it.
    call.push({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } },
      parent_tool_use_id: null,
    });
    call.push(finalText("msg-plan", "before steer!"));
    for (const frame of textStream("msg-steer", 0, "after steer")) call.push(frame);
    call.push(finalText("msg-steer", "after steer"));
    const transcript = await finish();

    expect(transcript.map((message) => message.content)).toEqual([
      "Write the plan",
      "before steer!",
      "narrow the scope",
      "after steer",
    ]);
  });

  // The frames CLI 2.1.284 sends for a `priority: "now"` steer: a result for
  // the interrupted prompt, then the steer's own turn and result.
  const interruptedPromptResults = {
    "mid-thinking": {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
      result_index: 0,
      terminal_reason: "aborted_streaming",
    },
    "mid-text": {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "The plan so far",
      result_index: 0,
      terminal_reason: "aborted_streaming",
    },
  } as const;

  for (const [phase, interrupted] of Object.entries(interruptedPromptResults)) {
    test(`keeps the turn running through a steer that interrupts ${phase}`, async () => {
      const session = createSession(`Steer ${phase}`);
      track(session.id);
      const prompt = sendPrompt(session.id, "Write the plan");
      const call = await nextQueryCall();
      const input = (call.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      const first = await input.next();
      if (first.done) throw new Error("Held prompt closed before sending its user message");
      const promptUuid = first.value.uuid!;
      let inputClosed = false;
      const steerInput = input.next();

      call.push({
        type: "stream_event",
        uuid: "thinking-start",
        event: { type: "message_start", message: { id: "msg-plan", model: "claude-opus-test" } },
      });
      const steerId = "7d5c79f1-a6bd-4b8e-8e94-7b291d9eaf48";
      expect(
        await steerClaudeSession(
          session.id,
          "the game is called Open Battle Master",
          steerId,
          String(session.latestTurnGeneration ?? ""),
        ),
      ).toBe("applied");
      const steered = await steerInput;
      expect(steered.done ? undefined : steered.value.uuid).toBe(steerId);
      const inputCompletion = input.next().then((result) => {
        inputClosed = result.done === true;
      });

      call.push({
        ...interrupted,
        user_message_uuid: promptUuid,
        user_message_uuids: [promptUuid],
      });
      call.push({
        type: "assistant",
        uuid: "steer-reply",
        message: {
          id: "msg-steer",
          model: "claude-opus-test",
          content: [{ type: "text", text: "Noted: Open Battle Master." }],
        },
        parent_tool_use_id: null,
      });
      await waitFor(() =>
        getSessionMessages(session.id).some(
          (message) => message.content === "Noted: Open Battle Master.",
        ),
      );
      expect(sessions.get(session.id)?.status).toBe("running");
      expect(inputClosed).toBe(false);

      call.push({
        type: "result",
        subtype: "success",
        is_error: false,
        result_index: 1,
        user_message_uuid: steerId,
        user_message_uuids: [steerId],
      });
      await waitFor(() => inputClosed);
      await inputCompletion;
      call.finish();
      await prompt;

      expect(sessions.get(session.id)?.status).toBe("idle");
      const transcript = getSessionMessages(session.id);
      expect(transcript.filter((message) => message.role === "user").map((m) => m.content)).toEqual(
        ["Write the plan", "the game is called Open Battle Master"],
      );
      expect(transcript.at(-1)?.content).toBe("Noted: Open Battle Master.");
      // The prompt keeps its own transcript uuid; the steer's is not it.
      expect(transcript[0]?.sdkUuid).toBe(promptUuid);
    });
  }
});
