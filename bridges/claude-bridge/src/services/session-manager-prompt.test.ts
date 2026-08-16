import { describe, expect, jest, mock, test } from "bun:test";
import type { MessagePatchEventData, NormalizedPart, SSEEvent, SessionUsageSnapshot } from "../types/index.js";
import { MAX_DIFF_SIDE_BYTES, MAX_TOOL_TEXT_BYTES, TRUNCATED_NOTICE } from "./part-budget.js";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_STREAM_CONTENT_BLOCK_INDEX,
  abortSession,
  captureEvents,
  createSession,
  deleteSession,
  eventEmitter,
  getPromptDispatchRecordCountForTesting,
  getPromptDispatchState,
  getSession,
  getSessionInitData,
  getSessionMessages,
  mockGetMcpServerNames,
  mockGetMcpServersForSdk,
  mockGetPluginsForSdk,
  mockQuery,
  nextQueryCall,
  queryControlOverrides,
  readSdkPrompt,
  runPromptWithMessages,
  seedSettledPromptDispatchForTesting,
  sendPrompt,
  track,
  waitFor,
  withControlledNewDate,
  withWorkspaceCwd,
} from "./session-manager-test-harness.js";


// ---------------------------------------------------------------------------
// sendPrompt — happy path, errors, abort, init
// ---------------------------------------------------------------------------

