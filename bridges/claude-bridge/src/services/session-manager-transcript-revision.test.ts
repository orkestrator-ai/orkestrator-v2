/**
 * `GET /session/:id/transcript` against the real session manager.
 *
 * The route answers `unchanged` from the session's transcript revision instead
 * of hashing the history, which is only correct if every mutation path marks
 * that revision. Each row below drives one real mutation path and proves the
 * contract end to end: a token taken before the change receives a snapshot,
 * and the token from that snapshot is then answered `unchanged`.
 */
import {
  IDLE_TRANSCRIPT_EVICTION_MS,
  PERSISTED_SDK_ID,
  createSession,
  deleteSession,
  ensurePersistedSession,
  evictIdleHydratedTranscripts,
  getSession,
  materializePersistedSession,
  mockSdkGetSessionMessages,
  nextQueryCall,
  renameSessionDurably,
  sendPrompt,
  setSessionPreferences,
  track,
  transcriptWithToolResult,
  updateSessionPreferences,
  waitFor,
  withTemporaryClaudeHome,
  type QueryCall,
  type SdkSessionMessage,
} from "./session-manager-test-harness.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import {
  abortSession,
  answerIdleSteerPrompt,
  appendLocalCommandResult,
} from "./session-manager.js";
import { transcriptVersionRepairsForTesting } from "./transcript-revision.js";
import sessionRoutes from "../routes/session.js";
import type { NormalizedMessage, SessionState } from "../types/index.js";

const app = new Hono();
app.route("/session", sessionRoutes);

type TranscriptUpdate =
  | { version: 1; status: "unchanged"; token: string }
  | {
      version: 1;
      status: "snapshot";
      token: string;
      value: {
        messages: NormalizedMessage[];
        complete: boolean;
        revision?: number;
        contentEpoch: string;
        freshness: "cached" | "current";
        title?: string;
      };
    };

