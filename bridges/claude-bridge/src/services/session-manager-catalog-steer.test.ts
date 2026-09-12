import { afterEach, describe, expect, test } from "bun:test";
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

  test("splits the live stream so post-steer assistant text is a new row", async () => {
    const session = createSession("Live split");
    track(session.id);
    const prompt = sendPrompt(session.id, "Write the plan");
    const call = await nextQueryCall();
    session.queryControl = {
      ...session.queryControl,
      pushInput: () => true,
    };
    const expectedRunId = String(session.latestTurnGeneration ?? "");

    call.push({
      type: "stream_event",
      uuid: "split-start",
      event: {
        type: "message_start",
        message: { id: "msg-split", model: "claude-opus-test" },
      },
    });
    call.push({
      type: "stream_event",
      uuid: "split-block",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    });
    call.push({
      type: "stream_event",
      uuid: "split-before",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "before steer" },
      },
    });

    await waitFor(() =>
      getSessionMessages(session.id).some((message) => message.content === "before steer"),
    );

    expect(
      await steerClaudeSession(session.id, "narrow the scope", "steer-live", expectedRunId),
    ).toBe("applied");

    call.push({
      type: "stream_event",
      uuid: "split-after",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "after steer" },
      },
    });
    call.push({
      type: "assistant",
      uuid: "split-final",
      message: {
        id: "msg-split",
        model: "claude-opus-test",
        content: [{ type: "text", text: "after steer" }],
      },
    });
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;

    const transcript = getSessionMessages(session.id);
    expect(transcript.map((message) => ({ role: message.role, content: message.content }))).toEqual(
      [
        { role: "user", content: "Write the plan" },
        { role: "assistant", content: "before steer" },
        { role: "user", content: "narrow the scope" },
        { role: "assistant", content: "after steer" },
      ],
    );
    expect(transcript[1]?.id).not.toBe(transcript[3]?.id);
    expect(transcript[3]?.content).not.toContain("before steer");
  });
});