describe("sendPrompt", () => {
  test("passes the current managed GitHub credential only to the SDK query", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-query-github-env-"));
    const credentialFile = join(directory, "github-token");
    const credentialFileEnv = "ORKESTRATOR_GITHUB_CREDENTIAL_FILE";
    const originalCredentialFile = process.env[credentialFileEnv];
    const originalGitHubToken = process.env.GITHUB_TOKEN;
    const originalGhToken = process.env.GH_TOKEN;
    process.env[credentialFileEnv] = credentialFile;
    process.env.GITHUB_TOKEN = "stale-bridge-token";
    process.env.GH_TOKEN = "stale-bridge-token";

    try {
      await writeFile(credentialFile, "managed-query-token");
      const { call } = await runPromptWithMessages([
        { type: "result", subtype: "success" },
      ]);

      expect(call.options.env).toMatchObject({
        GITHUB_TOKEN: "managed-query-token",
        GH_TOKEN: "managed-query-token",
      });
      expect(process.env.GITHUB_TOKEN).toBe("stale-bridge-token");
      expect(process.env.GH_TOKEN).toBe("stale-bridge-token");
    } finally {
      if (originalCredentialFile === undefined) delete process.env[credentialFileEnv];
      else process.env[credentialFileEnv] = originalCredentialFile;
      if (originalGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGitHubToken;
      if (originalGhToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalGhToken;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("happy path: appends user + assistant message, captures sdkSessionId, ends idle", async () => {
    const session = createSession("happy");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Hello Claude");
      const call = await nextQueryCall();
      expect(call.options.includePartialMessages).toBe(true);
      const turnStartedAt = getSession(session.id)?.turnStartedAt;
      expect(typeof turnStartedAt).toBe("string");
      expect(Date.parse(turnStartedAt!)).toBeLessThanOrEqual(Date.now());
      expect(events).toContainEqual({
        type: "session.updated",
        sessionId: session.id,
        data: {
          status: "running",
          turnStartedAt,
          completionBlockedByBackgroundTasks: false,
        },
      });

      // System init - sdkSessionId should be captured
      call.push({
        type: "system",
        subtype: "init",
        session_id: "sdk-session-xyz",
        mcp_servers: [],
        plugins: [],
        slash_commands: ["help"],
      });

      // Assistant message with text
      call.push({
        type: "assistant",
        uuid: "asst-uuid-1",
        message: {
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Hi there!" }],
        },
      });

      // Successful result
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const stored = getSession(session.id)!;
      expect(stored.status).toBe("idle");
      expect(stored.turnStartedAt).toBeUndefined();
      expect(stored.sdkSessionId).toBe("sdk-session-xyz");
      expect(stored.messages).toHaveLength(2);
      expect(stored.messages[0]?.role).toBe("user");
      expect(stored.messages[0]?.content).toBe("Hello Claude");
      expect(stored.messages[1]?.role).toBe("assistant");
      expect(stored.messages[1]?.content).toBe("Hi there!");
      expect(stored.messages[1]?.modelId).toBe("claude-sonnet-4-6");
      expect(stored.lastStreamedRevisionAt).toBeGreaterThan(0);
      expect(stored.lastStreamedRevisionAt).toBeLessThanOrEqual(Date.now());

      const initData = getSessionInitData(session.id);
      expect(initData?.slashCommands).toEqual(["help"]);

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain("session.init");
      expect(eventTypes).toContain("message.updated");
      expect(eventTypes).toContain("session.idle");
    } finally {
      stop();
    }
  });

  test("maps supported agents into the authoritative init snapshot", async () => {
    queryControlOverrides.supportedAgents = async () => [
      {
        name: "reviewer",
        description: "Reviews changes",
        model: "claude-opus-mock",
        ignoredProviderField: true,
      },
    ];

    const { session } = await runPromptWithMessages([
      {
        type: "system",
        subtype: "init",
        session_id: "sdk-agents",
        mcp_servers: [],
        plugins: [],
        slash_commands: [],
      },
      { type: "result", subtype: "success" },
    ]);

    expect(getSessionInitData(session.id)?.agents).toEqual([
      {
        name: "reviewer",
        description: "Reviews changes",
        model: "claude-opus-mock",
      },
    ]);
  });

  test("falls back to no agents when provider discovery fails", async () => {
    queryControlOverrides.supportedAgents = async () => {
      throw new Error("agent discovery failed");
    };

    const { session } = await runPromptWithMessages([
      {
        type: "system",
        subtype: "init",
        session_id: "sdk-agent-discovery-failure",
        mcp_servers: [],
        plugins: [],
        slash_commands: [],
      },
      { type: "result", subtype: "success" },
    ]);

    expect(getSessionInitData(session.id)?.agents).toEqual([]);
    expect(session.status).toBe("idle");
  });

  test("warns when a provider turn produces no messages or heartbeat", async () => {
    jest.useFakeTimers();
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      const session = createSession("quiet provider");
      track(session.id);
      const promptPromise = sendPrompt(session.id, "hello?");
      const call = await nextQueryCall();

      jest.advanceTimersByTime(30_001);
      expect(warn.mock.calls.some(
        ([message]) => String(message).includes("has not responded after 5 seconds"),
      )).toBe(true);
      expect(warn.mock.calls.some(
        ([message]) => String(message).includes("No SDK messages yet"),
      )).toBe(true);

      call.finish();
      await promptPromise;
    } finally {
      console.warn = originalWarn;
      jest.useRealTimers();
    }
  });

  test("streams partial assistant text before the final assistant message arrives", async () => {
    const session = createSession("streaming");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream please");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "partial-asst-start",
        session_id: "sdk-session-stream",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "partial-asst-1",
            model: "claude-opus-5",
          },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "partial-asst-1",
        session_id: "sdk-session-stream",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "partial-asst-1",
        session_id: "sdk-session-stream",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      });

      await waitFor(() => {
        const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
        return assistant?.content === "Hello";
      });

      const streamedEvent = events.find((event) => {
        const message = (event.data as { message?: { content?: string } } | undefined)?.message;
        return event.type === "message.updated" && message?.content === "Hello";
      });
      expect(streamedEvent).toBeDefined();
      expect(
        (
          streamedEvent?.data as { message?: { modelId?: string } } | undefined
        )?.message?.modelId,
      ).toBe("claude-opus-5");

      call.push({
        type: "assistant",
        uuid: "partial-asst-1",
        message: {
          model: "claude-opus-5",
          content: [{ type: "text", text: "Hello final" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(assistant?.content).toBe("Hello final");
      expect(assistant?.modelId).toBe("claude-opus-5");
      expect(events.some((event) => {
        const published = (
          event.data as { message?: { modelId?: string } } | undefined
        )?.message;
        return event.type === "message.updated"
          && published?.modelId === "claude-opus-5";
      })).toBe(true);
    } finally {
      stop();
    }
  });

  test("publishes model attribution when only the final assistant record supplies it", async () => {
    const session = createSession("late model metadata");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Resolve the model later");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "late-model-start",
        session_id: "sdk-session-late-model",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: { id: "late-model-assistant" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "late-model-assistant",
        session_id: "sdk-session-late-model",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "late-model-assistant",
        session_id: "sdk-session-late-model",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      });

      await waitFor(() =>
        getSessionMessages(session.id).some(
          (message) => message.role === "assistant" && message.content === "Hello",
        ),
      );
      expect(
        getSessionMessages(session.id).find((message) => message.role === "assistant")?.modelId,
      ).toBeUndefined();

      call.push({
        type: "assistant",
        uuid: "late-model-assistant",
        parent_tool_use_id: null,
        message: {
          id: "late-model-assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: "Hello final" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      const assistant = getSessionMessages(session.id).find(
        (message) => message.role === "assistant",
      );
      expect(assistant?.content).toBe("Hello final");
      expect(assistant?.modelId).toBe("claude-sonnet-5");
      expect(events.some((event) => {
        const published = (
          event.data as { message?: { modelId?: string } } | undefined
        )?.message;
        return event.type === "message.updated"
          && published?.modelId === "claude-sonnet-5";
      })).toBe(true);
    } finally {
      stop();
    }
  });

  test.each(["", "   ", "<synthetic>"])(
    "never attributes an unusable live model id %#",
    async (model) => {
      const session = createSession("invalid live model");
      track(session.id);
      const promptPromise = sendPrompt(session.id, "Stream please");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "invalid-model-start",
        session_id: "sdk-invalid-model",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: { id: "invalid-model-assistant", model },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "invalid-model-assistant",
        session_id: "sdk-invalid-model",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "invalid-model-assistant",
        session_id: "sdk-invalid-model",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
      });

      await waitFor(() =>
        getSessionMessages(session.id).some(
          (message) => message.role === "assistant" && message.content === "Hello",
        ),
      );
      expect(
        getSessionMessages(session.id).find((message) => message.role === "assistant")?.modelId,
      ).toBeUndefined();

      call.push({
        type: "assistant",
        uuid: "invalid-model-assistant",
        message: {
          model,
          content: [{ type: "text", text: "Hello final" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      expect(
        getSessionMessages(session.id).find((message) => message.role === "assistant")?.modelId,
      ).toBeUndefined();
    },
  );

  test("streams partial thinking content and preserves block order", async () => {
    const session = createSession("streaming-thinking");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Think then answer");
      const call = await nextQueryCall();

      // Thinking block at index 0.
      call.push({
        type: "stream_event",
        uuid: "partial-think-1",
        session_id: "sdk-session-think",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "partial-think-1",
        session_id: "sdk-session-think",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Reasoning..." },
        },
      });
      // Text block at index 1 - must render after the thinking block.
      call.push({
        type: "stream_event",
        uuid: "partial-think-1",
        session_id: "sdk-session-think",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        },
      });
      call.push({
        type: "stream_event",
        uuid: "partial-think-1",
        session_id: "sdk-session-think",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Answer" },
        },
      });

      await waitFor(() => {
        const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
        return assistant?.content === "Answer";
      });

      const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(assistant?.parts.map((part) => part.type)).toEqual(["thinking", "text"]);
      const thinkingPart = assistant?.parts.find((part) => part.type === "thinking");
      expect(thinkingPart?.content).toBe("Reasoning...");

      const streamedThinking = events.find((event) => {
        const message = (event.data as { message?: { parts?: { type: string; content?: string }[] } } | undefined)?.message;
        return (
          event.type === "message.updated" &&
          message?.parts?.some((part) => part.type === "thinking" && part.content === "Reasoning...")
        );
      });
      expect(streamedThinking).toBeDefined();

      call.push({
        type: "assistant",
        uuid: "partial-think-1",
        message: {
          content: [
            { type: "thinking", thinking: "Reasoning..." },
            { type: "text", text: "Answer final" },
          ],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const finalAssistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(finalAssistant?.content).toBe("Answer final");
    } finally {
      stop();
    }
  });

  test("records deterministic first-arrival timestamps for separate streamed blocks", async () => {
    const session = createSession("streaming-block-timestamps");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "Stream two blocks");
    const call = await nextQueryCall();

    await withControlledNewDate("2026-07-26T10:00:00.000Z", async (setTime) => {
      const streamEvent = (uuid: string, event: Record<string, unknown>) => {
        call.push({
          type: "stream_event",
          uuid,
          session_id: "sdk-session-block-times",
          parent_tool_use_id: null,
          event,
        });
      };

      streamEvent("block-message-start", {
        type: "message_start",
        message: { id: "msg_block_times", role: "assistant", content: [] },
      });
      streamEvent("block-0-start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "First" },
      });
      await waitFor(() => {
        const parts = getSessionMessages(session.id).find((message) => message.role === "assistant")?.parts;
        return parts?.[0]?.content === "First";
      });

      setTime("2026-07-26T10:03:00.000Z");
      streamEvent("block-1-start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "Second" },
      });
      await waitFor(() => {
        const parts = getSessionMessages(session.id).find((message) => message.role === "assistant")?.parts;
        return parts?.[1]?.content === "Second";
      });

      const parts = getSessionMessages(session.id).find((message) => message.role === "assistant")?.parts;
      expect(parts?.map((part) => part.createdAt)).toEqual([
        "2026-07-26T10:00:00.000Z",
        "2026-07-26T10:03:00.000Z",
      ]);

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;
    });
  });

  test("preserves a thinking block start timestamp across deltas and final replacement", async () => {
    const session = createSession("streaming-thinking-timestamp");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "Think carefully");
    const call = await nextQueryCall();

    await withControlledNewDate("2026-07-26T11:00:00.000Z", async (setTime) => {
      const streamEvent = (uuid: string, event: Record<string, unknown>) => {
        call.push({
          type: "stream_event",
          uuid,
          session_id: "sdk-session-thinking-time",
          parent_tool_use_id: null,
          event,
        });
      };

      streamEvent("thinking-message-start", {
        type: "message_start",
        message: { id: "msg_thinking_time", role: "assistant", content: [] },
      });
      streamEvent("thinking-block-start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      });
      streamEvent("thinking-delta-1", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Initial" },
      });
      await waitFor(() => {
        const part = getSessionMessages(session.id)
          .find((message) => message.role === "assistant")
          ?.parts.find((candidate) => candidate.type === "thinking");
        return part?.content === "Initial";
      });

      setTime("2026-07-26T11:01:00.000Z");
      streamEvent("thinking-delta-2", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: " reasoning" },
      });
      await waitFor(() => {
        const part = getSessionMessages(session.id)
          .find((message) => message.role === "assistant")
          ?.parts.find((candidate) => candidate.type === "thinking");
        return part?.content === "Initial reasoning";
      });

      setTime("2026-07-26T11:02:00.000Z");
      call.push({
        type: "assistant",
        uuid: "thinking-final",
        message: {
          id: "msg_thinking_time",
          content: [{ type: "thinking", thinking: "Final reasoning" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      const thinkingPart = getSessionMessages(session.id)
        .find((message) => message.role === "assistant")
        ?.parts.find((candidate) => candidate.type === "thinking");
      expect(thinkingPart).toMatchObject({
        content: "Final reasoning",
        createdAt: "2026-07-26T11:00:00.000Z",
      });
    });
  });

  test("timestamps a delta that arrives without a content block start", async () => {
    const session = createSession("streaming-delta-fallback");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "Stream without start");
    const call = await nextQueryCall();

    await withControlledNewDate("2026-07-26T12:00:00.000Z", async () => {
      call.push({
        type: "stream_event",
        uuid: "delta-without-start",
        session_id: "sdk-session-delta-fallback",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Recovered text" },
        },
      });
      await waitFor(() => {
        const assistant = getSessionMessages(session.id).find((message) => message.role === "assistant");
        return assistant?.content === "Recovered text";
      });

      const textPart = getSessionMessages(session.id)
        .find((message) => message.role === "assistant")
        ?.parts.find((part) => part.type === "text");
      expect(textPart?.createdAt).toBe("2026-07-26T12:00:00.000Z");

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;
    });
  });

  test("timestamps a final-only assistant block when no stream events arrived", async () => {
    const session = createSession("final-only-timestamp");
    track(session.id);
    const promptPromise = sendPrompt(session.id, "Answer without streaming");
    const call = await nextQueryCall();

    await withControlledNewDate("2026-07-26T13:00:00.000Z", async () => {
      call.push({
        type: "assistant",
        uuid: "final-only",
        message: {
          id: "msg_final_only",
          content: [{ type: "text", text: "Final answer" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      const textPart = getSessionMessages(session.id)
        .find((message) => message.role === "assistant")
        ?.parts.find((part) => part.type === "text");
      expect(textPart).toMatchObject({
        content: "Final answer",
        createdAt: "2026-07-26T13:00:00.000Z",
      });
    });
  });

  // The real SDK gives every `stream_event` its own random uuid and emits one
  // non-streaming `assistant` message per content block, all sharing
  // `message.id`. Grouping by uuid therefore produced one part per delta plus a
  // duplicate copy of the finished block. These tests use that real shape.
  test("merges deltas that each arrive with a unique stream_event uuid", async () => {
    const session = createSession("streaming-unique-uuids");
    track(session.id);

    const { stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream please");
      const call = await nextQueryCall();

      const streamEvent = (uuid: string, event: Record<string, unknown>) => {
        call.push({
          type: "stream_event",
          uuid,
          session_id: "sdk-session-unique",
          parent_tool_use_id: null,
          event,
        });
      };

      streamEvent("evt-1", {
        type: "message_start",
        message: { id: "msg_stream_1", role: "assistant", content: [] },
      });
      streamEvent("evt-2", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      });
      streamEvent("evt-3", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "I" },
      });
      streamEvent("evt-4", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "'ll check the repo" },
      });
      streamEvent("evt-5", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: " state." },
      });
      streamEvent("evt-6", { type: "content_block_stop", index: 0 });
      streamEvent("evt-7", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      });
      streamEvent("evt-8", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Test suite is still" },
      });
      streamEvent("evt-9", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: " running." },
      });

      await waitFor(() => {
        const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
        return assistant?.content === "Test suite is still running.";
      });

      const streamed = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(streamed?.parts.map((part) => part.type)).toEqual(["thinking", "text"]);
      expect(streamed?.parts[0]?.content).toBe("I'll check the repo state.");
      expect(streamed?.parts[1]?.content).toBe("Test suite is still running.");

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;
    } finally {
      stop();
    }
  });

  test("final per-block assistant messages replace streamed blocks instead of duplicating them", async () => {
    const session = createSession("streaming-final-blocks");
    track(session.id);

    const { stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Think then answer");
      const call = await nextQueryCall();

      const streamEvent = (uuid: string, event: Record<string, unknown>) => {
        call.push({
          type: "stream_event",
          uuid,
          session_id: "sdk-session-final",
          parent_tool_use_id: null,
          event,
        });
      };

      streamEvent("s-1", {
        type: "message_start",
        message: { id: "msg_final_1", role: "assistant", content: [] },
      });
      streamEvent("s-2", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      });
      streamEvent("s-3", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Reasoning" },
      });
      streamEvent("s-4", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      });
      streamEvent("s-5", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Ans" },
      });

      await waitFor(() => {
        const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
        return assistant?.content === "Ans";
      });
      const streamedTextTimestamp = getSessionMessages(session.id)
        .find((m) => m.role === "assistant")
        ?.parts.find((part) => part.type === "text")
        ?.createdAt;
      expect(Number.isFinite(new Date(streamedTextTimestamp ?? "").getTime())).toBe(true);

      // The SDK emits one assistant message per content block, each with a fresh
      // uuid but the same API `message.id`.
      call.push({
        type: "assistant",
        uuid: "final-uuid-a",
        message: {
          id: "msg_final_1",
          content: [{ type: "thinking", thinking: "Reasoning complete." }],
        },
      });
      call.push({
        type: "assistant",
        uuid: "final-uuid-b",
        message: {
          id: "msg_final_1",
          content: [{ type: "text", text: "Answer final" }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(assistant?.parts.map((part) => part.type)).toEqual(["thinking", "text"]);
      expect(assistant?.parts[0]?.content).toBe("Reasoning complete.");
      expect(assistant?.parts[1]?.content).toBe("Answer final");
      expect(assistant?.parts[1]?.createdAt).toBe(streamedTextTimestamp);
      expect(assistant?.content).toBe("Answer final");
    } finally {
      stop();
    }
  });

  test("keeps chronological order across api messages in a think → tool → answer turn", async () => {
    const session = createSession("streaming-multi-message");
    track(session.id);

    const { stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Run a command");
      const call = await nextQueryCall();

      const streamEvent = (uuid: string, event: Record<string, unknown>) => {
        call.push({
          type: "stream_event",
          uuid,
          session_id: "sdk-session-multi",
          parent_tool_use_id: null,
          event,
        });
      };

      // First API message: thinking (index 0) then a tool_use (index 1).
      streamEvent("m-1", {
        type: "message_start",
        message: { id: "msg_multi_1", role: "assistant", content: [] },
      });
      streamEvent("m-2", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      });
      streamEvent("m-3", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Need the repo state." },
      });
      call.push({
        type: "assistant",
        uuid: "multi-final-1",
        message: {
          id: "msg_multi_1",
          content: [{ type: "thinking", thinking: "Need the repo state." }],
        },
      });
      call.push({
        type: "assistant",
        uuid: "multi-final-2",
        message: {
          id: "msg_multi_1",
          content: [
            {
              type: "tool_use",
              id: "tool-multi-1",
              name: "Bash",
              input: { command: "git status --porcelain" },
            },
          ],
        },
      });
      streamEvent("m-4", { type: "message_stop" });

      call.push({
        type: "user",
        uuid: "multi-user-1",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-multi-1", content: "clean" },
          ],
        },
      });

      // Second API message: the answer text.
      streamEvent("m-5", {
        type: "message_start",
        message: { id: "msg_multi_2", role: "assistant", content: [] },
      });
      streamEvent("m-6", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      streamEvent("m-7", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Working tree is clean." },
      });
      call.push({
        type: "assistant",
        uuid: "multi-final-3",
        message: {
          id: "msg_multi_2",
          content: [{ type: "text", text: "Working tree is clean." }],
        },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();

      await promptPromise;

      const assistant = getSessionMessages(session.id).find((m) => m.role === "assistant");
      expect(assistant?.parts.map((part) => part.type)).toEqual([
        "thinking",
        "tool-invocation",
        "text",
      ]);
      expect(assistant?.parts[0]?.content).toBe("Need the repo state.");
      expect(assistant?.parts[2]?.content).toBe("Working tree is clean.");
      expect(
        Number.isFinite(new Date(assistant?.parts[2]?.createdAt ?? "").getTime()),
      ).toBe(true);
      expect(assistant?.content).toBe("Working tree is clean.");
    } finally {
      stop();
    }
  });

  test("rejects a second prompt while the session is already running", async () => {
    const session = createSession("busy");
    track(session.id);

    const first = sendPrompt(session.id, "first");
    const call = await nextQueryCall();

    await expect(sendPrompt(session.id, "second")).rejects.toThrow(/already processing/);

    call.finish();
    await first;
  });

  test("throws when the session id is unknown", async () => {
    await expect(sendPrompt("session-missing", "hi")).rejects.toThrow(/not found/);
  });

  test("query failure leaves session in error state and emits session.error", async () => {
    const session = createSession("will-fail");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "boom");
      const call = await nextQueryCall();
      call.fail(new Error("SDK exploded"));

      await expect(promptPromise).rejects.toThrow(/SDK exploded/);

      const stored = getSession(session.id)!;
      expect(stored.status).toBe("error");
      expect(stored.turnStartedAt).toBeUndefined();
      expect(stored.error).toBe("SDK exploded");

      const errorEvent = events.find((e) => e.type === "session.error" && e.sessionId === session.id);
      expect(errorEvent).toBeDefined();
      expect((errorEvent?.data as { error?: string })?.error).toBe("SDK exploded");
    } finally {
      stop();
    }
  });

  // -------------------------------------------------------------------------
  // Streamed-delta coalescing
  // -------------------------------------------------------------------------
  //
  // Deltas accumulate immediately but the expensive snapshot (ordered-part
  // rebuild + full-message emit) is deferred by STREAM_EVENT_COALESCE_MS. These
  // tests pin the two properties that makes safe: nothing is lost on any exit
  // path, and non-delta messages still observe the deltas that preceded them.

  const textDelta = (uuid: string, text: string) => ({
    type: "stream_event",
    uuid,
    session_id: "sdk-session-coalesce",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  });

  const assistantContent = (sessionId: string): string | undefined =>
    getSessionMessages(sessionId).find((m) => m.role === "assistant")?.content;

  /**
   * Reconstructs the assistant content a subscriber holds after each frame.
   *
   * A turn publishes one `message.updated` and then patches it, so neither
   * event type alone shows the sequence the client sees. This applies both the
   * way the client does — including deriving `content` from the text parts,
   * which is what lets a patch avoid re-sending it.
   *
   * `message.updated` carries the live `NormalizedMessage`, which keeps
   * mutating as the turn proceeds, so content is snapshotted at emit time.
   */
  function captureAssistantContentFrames(): { frames: string[]; stop: () => void } {
    const frames: string[] = [];
    let parts: NormalizedPart[] = [];

    const contentOf = (current: NormalizedPart[]) =>
      current
        .filter((part) => part.type === "text")
        .map((part) => part.content ?? "")
        .join("");

    const stop = eventEmitter.subscribe((event) => {
      if (event.type === "message.updated") {
        const message = (event.data as {
          message?: { role?: string; content?: string; parts?: NormalizedPart[] };
        }).message;
        if (message?.role !== "assistant") return;
        parts = (message.parts ?? []).slice();
        frames.push(message.content ?? "");
        return;
      }

      if (event.type !== "message.patched") return;
      const patch = event.data as MessagePatchEventData;
      for (const { index, part } of patch.changedParts) parts[index] = part;
      parts.length = patch.partCount;
      frames.push(contentOf(parts));
    });

    return { frames, stop };
  }

  /** Frames of either kind — what the client re-renders on. */
  const messageFrames = (events: SSEEvent[]): SSEEvent[] =>
    events.filter(
      (event) => event.type === "message.updated" || event.type === "message.patched",
    );

  /**
   * Lets the session manager drain the messages already queued on the mock
   * iterator, without reaching STREAM_EVENT_COALESCE_MS. The mock checks its
   * error/finished flags before its queue, so failing or aborting immediately
   * after a push would discard the pushed messages entirely.
   */
  const settleQueuedMessages = () => new Promise((resolve) => setTimeout(resolve, 15));

  test("coalesces a burst of deltas into a single accumulated snapshot", async () => {
    const session = createSession("coalescing");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream a burst");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "burst-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      for (const chunk of ["a", "b", "c", "d", "e"]) {
        call.push(textDelta("burst-1", chunk));
      }

      await waitFor(() => assistantContent(session.id) === "abcde");

      // The whole burst lands in one window, so it costs far fewer emits than
      // the one-per-token rebuild this replaced. Counted across both frame
      // kinds: the first publish is a full message and the rest are patches.
      const updates = messageFrames(events);
      expect(updates.length).toBeLessThan(5);
      expect(updates.length).toBeGreaterThan(0);

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;
    } finally {
      stop();
    }
  });

  test("publishes each message once in full, then only the parts that changed", async () => {
    const session = createSession("patching");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream, call a tool, stream again");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "patch-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      call.push(textDelta("patch-1", "before"));
      await waitFor(() => assistantContent(session.id) === "before");

      // A tool with a large result: the payload that made full frames O(turn
      // size) and must therefore appear in exactly one frame, not all of them.
      const bulkyOutput = "x".repeat(50_000);
      call.push({
        type: "assistant",
        message: {
          id: "patch-1",
          content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/a.ts" } }],
        },
      });
      call.push({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: bulkyOutput }],
        },
      });
      await waitFor(() =>
        getSessionMessages(session.id).some((message) =>
          message.parts.some((part) => part.toolOutput === bulkyOutput),
        ),
      );

      call.push(textDelta("patch-1", " after"));
      await waitFor(() => (assistantContent(session.id) ?? "").endsWith(" after"));

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      // The prompt's own user message is published as a full frame too; this
      // is about the assistant message the turn streams into.
      const frames = messageFrames(events).filter(
        (frame) =>
          frame.type === "message.patched" ||
          (frame.data as { message?: { role?: string } }).message?.role === "assistant",
      );
      const fullFrames = frames.filter((frame) => frame.type === "message.updated");
      const patches = frames.filter((frame) => frame.type === "message.patched");
      const finalMessage = getSessionMessages(session.id).find((m) => m.role === "assistant")!;

      // One full frame for the message, and everything after it is a patch.
      expect(fullFrames).toHaveLength(1);
      expect(patches.length).toBeGreaterThan(0);
      for (const patch of patches) {
        expect((patch.data as MessagePatchEventData).messageId).toBe(finalMessage.id);
      }

      // The bulky tool output crosses the wire once. Before this change it rode
      // along in every frame emitted for the rest of the turn.
      const framesCarryingOutput = frames.filter((frame) =>
        JSON.stringify(frame.data).includes(bulkyOutput),
      );
      expect(framesCarryingOutput).toHaveLength(1);

      // Replaying the frames must land a subscriber exactly where the
      // authoritative transcript is — the patches are not allowed to lose or
      // reorder anything the full frame would have carried.
      let parts: NormalizedPart[] = [];
      for (const frame of frames) {
        if (frame.type === "message.updated") {
          parts = ((frame.data as { message: { parts: NormalizedPart[] } }).message.parts).slice();
          continue;
        }
        const patch = frame.data as MessagePatchEventData;
        for (const { index, part } of patch.changedParts) parts[index] = part;
        parts.length = patch.partCount;
      }
      expect(parts).toEqual(finalMessage.parts);
    } finally {
      stop();
    }
  });

  test("numbers every published frame so a recipient can detect a missed one", async () => {
    const session = createSession("revisions");
    track(session.id);

    // `message.updated` carries the live `NormalizedMessage`, whose revision
    // keeps advancing as the turn patches it, so the revision has to be read
    // at emit time — which is also when the SSE writer serializes it.
    const revisions: (number | undefined)[] = [];
    const stop = eventEmitter.subscribe((event) => {
      if (event.type === "message.updated") {
        const message = (event.data as {
          message?: { role?: string; revision?: number };
        }).message;
        if (message?.role !== "assistant") return;
        revisions.push(message.revision);
        return;
      }
      if (event.type !== "message.patched") return;
      revisions.push((event.data as MessagePatchEventData).revision);
    });

    try {
      const promptPromise = sendPrompt(session.id, "Stream something");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "rev-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      call.push(textDelta("rev-1", "one"));
      await waitFor(() => assistantContent(session.id) === "one");
      call.push(textDelta("rev-1", " two"));
      await waitFor(() => assistantContent(session.id) === "one two");
      call.push(textDelta("rev-1", " three"));
      await waitFor(() => assistantContent(session.id) === "one two three");

      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      // The full frame is revision 1 and every patch is exactly one more than
      // the frame before it. A recipient that sees a jump knows it missed a
      // frame — which, for an index-addressed patch, is the difference between
      // recovering and silently rendering the wrong transcript.
      expect(revisions.length).toBeGreaterThan(1);
      expect(revisions).toEqual(revisions.map((_, index) => index + 1));

      // The transcript carries the same revision the last frame announced, so
      // a client that recovers by refetching can rejoin the patch stream.
      const finalMessage = getSessionMessages(session.id).find((m) => m.role === "assistant")!;
      expect(finalMessage.revision).toBe(revisions[revisions.length - 1]);
    } finally {
      stop();
    }
  });

  test("bounds the payloads a session retains for the rest of its life", async () => {
    const session = createSession("budget");
    track(session.id);

    const promptPromise = sendPrompt(session.id, "Write a big file and read a big result");
    const call = await nextQueryCall();

    // Both fields that are unbounded by construction: the whole contents of a
    // written file, and whatever a tool chose to return.
    const hugeFile = "f".repeat(MAX_DIFF_SIDE_BYTES + 5_000);
    const hugeOutput = "o".repeat(MAX_TOOL_TEXT_BYTES + 5_000);

    call.push({
      type: "assistant",
      message: {
        id: "budget-1",
        content: [
          {
            type: "tool_use",
            id: "write-1",
            name: "Write",
            input: { file_path: "/big.ts", content: hugeFile },
          },
        ],
      },
    });
    call.push({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "write-1", content: hugeOutput }],
      },
    });
    await waitFor(() =>
      getSessionMessages(session.id).some((message) =>
        message.parts.some((part) => part.toolUseId === "write-1" && part.toolOutput),
      ),
    );

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await promptPromise;

    const part = getSessionMessages(session.id)
      .flatMap((message) => message.parts)
      .find((candidate) => candidate.toolUseId === "write-1")!;

    // Capped, not dropped: the head survives so the transcript still shows what
    // happened, and the marker says why the tail is missing.
    expect(part.toolOutput).toEndWith(TRUNCATED_NOTICE);
    expect(Buffer.byteLength(part.toolOutput!, "utf8")).toBeLessThan(
      MAX_TOOL_TEXT_BYTES + TRUNCATED_NOTICE.length + 8,
    );
    expect(part.toolDiff?.after).toEndWith(TRUNCATED_NOTICE);
    expect(Buffer.byteLength(part.toolDiff!.after!, "utf8")).toBeLessThan(
      MAX_DIFF_SIDE_BYTES + TRUNCATED_NOTICE.length + 8,
    );
    expect(part.toolDiff?.filePath).toBe("/big.ts");
  });

  test("a non-delta message observes every delta that preceded it", async () => {
    const session = createSession("coalescing-order");
    track(session.id);

    const { frames, stop } = captureAssistantContentFrames();
    try {
      const promptPromise = sendPrompt(session.id, "Stream then settle");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "order-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      call.push(textDelta("order-1", "streamed"));
      // Arrives well inside the coalescing window, so the pending snapshot has
      // not been published by the timer yet.
      call.push({
        type: "assistant",
        uuid: "order-1",
        message: { content: [{ type: "text", text: "streamed and final" }] },
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      // The flush ran before the assistant message was handled, so the streamed
      // text was published in its own frame rather than being skipped over.
      expect(frames).toContain("streamed");
      expect(frames.indexOf("streamed")).toBeLessThan(
        frames.lastIndexOf("streamed and final"),
      );
      expect(assistantContent(session.id)).toBe("streamed and final");
    } finally {
      stop();
    }
  });

  test("publishes pending deltas when the SDK stream fails mid-turn", async () => {
    const session = createSession("coalescing-failure");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream then explode");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "doomed-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      call.push(textDelta("doomed-1", "half a sentence"));
      await settleQueuedMessages();
      // Fails inside the coalescing window: without an explicit flush on the
      // error path these deltas would never reach session.messages, and the
      // user would lose the tail of a turn they had already watched stream.
      call.fail(new Error("SDK hung up"));

      await expect(promptPromise).rejects.toThrow(/SDK hung up/);

      expect(assistantContent(session.id)).toBe("half a sentence");

      // The completed message is emitted before the terminal error frame.
      const updateIndex = events.findIndex((event) => event.type === "message.updated"
        && (event.data as { message?: { role?: string } }).message?.role === "assistant");
      const errorIndex = events.findIndex((event) => event.type === "session.error");
      expect(updateIndex).toBeGreaterThanOrEqual(0);
      expect(errorIndex).toBeGreaterThanOrEqual(0);
      expect(updateIndex).toBeLessThan(errorIndex);
    } finally {
      stop();
    }
  });

  test("publishes pending deltas when the turn is aborted mid-stream", async () => {
    const session = createSession("coalescing-abort");
    track(session.id);

    const { stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "Stream then abort");
      const call = await nextQueryCall();

      call.push({
        type: "stream_event",
        uuid: "aborted-1",
        session_id: "sdk-session-coalesce",
        parent_tool_use_id: null,
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      call.push(textDelta("aborted-1", "interrupted text"));
      await settleQueuedMessages();
      abortSession(session.id);

      await promptPromise;

      // An interrupted turn keeps whatever streamed; the transcript is the only
      // record of it, since the SDK will not replay the turn.
      expect(assistantContent(session.id)).toBe("interrupted text");
    } finally {
      stop();
    }
  });

  test("abortSession during a running query unblocks the iterator and emits session.idle", async () => {
    const session = createSession("abort-me");
    track(session.id);

    const { events, stop } = captureEvents();
    try {
      const promptPromise = sendPrompt(session.id, "long-running");
      const call = await nextQueryCall();
      call.push({ type: "system", subtype: "init", session_id: "sdk-1", mcp_servers: [] });

      // Wait until the iterator has started consuming.
      await waitFor(() => getSession(session.id)?.status === "running");

      const result = abortSession(session.id);
      expect(result).toBe(true);

      await promptPromise;
      expect(call.options.abortController?.signal.aborted).toBe(true);
      expect(getSession(session.id)?.status).toBe("idle");
      expect(getSession(session.id)?.turnStartedAt).toBeUndefined();

      const idleEvents = events.filter((e) => e.type === "session.idle");
      expect(idleEvents.length).toBeGreaterThan(0);
      const aborted = idleEvents.find((e) => (e.data as { aborted?: boolean })?.aborted === true);
      expect(aborted).toBeDefined();
    } finally {
      stop();
    }
  });

  test("an aborted run cannot clobber an immediately restarted prompt", async () => {
    const session = createSession("abort-restart");
    track(session.id);
    const firstPrompt = sendPrompt(session.id, "first");
    await nextQueryCall();

    expect(abortSession(session.id)).toBe(true);
    const secondPrompt = sendPrompt(session.id, "second");
    const secondCall = await nextQueryCall();
    const secondInput =
      (secondCall.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    expect((await secondInput.next()).done).toBe(false);
    const secondInputCompletion = secondInput.next();
    await firstPrompt;

    expect(session.status).toBe("running");
    expect(session.abortController).toBe(secondCall.options.abortController);

    secondCall.push({ type: "result", subtype: "success" });
    expect(await secondInputCompletion).toEqual({ done: true, value: undefined });
    secondCall.finish();
    await secondPrompt;
    expect(session.status).toBe("idle");
  });

  test("ignores malformed stream indices and stream events without a usable message identity", async () => {
    const events = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_STREAM_CONTENT_BLOCK_INDEX + 1,
      1_000_000_000,
    ].map((index) => ({
      type: "stream_event",
      uuid: "bad-stream",
      event: {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: "must not render" },
      },
    }));
    events.push({
      type: "stream_event",
      uuid: undefined,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "also ignored" },
      },
    } as never);

    const { session } = await runPromptWithMessages([
      ...events,
      { type: "result", subtype: "success" },
    ]);

    expect(session.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
  });

  test("keeps streamed block ordering sparse-safe at the accepted index boundary", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "stream_event",
        uuid: "bounded-stream",
        event: {
          type: "content_block_delta",
          index: MAX_STREAM_CONTENT_BLOCK_INDEX,
          delta: { type: "text_delta", text: "last" },
        },
      },
      {
        type: "stream_event",
        uuid: "bounded-stream",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "first" },
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const assistant = session.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("firstlast");
    expect(assistant?.parts.map((part) => part.content)).toEqual(["first", "last"]);
  });

  test("uses a stream uuid fallback when no message_start arrives", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "stream_event",
        uuid: "fallback-stream-id",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "fallback text" },
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const assistant = session.messages.find((message) => message.role === "assistant");
    expect(assistant?.id).toBe("fallback-stream-id");
    expect(assistant?.content).toBe("fallback text");
  });

  test("accepts finalized assistant blocks without prior streaming and preserves ignored offsets", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "final-only",
          content: [
            { type: "unknown" },
            { type: "text", text: "after ignored block" },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const assistant = session.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("after ignored block");
    expect(assistant?.parts).toEqual([
      expect.objectContaining({ type: "text", content: "after ignored block" }),
    ]);
  });

  test("builds compact stats for Claude file-edit tools and ignores malformed identities", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "tool-message",
        message: {
          id: "tool-message",
          content: [
            {
              type: "tool_use",
              id: "edit-1",
              name: "Edit",
              input: { file_path: "a.ts", old_string: "before", new_string: "after" },
            },
            {
              type: "tool_use",
              id: "write-1",
              name: "Write",
              input: { file_path: "b.ts", content: "new file" },
            },
            {
              type: "tool_use",
              id: "multi-1",
              name: "MultiEdit",
              input: {
                file_path: "c.ts",
                edits: [
                  { old_string: "one", new_string: "two\nthree" },
                  { old_string: "four\n", new_string: "five" },
                ],
              },
            },
            {
              type: "tool_use",
              id: "notebook-1",
              name: "NotebookEdit",
              input: { notebook_path: "notes.ipynb", new_source: "a\nb\n" },
            },
            { type: "tool_use", id: 42, name: "Bash", input: {} },
            { type: "tool_use", id: "", name: "Bash", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "edit-1", content: "ok" },
            { type: "tool_result", tool_use_id: "write-1", content: [{ type: "text", text: "done" }] },
            { type: "tool_result", tool_use_id: "multi-1", content: "ok" },
            { type: "tool_result", tool_use_id: "notebook-1", content: "ok" },
            { type: "tool_result", tool_use_id: 42, content: "ignored" },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const tools = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.filter((part) => part.type === "tool-invocation") ?? [];
    expect(tools).toHaveLength(4);
    expect(tools[0]).toMatchObject({
      toolUseId: "edit-1",
      toolState: "success",
      toolDiff: {
        filePath: "a.ts",
        before: "before",
        after: "after",
        additions: 1,
        deletions: 1,
      },
    });
    expect(tools[1]).toMatchObject({
      toolUseId: "write-1",
      toolState: "success",
      toolDiff: {
        filePath: "b.ts",
        before: "",
        after: "new file",
        additions: 1,
        deletions: 0,
      },
    });
    expect(tools[2]).toMatchObject({
      toolUseId: "multi-1",
      toolState: "success",
      toolDiff: {
        filePath: "c.ts",
        before: "one\nfour\n",
        after: "two\nthree\nfive",
        additions: 3,
        deletions: 2,
      },
    });
    expect(tools[3]).toMatchObject({
      toolUseId: "notebook-1",
      toolState: "success",
      toolDiff: {
        filePath: "notes.ipynb",
        after: "a\nb\n",
        additions: 2,
        deletions: 0,
      },
    });
  });

  test("does not invent lines for a multiedit chunk that ends in a newline", async () => {
    /*
     * The synthetic before/after sides are a concatenation of the individual
     * edits. A chunk that already ends in a newline supplies its own separator;
     * adding another puts a blank line into the rendered diff that the file
     * never had and charges it to the badge.
     */
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "multi-newline-message",
        message: {
          id: "multi-newline-message",
          content: [
            {
              type: "tool_use",
              id: "multi-nl",
              name: "MultiEdit",
              input: {
                file_path: "c.ts",
                edits: [
                  { old_string: "four\n", new_string: "x\n" },
                  { old_string: "one", new_string: "y" },
                ],
              },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "multi-nl", content: "ok" }],
        },
      },
      { type: "result", subtype: "success", result: "done" },
    ]);

    const tool = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.find((part) => part.type === "tool-invocation");
    expect(tool?.toolDiff).toMatchObject({
      filePath: "c.ts",
      before: "four\none",
      after: "x\ny",
      additions: 2,
      deletions: 2,
    });
  });

  test("leaves a delete-mode notebook edit without counts it cannot measure", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "notebook-delete-message",
        message: {
          id: "notebook-delete-message",
          content: [
            {
              type: "tool_use",
              id: "notebook-del",
              name: "NotebookEdit",
              input: { notebook_path: "notes.ipynb", edit_mode: "delete" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "notebook-del", content: "ok" }],
        },
      },
      { type: "result", subtype: "success", result: "done" },
    ]);

    const tool = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.find((part) => part.type === "tool-invocation");
    // The path still identifies the file; reporting +0/-0 would state a count
    // nothing measured, and the badge is hidden at zero either way.
    expect(tool?.toolDiff?.filePath).toBe("notes.ipynb");
    expect(tool?.toolDiff?.additions).toBeUndefined();
    expect(tool?.toolDiff?.deletions).toBeUndefined();
  });

  test("stamps each task tool call with the resulting task list state", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "task-message",
        message: {
          id: "task-message",
          content: [
            {
              type: "tool_use",
              id: "create-1",
              name: "TaskCreate",
              input: { subject: "Cache threadId", description: "..." },
            },
            {
              type: "tool_use",
              id: "create-2",
              name: "TaskCreate",
              input: { subject: "Fix cache thrash", description: "..." },
            },
            {
              type: "tool_use",
              id: "update-1",
              name: "TaskUpdate",
              input: { taskId: "1", status: "in_progress" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "create-1",
              content: "Task #1 created successfully: Cache threadId",
            },
            {
              type: "tool_result",
              tool_use_id: "create-2",
              content: "Task #2 created successfully: Fix cache thrash",
            },
            { type: "tool_result", tool_use_id: "update-1", content: "Updated task #1 status" },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const tools = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    // Each call carries the list as it stood after that call, so the renderer
    // never has to reconstruct it from neighbouring parts.
    expect(tools[0]?.taskSnapshot).toEqual({
      items: [{ id: "1", subject: "Cache threadId", status: "pending" }],
      complete: true,
      changedTaskId: "1",
    });
    expect(tools[1]?.taskSnapshot?.items).toEqual([
      { id: "1", subject: "Cache threadId", status: "pending" },
      { id: "2", subject: "Fix cache thrash", status: "pending" },
    ]);
    // The update carries only {taskId, status}; the subject comes from the registry.
    expect(tools[2]?.taskSnapshot?.items).toEqual([
      { id: "1", subject: "Cache threadId", status: "in_progress" },
      { id: "2", subject: "Fix cache thrash", status: "pending" },
    ]);
    // The bridge resolves the changed task, so the renderer never re-parses it.
    expect(tools[2]?.taskSnapshot?.changedTaskId).toBe("1");
  });

  test("serves the session task list from its authoritative endpoint", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "task-endpoint",
        message: {
          id: "task-endpoint",
          content: [
            {
              type: "tool_use",
              id: "create-1",
              name: "TaskCreate",
              input: { subject: "Rehydrated task", description: "..." },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "create-1",
              content: "Task #1 created successfully: Rehydrated task",
            },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    // A tab that was unmounted while this ran reads the list from the session,
    // not by replaying the transcript.
    expect(getSession(session.id)?.taskRegistry?.snapshot()).toEqual({
      items: [{ id: "1", subject: "Rehydrated task", status: "pending" }],
      complete: true,
    });
  });

  test("omits the snapshot when a task call's output cannot be parsed", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "unparsed",
        message: {
          id: "unparsed",
          content: [
            {
              type: "tool_use",
              id: "create-bad",
              name: "TaskCreate",
              input: { subject: "Never assigned an id", description: "..." },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "create-bad",
              // Succeeded, but in a shape the registry does not recognize.
              content: "Something the registry has never seen",
            },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const tool = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.find((part) => part.type === "tool-invocation");

    // No snapshot at all, so the renderer shows the call itself rather than an
    // empty list it would otherwise present as fact.
    expect(tool?.toolState).toBe("success");
    expect(tool?.taskSnapshot).toBeUndefined();
    expect(getSession(session.id)?.taskRegistry?.snapshot().items).toEqual([]);
  });

  test("marks the list incomplete when it never saw a task created", async () => {
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        uuid: "partial",
        message: {
          id: "partial",
          content: [
            {
              type: "tool_use",
              id: "update-unknown",
              name: "TaskUpdate",
              input: { taskId: "7", status: "in_progress" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "update-unknown",
              content: "Updated task #7 status",
            },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const tool = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.find((part) => part.type === "tool-invocation");

    // The task predates this registry, so its view is missing whatever came
    // before and must not be shown as the whole list.
    expect(tool?.taskSnapshot?.complete).toBe(false);
    expect(tool?.taskSnapshot?.items).toEqual([
      { id: "7", subject: "Task #7", status: "in_progress" },
    ]);
  });

  test("carries the task list across turns and ignores failed task calls", async () => {
    const session = createSession("multi-turn tasks");
    track(session.id);

    const runTurn = async (messages: unknown[]) => {
      const promptPromise = sendPrompt(session.id, "go");
      const call = await nextQueryCall();
      for (const message of messages) call.push(message);
      call.finish();
      await promptPromise;
    };

    await runTurn([
      {
        type: "assistant",
        uuid: "turn-1",
        message: {
          id: "turn-1",
          content: [
            {
              type: "tool_use",
              id: "create-1",
              name: "TaskCreate",
              input: { subject: "Survives the turn", description: "..." },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "create-1",
              content: "Task #1 created successfully: Survives the turn",
            },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    await runTurn([
      {
        type: "assistant",
        uuid: "turn-2",
        message: {
          id: "turn-2",
          content: [
            {
              type: "tool_use",
              id: "update-fail",
              name: "TaskUpdate",
              input: { taskId: "1", status: "completed" },
            },
            {
              type: "tool_use",
              id: "update-ok",
              name: "TaskUpdate",
              input: { taskId: "1", status: "in_progress" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "update-fail",
              content: "Task #1 not found",
              is_error: true,
            },
            { type: "tool_result", tool_use_id: "update-ok", content: "Updated task #1 status" },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const secondTurn = getSessionMessages(session.id)
      .filter((message) => message.role === "assistant")
      .at(-1);
    const tools = secondTurn?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    // The failed call left the list alone and got no snapshot at all.
    expect(tools[0]?.toolState).toBe("failure");
    expect(tools[0]?.taskSnapshot).toBeUndefined();
    // The successful one still resolves a task created in the *previous* turn,
    // and the list is still complete: nothing had to be synthesized.
    expect(tools[1]?.taskSnapshot?.items).toEqual([
      { id: "1", subject: "Survives the turn", status: "in_progress" },
    ]);
    expect(tools[1]?.taskSnapshot?.complete).toBe(true);
  });

  test("uses explicit Task parents across concurrent tasks and longest MCP server prefixes", async () => {
    mockGetMcpServerNames.mockImplementationOnce(async () =>
      new Set(["team", "team_tools"]),
    );
    const { session } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "tasks",
          content: [
            { type: "tool_use", id: "task-a", name: "Task", input: {} },
            { type: "tool_use", id: "task-b", name: "Task", input: {} },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "task-a",
        message: {
          id: "child",
          model: "claude-subagent",
          content: [
            { type: "tool_use", id: "child-a", name: "mcp_team_tools_search", input: {} },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    const child = session.messages
      .find((message) => message.role === "assistant")
      ?.parts.find((part) => part.toolUseId === "child-a");
    expect(child).toMatchObject({
      parentTaskUseId: "task-a",
      isMcpTool: true,
      mcpServerName: "team_tools",
    });
    expect(session.messages.every((message) => message.modelId === undefined)).toBe(true);
  });

  test("recognizes Agent as a subagent tool and parents its thinking, text, and edits", async () => {
    const { session, call } = await runPromptWithMessages([
      {
        type: "assistant",
        message: {
          id: "parent",
          content: [
            {
              type: "tool_use",
              id: "agent-a",
              name: "Agent",
              input: { description: "Review the bridge" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "agent-a",
              content: "Agent started in the background",
            },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "agent-a",
        message: {
          id: "child",
          content: [
            { type: "thinking", thinking: "Inspecting the lifecycle." },
            { type: "text", text: "I found the lifecycle edge." },
            {
              type: "tool_use",
              id: "child-edit",
              name: "Edit",
              input: {
                file_path: "bridge.ts",
                old_string: "old",
                new_string: "new",
              },
            },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ]);

    expect(call.options.allowedTools).toContain("Agent");
    expect(call.options.forwardSubagentText).toBe(true);
    const assistant = session.messages.find((message) => message.role === "assistant");
    expect(
      assistant?.parts.map((part) => ({
        type: part.type,
        toolName: part.toolName,
        parentTaskUseId: part.parentTaskUseId,
      })),
    ).toEqual([
      { type: "tool-invocation", toolName: "Agent", parentTaskUseId: undefined },
      { type: "thinking", toolName: undefined, parentTaskUseId: "agent-a" },
      { type: "text", toolName: undefined, parentTaskUseId: "agent-a" },
      { type: "tool-invocation", toolName: "Edit", parentTaskUseId: "agent-a" },
    ]);
  });

  test("sends valid images natively, omits empty image-only text, and escapes file metadata", async () => {
    const { call } = await runPromptWithMessages(
      [{ type: "result", subtype: "success" }],
      {
        attachments: [
          {
            type: "image",
            path: "",
            filename: "photo.jpg",
            dataUrl: "data:image/webp;base64,aGVsbG8=",
          },
          {
            type: "file",
            path: `a&b<"'.txt`,
            filename: `x&y<"'.txt`,
          },
        ],
      },
      "",
    );

    const sdkMessages = await readSdkPrompt(call) as Array<{
      message: { content: Array<Record<string, unknown>> };
    }>;
    expect(sdkMessages).toHaveLength(1);
    expect(sdkMessages[0].message.content).toHaveLength(2);
    expect(sdkMessages[0].message.content[0]).toMatchObject({ type: "text" });
    expect((sdkMessages[0].message.content[0] as { text: string }).text).toContain(
      'path="a&amp;b&lt;&quot;&apos;.txt"',
    );
    expect(sdkMessages[0].message.content[1]).toMatchObject({
      type: "image",
      source: { media_type: "image/webp", data: "aGVsbG8=" },
    });
  });

  test("omits the text block for a truly image-only SDK prompt", async () => {
    const { call } = await runPromptWithMessages(
      [{ type: "result", subtype: "success" }],
      {
        attachments: [{
          type: "image",
          path: "",
          filename: "photo.png",
          dataUrl: "data:image/png;base64,aGVsbG8=",
        }],
      },
      "",
    );

    const sdkMessages = await readSdkPrompt(call) as Array<{
      message: { content: Array<Record<string, unknown>> };
    }>;
    expect(sdkMessages[0].message.content).toEqual([
      expect.objectContaining({ type: "image" }),
    ]);
  });

  test("rejects malformed inline image data instead of silently omitting it", async () => {
    const session = createSession("malformed-image");
    track(session.id);
    const { events, stop } = captureEvents();
    try {
      await expect(sendPrompt(session.id, "describe this", {
        attachments: [{
          type: "image",
          path: "/definitely/missing/image.png",
          dataUrl: "data:image/png;base64,not-valid!",
        }],
      })).rejects.toMatchObject({
        name: "ClaudeAttachmentError",
        code: "attachment_invalid_data",
      });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(events.find((event) => event.type === "session.error")?.data).toEqual({
        error: "Image attachment data must be valid base64 and no larger than 8MB.",
        code: "attachment_invalid_data",
      });
    } finally {
      stop();
    }
  });

  test("rejects unsupported inline image media types", async () => {
    const session = createSession("unsupported-inline-image");
    track(session.id);

    await expect(sendPrompt(session.id, "describe this", {
      attachments: [{
        type: "image",
        path: "",
        filename: "vector.svg",
        dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
      }],
    })).rejects.toMatchObject({
      name: "ClaudeAttachmentError",
      code: "attachment_invalid_data",
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("rejects image attachments with neither inline data nor a file source", async () => {
    const session = createSession("missing-image-source");
    track(session.id);

    await expect(sendPrompt(session.id, "describe this", {
      attachments: [{ type: "image", path: "" }],
    })).rejects.toMatchObject({
      name: "ClaudeAttachmentError",
      code: "attachment_read_failed",
      message: "Image attachment does not contain readable image data.",
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("accepts inline image data at exactly 8MB and rejects one byte over", async () => {
    const allowedData = Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES, 1).toString("base64");
    const { call } = await runPromptWithMessages(
      [{ type: "result", subtype: "success" }],
      {
        attachments: [{
          type: "image",
          path: "",
          filename: "boundary.png",
          dataUrl: `data:image/png;base64,${allowedData}`,
        }],
      },
    );
    const sdkMessages = await readSdkPrompt(call) as Array<{
      message: { content: Array<{ source?: { data?: string } }> };
    }>;
    expect(sdkMessages[0].message.content[1]?.source?.data).toHaveLength(
      allowedData.length,
    );

    const oversizedSession = createSession("oversized-inline-image");
    track(oversizedSession.id);
    const oversizedData = Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1, 1).toString("base64");
    await expect(sendPrompt(oversizedSession.id, "describe this", {
      attachments: [{
        type: "image",
        path: "",
        filename: "boundary.png",
        dataUrl: `data:image/png;base64,${oversizedData}`,
      }],
    })).rejects.toMatchObject({
      name: "ClaudeAttachmentError",
      code: "attachment_invalid_data",
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("rejects an image-only prompt when no image can be decoded", async () => {
    const session = createSession("invalid-image-only");
    track(session.id);

    await expect(sendPrompt(session.id, "", {
      attachments: [{
        type: "image",
        path: "",
        dataUrl: "data:image/png;base64,not-valid!",
      }],
    })).rejects.toMatchObject({
      name: "ClaudeAttachmentError",
      code: "attachment_invalid_data",
    });
    expect(session.status).toBe("error");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test("reads image attachments from disk when no data URL is supplied", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-test-"));
    const imagePath = join(directory, "image.gif");
    await writeFile(imagePath, Buffer.from("gif-data"));
    try {
      const { call } = await withWorkspaceCwd(directory, () =>
        runPromptWithMessages(
          [{ type: "result", subtype: "success" }],
          { attachments: [{ type: "image", path: imagePath }] },
        ));
      const sdkMessages = await readSdkPrompt(call) as Array<{
        message: { content: Array<{ type: string; source?: { media_type: string; data: string } }> };
      }>;
      expect(sdkMessages[0].message.content[1]?.source).toEqual({
        type: "base64",
        media_type: "image/gif",
        data: Buffer.from("gif-data").toString("base64"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects disk images outside the SDK workspace root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-boundary-"));
    const workspace = join(directory, "workspace");
    const outsideImage = join(directory, "outside.png");
    await mkdir(workspace);
    await writeFile(outsideImage, "outside");
    try {
      const session = createSession("outside-image");
      track(session.id);
      await withWorkspaceCwd(workspace, async () => {
        await expect(sendPrompt(session.id, "describe", {
          attachments: [{ type: "image", path: outsideImage }],
        })).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_outside_workspace",
        });
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects direct, chained, and ancestor symlinks for disk images", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-symlink-"));
    const workspace = join(directory, "workspace");
    const outside = join(directory, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, "image.png"), "inside");
    await writeFile(join(outside, "outside.png"), "outside");
    await symlink(join(workspace, "image.png"), join(workspace, "direct.png"));
    await symlink(join(workspace, "direct.png"), join(workspace, "chain.png"));
    await symlink(outside, join(workspace, "outside-dir"));

    try {
      for (const attachmentPath of [
        join(workspace, "direct.png"),
        join(workspace, "chain.png"),
        join(workspace, "outside-dir", "outside.png"),
      ]) {
        const session = createSession("symlink-image");
        track(session.id);
        await withWorkspaceCwd(workspace, async () => {
          await expect(sendPrompt(session.id, "describe", {
            attachments: [{ type: "image", path: attachmentPath }],
          })).rejects.toMatchObject({
            name: "ClaudeAttachmentError",
            code: "attachment_symlink_not_allowed",
          });
        });
      }
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects non-regular disk image attachments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-nonfile-"));
    const imageDirectory = join(directory, "directory.png");
    await mkdir(imageDirectory);
    try {
      const session = createSession("directory-image");
      track(session.id);
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(session.id, "describe", {
          attachments: [{ type: "image", path: imageDirectory }],
        })).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_not_regular_file",
        });
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an empty disk image instead of silently omitting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-empty-image-"));
    const emptyImage = join(directory, "empty.png");
    await writeFile(emptyImage, "");
    try {
      const session = createSession("empty-image");
      track(session.id);
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(session.id, "describe", {
          attachments: [{ type: "image", path: emptyImage }],
        })).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_invalid_data",
          message: "Image attachment file is empty.",
        });
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("maps missing disk images to an actionable read failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-missing-image-"));
    const missingImage = join(directory, "missing.png");
    const session = createSession("missing-image");
    track(session.id);
    const { events, stop } = captureEvents();
    try {
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(session.id, "describe", {
          attachments: [{ type: "image", path: missingImage }],
        })).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_read_failed",
          message: "Image attachment could not be read safely from the workspace.",
        });
      });
      expect(events.find((event) => event.type === "session.error")?.data).toEqual({
        error: "Image attachment could not be read safely from the workspace.",
        code: "attachment_read_failed",
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("maps an unreadable workspace canonical path to an actionable read failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-missing-workspace-"));
    const missingWorkspace = join(directory, "removed-workspace");
    const session = createSession("missing-workspace");
    track(session.id);
    try {
      await expect(withWorkspaceCwd(missingWorkspace, () =>
        sendPrompt(session.id, "describe", {
          attachments: [{ type: "image", path: join(missingWorkspace, "image.png") }],
        }))).rejects.toMatchObject({
        name: "ClaudeAttachmentError",
        code: "attachment_read_failed",
        message: "Image attachment could not be read safely from the workspace.",
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("maps lstat or realpath failure after opening an image to an actionable read failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-removed-image-"));
    const imagePath = join(directory, "removed.png");
    await writeFile(imagePath, "image-data");
    const session = createSession("removed-image");
    track(session.id);
    try {
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(
          session.id,
          "describe",
          { attachments: [{ type: "image", path: imagePath }] },
          {
            afterAttachmentInitialValidation: async () => {
              await rm(imagePath);
            },
          },
        )).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_read_failed",
          message: "Image attachment could not be read safely from the workspace.",
        });
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("maps target realpath failure after symlink validation to an actionable read failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-realpath-race-"));
    const imagePath = join(directory, "removed.png");
    await writeFile(imagePath, "image-data");
    const session = createSession("realpath-race");
    track(session.id);
    try {
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(
          session.id,
          "describe",
          { attachments: [{ type: "image", path: imagePath }] },
          {
            afterAttachmentSymlinkValidation: async () => {
              await rm(imagePath);
            },
          },
        )).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_read_failed",
          message: "Image attachment could not be read safely from the workspace.",
        });
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("maps file-open failure after canonical validation to an actionable read failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-open-race-"));
    const imagePath = join(directory, "removed-after-canonical.png");
    await writeFile(imagePath, "image-data");
    const session = createSession("open-race");
    track(session.id);
    try {
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(
          session.id,
          "describe",
          { attachments: [{ type: "image", path: imagePath }] },
          {
            afterAttachmentCanonicalValidation: async () => {
              await rm(imagePath);
            },
          },
        )).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_read_failed",
          message: "Image attachment could not be read safely from the workspace.",
        });
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports attachment_changed when a disk image mutates during the bounded read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-changed-image-"));
    const imagePath = join(directory, "changed.png");
    await writeFile(imagePath, "abc");
    const session = createSession("changed-image");
    track(session.id);
    try {
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(
          session.id,
          "describe",
          { attachments: [{ type: "image", path: imagePath }] },
          {
            afterAttachmentInitialValidation: () => writeFile(imagePath, "changed-image"),
          },
        )).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_changed",
          message: "Image attachment changed while it was being read; please attach it again.",
        });
      });
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("accepts an image at the 8MB limit and rejects one byte over it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-bridge-image-size-"));
    const allowedImage = join(directory, "allowed.png");
    const oversizedImage = join(directory, "oversized.png");
    await writeFile(allowedImage, Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES, 1));
    await writeFile(oversizedImage, Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1, 1));
    try {
      const allowedSession = createSession("allowed-image");
      track(allowedSession.id);
      await withWorkspaceCwd(directory, async () => {
        const promptPromise = sendPrompt(allowedSession.id, "describe", {
          attachments: [{ type: "image", path: allowedImage }],
        });
        const call = await nextQueryCall();
        call.push({ type: "result", subtype: "success" });
        call.finish();
        await promptPromise;
        const sdkMessages = await readSdkPrompt(call) as Array<{
          message: { content: Array<{ source?: { data?: string } }> };
        }>;
        expect(sdkMessages[0].message.content[1]?.source?.data).toHaveLength(
          Math.ceil(MAX_IMAGE_ATTACHMENT_BYTES / 3) * 4,
        );
      });

      const oversizedSession = createSession("oversized-image");
      track(oversizedSession.id);
      await withWorkspaceCwd(directory, async () => {
        await expect(sendPrompt(oversizedSession.id, "describe", {
          attachments: [{ type: "image", path: oversizedImage }],
        })).rejects.toMatchObject({
          name: "ClaudeAttachmentError",
          code: "attachment_too_large",
        });
      });
      expect(mockQuery).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("turns non-success SDK results into observable prompt failures and clears the error on retry", async () => {
    const session = createSession("result-errors");
    track(session.id);
    const firstPrompt = sendPrompt(session.id, "first");
    const firstCall = await nextQueryCall();
    firstCall.push({ type: "result", subtype: "error_during_execution", errors: ["tool failed"] });
    firstCall.finish();

    await expect(firstPrompt).rejects.toThrow("tool failed");
    expect(session.status).toBe("error");
    expect(session.error).toBe("tool failed");

    const retry = sendPrompt(session.id, "retry");
    expect(session.error).toBeUndefined();
    const retryCall = await nextQueryCall();
    retryCall.push({ type: "result", subtype: "success" });
    retryCall.finish();
    await retry;
    expect(session.status).toBe("idle");
  });

  test("passes Agent SDK outputFormat without removing tools and stores the structured payload", async () => {
    const outputSchema = {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    };
    const { events, stop } = captureEvents();
    try {
      const { session, call } = await runPromptWithMessages(
        [{
          type: "result",
          subtype: "success",
          structured_output: { summary: "Looks good" },
        }],
        { outputSchema, requestId: "structured-1" },
      );

      expect(call.options.outputFormat).toEqual({
        type: "json_schema",
        schema: outputSchema,
      });
      expect(call.options.allowedTools).toContain("Read");
      expect(call.options.allowedTools).toContain("Bash");
      expect(session.structuredOutput).toEqual({
        ok: true,
        provider: "claude",
        requestId: "structured-1",
        value: { summary: "Looks good" },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: "session.structured-output",
        sessionId: session.id,
      }));
    } finally {
      stop();
    }
  });

  test("never accepts plaintext as a structured result and types schema retry exhaustion", async () => {
    const outputSchema = { type: "object" };
    const missingSession = createSession("missing-structured");
    track(missingSession.id);
    const missing = sendPrompt(missingSession.id, "review", {
      outputSchema,
      requestId: "structured-missing",
    });
    const missingCall = await nextQueryCall();
    missingCall.push({
      type: "assistant",
      message: { id: "msg-plain", content: [{ type: "text", text: "Looks good" }] },
    });
    missingCall.push({ type: "result", subtype: "success", result: "Looks good" });
    missingCall.finish();

    await expect(missing).rejects.toThrow("without a structured result");
    expect(missingSession.structuredOutput).toMatchObject({
      ok: false,
      error: { code: "malformed_output", retryable: true },
    });

    const exhaustedSession = createSession("exhausted");
    track(exhaustedSession.id);
    const exhausted = sendPrompt(exhaustedSession.id, "review", {
      outputSchema,
      requestId: "structured-exhausted",
    });
    const exhaustedCall = await nextQueryCall();
    exhaustedCall.push({
      type: "result",
      subtype: "error_max_structured_output_retries",
      errors: ["Could not match schema"],
    });
    exhaustedCall.finish();

    await expect(exhausted).rejects.toThrow("Could not match schema");
    expect(exhaustedSession.structuredOutput).toMatchObject({
      ok: false,
      requestId: "structured-exhausted",
      error: { code: "schema_retry_exhausted", retryable: true },
    });
  });

  test("records a non-schema provider failure as the authoritative structured result", async () => {
    const session = createSession("structured-provider-failure");
    track(session.id);
    const { events, stop } = captureEvents();
    try {
      const prompt = sendPrompt(session.id, "review", {
        outputSchema: { type: "object" },
        requestId: "structured-provider-failure",
      });
      const call = await nextQueryCall();
      call.push({
        type: "result",
        subtype: "error_during_execution",
        errors: ["provider unavailable"],
      });
      call.finish();

      await expect(prompt).rejects.toThrow("provider unavailable");
      expect(session.structuredOutput).toEqual({
        ok: false,
        provider: "claude",
        requestId: "structured-provider-failure",
        error: {
          code: "provider_error",
          message: "provider unavailable",
          provider: "claude",
          retryable: true,
          details: { subtype: "error_during_execution" },
        },
      });
      expect(events.filter((event) =>
        event.type === "session.structured-output"
        && event.sessionId === session.id
      )).toEqual([
        {
          type: "session.structured-output",
          sessionId: session.id,
          data: { structuredOutput: session.structuredOutput },
        },
      ]);
    } finally {
      stop();
    }
  });

  test("records an aborted structured turn as an authoritative interrupted result", async () => {
    const session = createSession("structured-interrupted");
    track(session.id);
    const { events, stop } = captureEvents();
    try {
      const prompt = sendPrompt(session.id, "review", {
        outputSchema: { type: "object" },
        requestId: "structured-interrupted",
      });
      await nextQueryCall();

      expect(abortSession(session.id)).toBe(true);
      await prompt;

      expect(session.structuredOutput).toEqual({
        ok: false,
        provider: "claude",
        requestId: "structured-interrupted",
        error: {
          code: "interrupted",
          message: "Claude structured-output turn was interrupted.",
          provider: "claude",
          retryable: true,
          details: undefined,
        },
      });
      expect(events.filter((event) =>
        event.type === "session.structured-output"
        && event.sessionId === session.id
      )).toEqual([
        {
          type: "session.structured-output",
          sessionId: session.id,
          data: { structuredOutput: session.structuredOutput },
        },
      ]);
    } finally {
      stop();
    }
  });

  test("records an abort while the final usage snapshot is pending", async () => {
    let resolveUsage!: (value: unknown) => void;
    let usageRequestStarted = false;
    queryControlOverrides.getContextUsage = mock(() => {
      usageRequestStarted = true;
      return new Promise<unknown>((resolve) => {
        resolveUsage = resolve;
      });
    });

    const session = createSession("structured usage abort");
    track(session.id);
    const { events, stop } = captureEvents();
    try {
      const prompt = sendPrompt(session.id, "review", {
        outputSchema: { type: "object" },
        requestId: "structured-usage-abort",
      });
      const call = await nextQueryCall();
      call.push({
        type: "result",
        subtype: "success",
        structured_output: { summary: "provider completed" },
        modelUsage: {
          "claude-mock": { inputTokens: 1, outputTokens: 1, contextWindow: 200_000 },
        },
      });
      await waitFor(() => usageRequestStarted);

      expect(abortSession(session.id)).toBe(true);
      resolveUsage({ totalTokens: 2, maxTokens: 200_000, percentage: 0.001 });
      await prompt;

      expect(session.structuredOutput).toMatchObject({
        ok: false,
        requestId: "structured-usage-abort",
        error: { code: "interrupted", retryable: true },
      });
      expect(events.filter((event) =>
        event.type === "session.structured-output"
        && event.sessionId === session.id
      )).toHaveLength(1);
    } finally {
      stop();
    }
  });

  test("does not let an aborted structured result overwrite a restarted request", async () => {
    let resolveUsage!: (value: unknown) => void;
    let usageRequestStarted = false;
    queryControlOverrides.getContextUsage = mock(() => {
      usageRequestStarted = true;
      return new Promise<unknown>((resolve) => {
        resolveUsage = resolve;
      });
    });

    const session = createSession("structured usage restart");
    track(session.id);
    const firstPrompt = sendPrompt(session.id, "first review", {
      outputSchema: { type: "object" },
      requestId: "structured-before-restart",
    });
    const firstCall = await nextQueryCall();
    firstCall.push({
      type: "result",
      subtype: "success",
      structured_output: { summary: "stale result" },
      modelUsage: {
        "claude-mock": { inputTokens: 1, outputTokens: 1, contextWindow: 200_000 },
      },
    });
    await waitFor(() => usageRequestStarted);

    expect(abortSession(session.id)).toBe(true);
    delete queryControlOverrides.getContextUsage;
    const secondPrompt = sendPrompt(session.id, "second review", {
      outputSchema: { type: "object" },
      requestId: "structured-after-restart",
    });
    const secondCall = await nextQueryCall();

    resolveUsage({ totalTokens: 2, maxTokens: 200_000, percentage: 0.001 });
    await firstPrompt;
    expect(session.structuredOutputRequestId).toBe("structured-after-restart");
    expect(session.structuredOutput).toBeUndefined();

    secondCall.push({
      type: "result",
      subtype: "success",
      structured_output: { summary: "current result" },
    });
    secondCall.finish();
    await secondPrompt;
    expect(session.structuredOutput).toEqual({
      ok: true,
      provider: "claude",
      requestId: "structured-after-restart",
      value: { summary: "current result" },
    });
  });

  test("a repeated structured request id attaches instead of launching another query", async () => {
    const session = createSession("deduplicated");
    track(session.id);
    const options = {
      outputSchema: { type: "object" },
      requestId: "structured-once",
    };
    const first = sendPrompt(session.id, "review", options);
    const call = await nextQueryCall();

    await sendPrompt(session.id, "review", options);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    call.push({
      type: "result",
      subtype: "success",
      structured_output: { summary: "done" },
    });
    call.finish();
    await first;

    await sendPrompt(session.id, "review", options);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(session.structuredOutput).toMatchObject({
      ok: true,
      requestId: "structured-once",
    });
  });

  /**
   * The destructive case: an ordinary prompt can run shell commands and edit
   * files, so a request id retried after a lost HTTP response must attach to
   * the turn already running rather than start a second one. Dedup used to be
   * gated on `outputSchema`, leaving every plain prompt unprotected.
   */
  test("a repeated request id on an unstructured prompt never launches a second query", async () => {
    const session = createSession("plain dedup");
    track(session.id);
    const options = { requestId: "plain-once" };

    const first = sendPrompt(session.id, "delete the temp dir", options);
    const call = await nextQueryCall();

    // Retried while the first turn is still running.
    await sendPrompt(session.id, "delete the temp dir", options);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(getPromptDispatchState(session.id, "plain-once")).toBe("processing");

    call.push({ type: "result", subtype: "success", result: "done" });
    call.finish();
    await first;

    // And retried again after it finished: the outcome is replayed, not re-run.
    await sendPrompt(session.id, "delete the temp dir", options);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(getPromptDispatchState(session.id, "plain-once")).toBe("already-processed");

    // A different id is a genuinely different turn and still dispatches.
    const second = sendPrompt(session.id, "delete the temp dir", {
      requestId: "plain-twice",
    });
    const secondCall = await nextQueryCall();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    secondCall.push({ type: "result", subtype: "success", result: "done" });
    secondCall.finish();
    await second;
  });

  test("settles the dispatch record even when the turn fails, so a retry cannot re-run it", async () => {
    const session = createSession("plain dedup failure");
    track(session.id);
    const options = { requestId: "plain-failed" };

    const first = sendPrompt(session.id, "delete the temp dir", options);
    const call = await nextQueryCall();
    call.fail(new Error("provider disconnected"));
    await expect(first).rejects.toThrow("provider disconnected");

    // A failed turn may still have executed tool calls before it died, so the
    // retry is refused exactly like a successful one.
    expect(getPromptDispatchState(session.id, "plain-failed")).toBe("already-processed");
    await sendPrompt(session.id, "delete the temp dir", options);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test("scopes a caller-supplied request id to its session", async () => {
    const firstSession = createSession("first request scope");
    const secondSession = createSession("second request scope");
    track(firstSession.id);
    track(secondSession.id);
    const options = { requestId: "shared-caller-id" };

    const first = sendPrompt(firstSession.id, "first turn", options);
    const firstCall = await nextQueryCall();
    const second = sendPrompt(secondSession.id, "second turn", options);
    const secondCall = await nextQueryCall();

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(getPromptDispatchState(firstSession.id, options.requestId)).toBe("processing");
    expect(getPromptDispatchState(secondSession.id, options.requestId)).toBe("processing");

    firstCall.push({ type: "result", subtype: "success", result: "first done" });
    secondCall.push({ type: "result", subtype: "success", result: "second done" });
    firstCall.finish();
    secondCall.finish();
    await Promise.all([first, second]);

    expect(getPromptDispatchState(firstSession.id, options.requestId))
      .toBe("already-processed");
    expect(getPromptDispatchState(secondSession.id, options.requestId))
      .toBe("already-processed");
  });

  test("a prompt without a request id is not deduplicated", async () => {
    const session = createSession("no request id");
    track(session.id);

    const first = sendPrompt(session.id, "hello");
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success", result: "hi" });
    call.finish();
    await first;

    const second = sendPrompt(session.id, "hello");
    const secondCall = await nextQueryCall();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    secondCall.push({ type: "result", subtype: "success", result: "hi" });
    secondCall.finish();
    await second;
  });

  test("reports every prompt dispatch state", async () => {
    expect(getPromptDispatchState("missing", "request")).toBe("not-found");
    const session = createSession("dispatch state");
    track(session.id);
    expect(getPromptDispatchState(session.id, "request")).toBe("new");

    session.structuredOutputRequestId = "request";
    session.status = "running";
    expect(getPromptDispatchState(session.id, "request")).toBe("processing");

    session.status = "idle";
    session.structuredOutput = {
      ok: true,
      provider: "claude",
      requestId: "request",
      value: { done: true },
    };
    expect(getPromptDispatchState(session.id, "request")).toBe("already-processed");
    expect(getPromptDispatchState(session.id, "other")).toBe("new");
  });

  test("retains settled dispatches for 24 hours, then garbage-collects them", async () => {
    const originalNow = Date.now;
    let now = Date.parse("2026-07-28T00:00:00.000Z");
    Date.now = () => now;
    const session = createSession("dispatch retention");
    track(session.id);

    async function complete(requestId: string): Promise<void> {
      const prompt = sendPrompt(session.id, requestId, { requestId });
      const call = await nextQueryCall();
      call.push({ type: "result", subtype: "success", result: "done" });
      call.finish();
      await prompt;
    }

    try {
      await complete("retained-request");

      now += 23 * 60 * 60 * 1000;
      await complete("gc-trigger-before-cutoff");
      expect(getPromptDispatchState(session.id, "retained-request"))
        .toBe("already-processed");

      now += 2 * 60 * 60 * 1000;
      await complete("gc-trigger-after-cutoff");
      expect(getPromptDispatchState(session.id, "retained-request")).toBe("new");
      expect(getPromptDispatchState(session.id, "gc-trigger-before-cutoff"))
        .toBe("already-processed");
    } finally {
      Date.now = originalNow;
    }
  });

  test("garbage-collects an abandoned processing claim after the retention window", async () => {
    const originalNow = Date.now;
    let now = Date.parse("2026-07-28T00:00:00.000Z");
    Date.now = () => now;
    const session = createSession("stale processing dispatch");
    track(session.id);
    const prompt = sendPrompt(session.id, "long turn", {
      requestId: "stale-processing-request",
    });
    const call = await nextQueryCall();

    try {
      expect(getPromptDispatchState(session.id, "stale-processing-request"))
        .toBe("processing");

      now += 25 * 60 * 60 * 1000;
      seedSettledPromptDispatchForTesting(session.id, "gc-trigger");

      expect(getPromptDispatchState(session.id, "stale-processing-request"))
        .toBe("new");
    } finally {
      deleteSession(session.id);
      call.push({ type: "result", subtype: "success", result: "done" });
      call.finish();
      await prompt;
      Date.now = originalNow;
    }
  });

  test("does not evict a live tombstone after more than 500 later requests", () => {
    const session = createSession("dispatch volume retention");
    track(session.id);
    seedSettledPromptDispatchForTesting(session.id, "original-request");

    for (let index = 0; index < 501; index += 1) {
      seedSettledPromptDispatchForTesting(session.id, `later-request-${index}`);
    }

    expect(getPromptDispatchState(session.id, "original-request"))
      .toBe("already-processed");
  });

  test("deleting a session removes its prompt-dispatch tombstones", async () => {
    const baseline = getPromptDispatchRecordCountForTesting();
    const session = createSession("dispatch cleanup");
    track(session.id);
    const prompt = sendPrompt(session.id, "run once", {
      requestId: "delete-cleanup-request",
    });
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success", result: "done" });
    call.finish();
    await prompt;

    expect(getPromptDispatchRecordCountForTesting()).toBe(baseline + 1);
    expect(deleteSession(session.id)).toBe(true);
    expect(getPromptDispatchRecordCountForTesting()).toBe(baseline);
    expect(getPromptDispatchState(session.id, "delete-cleanup-request")).toBe("not-found");
  });

  test("an in-flight turn cannot restore its dispatch record after session deletion", async () => {
    const baseline = getPromptDispatchRecordCountForTesting();
    const session = createSession("dispatch cleanup race");
    track(session.id);
    const prompt = sendPrompt(session.id, "run once", {
      requestId: "delete-in-flight-request",
    });
    const call = await nextQueryCall();

    expect(getPromptDispatchRecordCountForTesting()).toBe(baseline + 1);
    expect(deleteSession(session.id)).toBe(true);
    expect(getPromptDispatchRecordCountForTesting()).toBe(baseline);

    call.push({ type: "result", subtype: "success", result: "done" });
    call.finish();
    await prompt;

    expect(getPromptDispatchRecordCountForTesting()).toBe(baseline);
    expect(getPromptDispatchState(session.id, "delete-in-flight-request")).toBe("not-found");
  });

  test("forwards query configuration and captures init, compact, generic system, and context events", async () => {
    mockGetMcpServersForSdk.mockImplementationOnce(async () => ({
      local: { command: "safe-command", args: [] },
    }));
    mockGetMcpServerNames.mockImplementationOnce(async () => new Set(["local"]));
    mockGetPluginsForSdk.mockImplementationOnce(async () => [
      { type: "local", path: "/plugin" },
    ]);
    const { events, stop } = captureEvents();
    const previousCwd = process.env.CWD;
    process.env.CWD = "/project";
    try {
      const { session, call } = await runPromptWithMessages([
        {
          type: "system",
          subtype: "init",
          session_id: "sdk-init",
          mcp_servers: [
            { name: "local", status: "connected", tools: ["search"] },
            { name: "plugin:extra", status: "failed", error: "offline" },
          ],
          plugins: [{ name: "plain", path: "/plain", status: "loaded" }],
          slash_commands: ["/compact"],
        },
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { pre_tokens: 100, post_tokens: 20, trigger: "manual" },
        },
        { type: "system", subtype: "status", detail: "working" },
        {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            context_window_tokens: "200k",
            model: "claude-test",
          },
        },
      ], {
        model: "claude-test",
        effort: "max",
        fastMode: true,
        permissionMode: "bypassPermissions",
      });

      expect(call.options).toMatchObject({
        cwd: "/project",
        model: "claude-test",
        effort: "max",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settings: { fastMode: true },
        mcpServers: { local: { command: "safe-command", args: [] } },
        plugins: [{ type: "local", path: "/plugin" }],
      });

      // Asserted explicitly rather than folded into the `toMatchObject` above:
      // half of these are legitimately `undefined` on this path, and
      // `toMatchObject`/`toEqual` both ignore undefined-valued keys, so an
      // option that silently stopped being forwarded would still pass there.
      expect(call.options.resume).toBeUndefined();
      expect(call.options.sessionId).toBe(session.id.slice("session-".length));
      expect(call.options.agent).toBeUndefined();
      expect(call.options.enableFileCheckpointing).toBe(true);
      expect(call.options.agentProgressSummaries).toBe(true);
      expect(call.options.promptSuggestions).toBe(false);
      expect(call.options.includePartialMessages).toBe(true);
      expect(call.options.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(call.options.settingSources).toEqual(["user", "project"]);
      expect(call.options.systemPrompt).toMatchObject({
        type: "preset",
        preset: "claude_code",
      });
      expect(getSessionInitData(session.id)).toMatchObject({
        mcpServers: [{ name: "local", status: "connected" }],
        plugins: [
          { name: "plugin:extra", status: "failed" },
          { name: "plain", status: "loaded" },
        ],
      });
      expect(events.some((event) => event.type === "system.compact")).toBe(true);
      expect(events.some((event) => event.type === "system.message")).toBe(true);

      // Pinned in full. Every field here is rendered by the UI, and an
      // `objectContaining` on four of them cannot notice the other fourteen
      // regressing — including the cache counters that Issue 12 was about.
      const usageEvent = events.find(
        (event) =>
          event.type === "session.updated"
          && (event.data as { contextUsage?: unknown })?.contextUsage !== undefined,
      );
      const contextUsage = (usageEvent?.data as { contextUsage: SessionUsageSnapshot })
        .contextUsage;
      expect(contextUsage).toEqual({
        usedTokens: 15,
        totalTokens: 200000,
        percentUsed: 0.0075,
        modelId: "claude-test",
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        lastTurnTokens: 15,
        sessionTokens: 15,
        costUsd: 0,
        durationMs: 0,
        apiDurationMs: 0,
        permissionDenials: 0,
        contextCategories: undefined,
        estimated: true,
        source: "claude",
        updatedAt: expect.any(String),
        rateLimits: undefined,
      });
      // `toEqual` ignores undefined-valued keys in Bun, so the key set is
      // asserted separately: without this, a field that stopped being emitted
      // entirely would still satisfy the object above.
      expect(Object.keys(contextUsage).sort()).toEqual([
        "apiDurationMs",
        "cacheReadTokens",
        "cacheWriteTokens",
        "contextCategories",
        "costUsd",
        "durationMs",
        "estimated",
        "inputTokens",
        "lastTurnTokens",
        "modelId",
        "outputTokens",
        "percentUsed",
        "permissionDenials",
        "rateLimits",
        "sessionTokens",
        "source",
        "totalTokens",
        "updatedAt",
        "usedTokens",
      ]);
      expect(getSession(session.id)?.usage).toEqual(contextUsage);
    } finally {
      if (previousCwd === undefined) delete process.env.CWD;
      else process.env.CWD = previousCwd;
      stop();
    }
  });
});