async function readTranscript(
  routes: Hono,
  id: string,
  knownToken?: string,
): Promise<TranscriptUpdate> {
  const query = new URLSearchParams({ limit: "100", targetBytes: String(512 * 1024) });
  if (knownToken) query.set("knownToken", knownToken);
  const response = await routes.request(`/session/${encodeURIComponent(id)}/transcript?${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as TranscriptUpdate;
}

function snapshot(update: TranscriptUpdate) {
  if (update.status !== "snapshot") throw new Error(`expected a snapshot, got ${update.status}`);
  return update.value;
}

/**
 * Wait until nothing has marked the transcript for a while.
 *
 * A live turn keeps working after the condition a row waits for (coalesced
 * stream flushes, SSE revision stamps). Re-reading before that settles would
 * see a genuine later change, not a stale token.
 */
async function quiesce(session: SessionState): Promise<void> {
  for (;;) {
    const before = [session.transcriptEpoch, session.transcriptRevision].join(":");
    await new Promise((resolve) => setTimeout(resolve, 25));
    if ([session.transcriptEpoch, session.transcriptRevision].join(":") === before) return;
  }
}

interface LiveTurn {
  session: SessionState;
  call: QueryCall;
  finish: () => Promise<void>;
}

async function liveTurn(prelude: unknown[] = [], ready?: (s: SessionState) => boolean) {
  const created = createSession("Fixed title");
  track(created.id);
  const promptPromise = sendPrompt(created.id, "hello");
  const call = await nextQueryCall();
  const session = getSession(created.id)!;
  for (const message of prelude) call.push(message);
  await waitFor(() => session.messages.length >= 1 && (ready?.(session) ?? true));
  await quiesce(session);
  let finished = false;
  return {
    session,
    call,
    finish: async () => {
      if (finished) return;
      finished = true;
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;
    },
  } satisfies LiveTurn;
}

async function idleSession(): Promise<SessionState> {
  const created = createSession("Fixed title");
  track(created.id);
  return getSession(created.id)!;
}

const assistantParts = (session: SessionState) =>
  session.messages.filter((message) => message.role === "assistant").flatMap((m) => m.parts);

function streamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", uuid: "partial-1", parent_tool_use_id: null, event };
}

const toolUse = (id: string, name = "Bash", parent: string | null = null, apiId = "msg_1") => ({
  type: "assistant",
  uuid: `assistant-${id}`,
  parent_tool_use_id: parent,
  message: {
    id: apiId,
    model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", id, name, input: { command: "ls" } }],
  },
});

interface MutationCase {
  name: string;
  /** Build the session and return the one mutation this row is about. */
  setup: () => Promise<{
    session: SessionState;
    mutate: () => Promise<void> | void;
    settled: () => boolean;
    cleanup?: () => Promise<void>;
  }>;
  /** Whether the change replaces the history (a new epoch) or edits it. */
  epoch: "same" | "new";
  check?: (value: ReturnType<typeof snapshot>, session: SessionState) => void;
}

const liveCase = (
  name: string,
  prelude: unknown[],
  ready: ((s: SessionState) => boolean) | undefined,
  pushes: unknown[],
  settled: (s: SessionState) => boolean,
  epoch: "same" | "new" = "same",
): MutationCase => ({
  name,
  epoch,
  setup: async () => {
    const turn = await liveTurn(prelude, ready);
    return {
      session: turn.session,
      mutate: () => {
        for (const message of pushes) turn.call.push(message);
      },
      settled: () => settled(turn.session),
      cleanup: turn.finish,
    };
  },
});

const mutationCases: MutationCase[] = [
  liveCase(
    "streamed text",
    [],
    undefined,
    [
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Answer" },
      }),
    ],
    (s) => s.messages.some((m) => m.role === "assistant" && m.content === "Answer"),
  ),
  liveCase(
    "streamed thinking",
    [],
    undefined,
    [
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Reasoning" },
      }),
    ],
    (s) => assistantParts(s).some((p) => p.type === "thinking" && p.content === "Reasoning"),
  ),
  liveCase("a tool call starting (partial result)", [], undefined, [toolUse("tool-1")], (s) =>
    assistantParts(s).some((p) => p.toolUseId === "tool-1"),
  ),
  liveCase(
    "a tool result completing in place",
    [toolUse("tool-1")],
    (s) => assistantParts(s).some((p) => p.toolUseId === "tool-1"),
    [
      {
        type: "user",
        uuid: "user-result-1",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] },
      },
    ],
    (s) => assistantParts(s).some((p) => p.toolUseId === "tool-1" && p.toolState === "success"),
  ),
  liveCase(
    "nested subagent activity",
    [toolUse("task-1", "Task")],
    (s) => assistantParts(s).some((p) => p.toolUseId === "task-1"),
    [toolUse("child-1", "Read", "task-1", "msg_child")],
    (s) => assistantParts(s).some((p) => p.toolUseId === "child-1"),
  ),
  liveCase(
    "tool progress replacing its part",
    [toolUse("tool-1")],
    (s) => assistantParts(s).some((p) => p.toolUseId === "tool-1"),
    [{ type: "tool_progress", tool_use_id: "tool-1", tool_name: "Bash", elapsed_time_seconds: 3 }],
    (s) => assistantParts(s).some((p) => p.type === "progress"),
  ),
  liveCase(
    "model attribution on an existing assistant message",
    [
      {
        type: "assistant",
        uuid: "assistant-a",
        parent_tool_use_id: null,
        message: { id: "msg_1", content: [{ type: "text", text: "Hello" }] },
      },
    ],
    (s) => s.messages.some((m) => m.role === "assistant"),
    [
      {
        type: "assistant",
        uuid: "assistant-b",
        parent_tool_use_id: null,
        message: {
          id: "msg_1",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Hello" }],
        },
      },
    ],
    (s) => s.messages.some((m) => m.role === "assistant" && m.modelId !== undefined),
  ),
  liveCase(
    "an informational row rewritten in place",
    [
      {
        type: "system",
        subtype: "informational",
        level: "warning",
        content: "Hook blocked the prompt",
        tool_use_id: "tool-9",
      },
    ],
    (s) => s.messages.some((m) => m.content === "Hook blocked the prompt"),
    [
      {
        type: "system",
        subtype: "informational",
        level: "warning",
        content: "Hook blocked the prompt (again)",
        tool_use_id: "tool-9",
      },
    ],
    (s) => s.messages.some((m) => m.content === "Hook blocked the prompt (again)"),
  ),
  liveCase(
    "an API retry row settling in place",
    [{ type: "system", subtype: "api_retry", attempt: 1, error_status: 529 }],
    (s) => s.messages.some((m) => m.parts[0]?.type === "retry"),
    [{ type: "system", subtype: "api_retry", attempt: 2, error_status: 529 }],
    (s) =>
      s.messages.some((m) => m.parts[0]?.type === "retry" && m.parts[0].toolState === "failure"),
  ),
  liveCase(
    "the prompt's transcript uuid arriving with its result",
    [],
    undefined,
    [{ type: "result", subtype: "success", user_message_uuid: "sdk-user-uuid-1" }],
    (s) => s.messages.some((m) => m.sdkUuid === "sdk-user-uuid-1"),
  ),
  liveCase(
    "a conversation reset replacing the history",
    [
      {
        type: "assistant",
        uuid: "assistant-a",
        parent_tool_use_id: null,
        message: { id: "msg_1", content: [{ type: "text", text: "Before reset" }] },
      },
    ],
    (s) => s.messages.some((m) => m.content === "Before reset"),
    [{ type: "conversation_reset", new_conversation_id: "new-id" }],
    (s) => !s.messages.some((m) => m.content === "Before reset"),
    "new",
  ),
  {
    name: "a user interruption notice",
    epoch: "same",
    setup: async () => {
      const turn = await liveTurn();
      return {
        session: turn.session,
        mutate: () => {
          abortSession(turn.session.id);
        },
        settled: () => turn.session.status === "idle",
        cleanup: turn.finish,
      };
    },
  },
  {
    name: "a prompt with an image attachment",
    epoch: "same",
    setup: async () => {
      const session = await idleSession();
      return {
        session,
        mutate: async () => {
          const prompt = sendPrompt(session.id, "look", {
            attachments: [
              {
                type: "image",
                path: "",
                filename: "photo.png",
                dataUrl: "data:image/png;base64,aGVsbG8=",
              },
            ],
          });
          const call = await nextQueryCall();
          call.push({ type: "result", subtype: "success" });
          call.finish();
          await prompt;
        },
        settled: () =>
          session.status === "idle" &&
          session.messages.some((m) => m.content.includes("photo.png")),
      };
    },
  },
  {
    name: "a local command result",
    epoch: "same",
    setup: async () => {
      const session = await idleSession();
      return {
        session,
        mutate: () => appendLocalCommandResult(session, "Local output", "cmd-1"),
        settled: () => session.messages.some((m) => m.content === "Local output"),
      };
    },
  },
  {
    name: "an idle steer exchange",
    epoch: "same",
    setup: async () => {
      const session = await idleSession();
      return {
        session,
        mutate: async () => {
          await answerIdleSteerPrompt(session, "/steer keep going", "steer-1");
        },
        settled: () => session.messages.some((m) => m.id === "idle-steer:steer-1"),
      };
    },
  },
];

describe("GET /session/:id/transcript revisions", () => {
  // Every path in this suite must be recorded by an explicit marker. The O(1)
  // guard in `readTranscriptVersion` repairing a replaced array or a changed
  // length would mean a mutation site was missed.
  let repairsAtStart = 0;
  beforeEach(() => {
    repairsAtStart = transcriptVersionRepairsForTesting();
  });
  afterEach(() => {
    expect(transcriptVersionRepairsForTesting()).toBe(repairsAtStart);
  });

  test.each(mutationCases.map((row) => [row.name, row] as const))(
    "%s invalidates the old token and is then stable",
    async (_name, row) => {
      const { session, mutate, settled, cleanup } = await row.setup();
      try {
        const before = snapshot(await readTranscript(app, session.id));
        const beforeToken = (await readTranscript(app, session.id)).token;
        expect(await readTranscript(app, session.id, beforeToken)).toEqual({
          version: 1,
          status: "unchanged",
          token: beforeToken,
        });

        await mutate();
        await waitFor(settled);
        await quiesce(session);

        const changed = await readTranscript(app, session.id, beforeToken);
        const after = snapshot(changed);
        expect(changed.token).not.toBe(beforeToken);
        expect(after.revision).toBeGreaterThan(before.revision!);
        if (row.epoch === "new") expect(after.contentEpoch).not.toBe(before.contentEpoch);
        else expect(after.contentEpoch).toBe(before.contentEpoch);
        row.check?.(after, session);

        expect((await readTranscript(app, session.id, changed.token)).status).toBe("unchanged");
      } finally {
        await cleanup?.();
      }
    },
  );

  test("hydrating a preview invalidates it, and the hydrated token is stable", async () => {
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());

    const preview = await readTranscript(app, state.id);
    const previewValue = snapshot(preview);
    expect(previewValue).toMatchObject({ complete: false, freshness: "cached", messages: [] });
    expect(previewValue.contentEpoch.startsWith("preview:")).toBe(true);

    await waitFor(() => state.persistedMessagesLoaded === true);
    const hydrated = await readTranscript(app, state.id, preview.token);
    const hydratedValue = snapshot(hydrated);
    expect(hydratedValue).toMatchObject({ complete: true, freshness: "current" });
    expect(hydratedValue.messages.length).toBeGreaterThan(0);
    expect(hydratedValue.contentEpoch.startsWith("hydrated:")).toBe(true);
    expect((await readTranscript(app, state.id, hydrated.token)).status).toBe("unchanged");
  });

  test("installing the local overlay during hydration is part of the new snapshot", async () => {
    await withTemporaryClaudeHome("claude-transcript-overlay-", async () => {
      await updateSessionPreferences(PERSISTED_SDK_ID, {
        localTranscript: [
          {
            id: "idle-steer:overlay",
            role: "user",
            content: "/steer from before the restart",
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      });
      const state = await materializePersistedSession();
      mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());

      const preview = await readTranscript(app, state.id);
      await waitFor(() => state.persistedMessagesLoaded === true);
      const hydrated = await readTranscript(app, state.id, preview.token);
      expect(snapshot(hydrated).messages.map((message) => message.id)).toContain(
        "idle-steer:overlay",
      );
      expect((await readTranscript(app, state.id, hydrated.token)).status).toBe("unchanged");
    });
  });

  test("idle eviction is a cached preview, never the hydrated token's empty transcript", async () => {
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());
    await readTranscript(app, state.id);
    await waitFor(() => state.persistedMessagesLoaded === true);
    const hydrated = await readTranscript(app, state.id);
    const hydratedValue = snapshot(hydrated);

    // Hold the re-hydration the next read starts, so the evicted state is observable.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockSdkGetSessionMessages.mockImplementation(async () => {
      await gate;
      return transcriptWithToolResult();
    });
    expect(evictIdleHydratedTranscripts(Date.now() + IDLE_TRANSCRIPT_EVICTION_MS + 1)).toContain(
      state.id,
    );

    const evicted = await readTranscript(app, state.id, hydrated.token);
    const evictedValue = snapshot(evicted);
    expect(evictedValue).toMatchObject({ complete: false, freshness: "cached", messages: [] });
    expect(evictedValue.contentEpoch).not.toBe(hydratedValue.contentEpoch);

    release();
    await waitFor(() => state.persistedMessagesLoaded === true);
    const rehydrated = await readTranscript(app, state.id, evicted.token);
    expect(snapshot(rehydrated).complete).toBe(true);
    expect((await readTranscript(app, state.id, rehydrated.token)).status).toBe("unchanged");
  });

  test("a title-only rename invalidates without advancing the content revision", async () => {
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => transcriptWithToolResult());
    await readTranscript(app, state.id);
    await waitFor(() => state.persistedMessagesLoaded === true);
    const before = await readTranscript(app, state.id);
    const beforeValue = snapshot(before);

    expect(await renameSessionDurably(state.id, "Renamed")).toBe(true);

    const renamed = await readTranscript(app, state.id, before.token);
    const renamedValue = snapshot(renamed);
    expect(renamedValue.title).toBe("Renamed");
    // The title is its own token component; message content did not change.
    expect(renamedValue.revision).toBe(beforeValue.revision);
    expect(renamedValue.contentEpoch).toBe(beforeValue.contentEpoch);
    expect((await readTranscript(app, state.id, renamed.token)).status).toBe("unchanged");
  });

  test.each([
    [
      "a plan-mode preference change",
      async (session: SessionState) => {
        await setSessionPreferences(session.id, { planMode: true });
      },
    ],
    [
      "a usage-only rate-limit frame in a live turn",
      async (session: SessionState, call?: QueryCall) => {
        call!.push({
          type: "rate_limit_event",
          rate_limit_info: { rateLimitType: "five_hour", utilization: 47 },
        });
        await waitFor(
          () =>
            (session.inProgressUsage?.rateLimits?.length ?? 0) > 0 ||
            (session.rateLimits?.length ?? 0) > 0,
        );
      },
    ],
  ] as const)("%s leaves the transcript token valid", async (name, change) => {
    const turn = name.includes("live turn") ? await liveTurn() : undefined;
    const session = turn?.session ?? (await idleSession());
    try {
      const before = await readTranscript(app, session.id);
      await change(session, turn?.call);
      expect(await readTranscript(app, session.id, before.token)).toEqual({
        version: 1,
        status: "unchanged",
        token: before.token,
      });
    } finally {
      await turn?.finish();
    }
  });

  test("a change made while a hydration is slow is never hidden behind the token", async () => {
    // The local row is written to durable preferences; keep them out of the
    // suite-wide Claude home other tests materialize from.
    await withTemporaryClaudeHome("claude-transcript-slow-", async () => {
      await slowHydrationScenario();
    });
  });

  async function slowHydrationScenario() {
    const state = await materializePersistedSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockSdkGetSessionMessages.mockImplementation(async () => {
      await gate;
      return transcriptWithToolResult();
    });

    const preview = await readTranscript(app, state.id);
    // The hydration this read started is still pending when the row lands.
    appendLocalCommandResult(state, "Output during hydration", "slow-1");
    const during = await readTranscript(app, state.id, preview.token);
    expect(snapshot(during).messages.map((message) => message.content)).toContain(
      "Output during hydration",
    );

    release();
    await waitFor(() => state.persistedMessagesLoaded === true);
    const hydrated = await readTranscript(app, state.id, during.token);
    const contents = snapshot(hydrated).messages.map((message) => message.content);
    // The local row survives through the overlay, alongside the rollout.
    expect(contents).toContain("Output during hydration");
    expect(contents).toContain("all done");
    expect((await readTranscript(app, state.id, hydrated.token)).status).toBe("unchanged");
  }

  test("a prompt's own pre-turn read is a preview until it installs the history", async () => {
    const state = await materializePersistedSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockSdkGetSessionMessages.mockImplementation(async () => {
      await gate;
      return transcriptWithToolResult();
    });

    const prompt = sendPrompt(state.id, "continue");
    // The prompt has claimed the transcript but its read has not returned.
    await waitFor(() => state.persistedHydration !== undefined);
    expect(state.persistedMessagesLoaded).toBe(true);
    const claimed = await readTranscript(app, state.id);
    expect(snapshot(claimed)).toMatchObject({ complete: false, freshness: "cached", messages: [] });

    release();
    const call = await nextQueryCall();
    await waitFor(() => state.messages.some((message) => message.content === "continue"));
    const installed = await readTranscript(app, state.id, claimed.token);
    const installedValue = snapshot(installed);
    expect(installedValue).toMatchObject({ complete: true, freshness: "current" });
    expect(installedValue.messages.map((message) => message.content)).toContain("all done");
    expect(installedValue.contentEpoch).not.toBe(snapshot(claimed).contentEpoch);

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("a stale hydration cannot move a recreated session, whose epoch is new", async () => {
    const first = await materializePersistedSession();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockSdkGetSessionMessages.mockImplementation(async () => {
      await gate;
      return transcriptWithToolResult();
    });
    const oldPreview = await readTranscript(app, first.id);

    // Same bridge id, new session object, while the first read is in flight.
    deleteSession(first.id);
    const second = await ensurePersistedSession(first.id);
    if (!second) throw new Error("expected the session to materialize again");
    expect(second).not.toBe(first);
    second.persistedHydration = new Promise(() => {}); // keep the new object a preview

    const recreated = await readTranscript(app, first.id, oldPreview.token);
    expect(snapshot(recreated).contentEpoch).not.toBe(snapshot(oldPreview).contentEpoch);
    const version = [second.transcriptEpoch, second.transcriptRevision];

    release();
    await waitFor(() => first.persistedHydration === undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The stale completion saw it no longer owned the id and installed nothing.
    expect([second.transcriptEpoch, second.transcriptRevision]).toEqual(version);
    expect(second.messages).toEqual([]);
    expect((await readTranscript(app, first.id, recreated.token)).status).toBe("unchanged");
  });

  test("a token from a previous bridge generation receives a fresh snapshot", async () => {
    const session = await idleSession();
    appendLocalCommandResult(session, "Before restart", "gen-1");
    const beforeShutdown = await readTranscript(app, session.id);

    // A fresh module instance mints its own transcript generation, exactly as a
    // restarted bridge process does, while the session state is unchanged.
    const specifier = "../routes/session.js?generation=restarted";
    const { default: restartedRoutes } = (await import(specifier)) as {
      default: typeof sessionRoutes;
    };
    expect(restartedRoutes).not.toBe(sessionRoutes);
    const restartedApp = new Hono();
    restartedApp.route("/session", restartedRoutes);

    const afterRestart = await readTranscript(restartedApp, session.id, beforeShutdown.token);
    expect(snapshot(afterRestart).messages.map((message) => message.content)).toContain(
      "Before restart",
    );
    expect((await readTranscript(restartedApp, session.id, afterRestart.token)).status).toBe(
      "unchanged",
    );
  });
});

describe("GET /session/:id/transcript serialization cost", () => {
  function persistedHistory(count: number): SdkSessionMessage[] {
    return Array.from({ length: count }, (_, index) => ({
      type: index % 2 === 0 ? "user" : "assistant",
      uuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      session_id: PERSISTED_SDK_ID,
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `message ${index} ${"x".repeat(512)}` }],
      },
      parent_tool_use_id: null,
    }));
  }

  test("an unchanged read of a 1,000-row session visits no message", async () => {
    const state = await materializePersistedSession();
    mockSdkGetSessionMessages.mockImplementation(async () => persistedHistory(1_000));
    await readTranscript(app, state.id);
    await waitFor(() => state.persistedMessagesLoaded === true);
    expect(state.messages).toHaveLength(1_000);

    // Count serialization visits without changing what is serialized. The
    // hook is non-enumerable, so it is not itself transcript content.
    let visits = 0;
    for (const message of state.messages) {
      Object.defineProperty(message, "toJSON", {
        enumerable: false,
        value(this: NormalizedMessage) {
          visits += 1;
          return { ...this };
        },
      });
    }

    const first = await readTranscript(app, state.id);
    expect(snapshot(first).messages.length).toBeLessThanOrEqual(100);
    // A snapshot pays only for its window, never for the whole history.
    expect(visits).toBeGreaterThan(0);
    expect(visits).toBeLessThanOrEqual(3 * 100);

    visits = 0;
    const unchanged = await readTranscript(app, state.id, first.token);
    expect(unchanged.status).toBe("unchanged");
    expect(visits).toBe(0);
  });
});

describe("Claude transcript routes", () => {
  test("every conditional transcript update in the routes passes a revision", () => {
    // The shared helper falls back to hashing the whole history when no
    // revision is given. That branch exists for legacy callers only; a Claude
    // route reaching it would silently reintroduce the linear unchanged read.
    const routesDirectory = join(import.meta.dir, "..", "routes");
    const calls: string[] = [];
    for (const file of readdirSync(routesDirectory)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = readFileSync(join(routesDirectory, file), "utf8");
      for (const match of source.matchAll(/bridgeTranscriptUpdate\(([\s\S]*?)\n\s*\}\),?\n/g)) {
        calls.push(`${file}: ${match[1]}`);
      }
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/\brevision:/);
  });
});
