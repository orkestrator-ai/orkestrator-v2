import { describe, expect, test } from "bun:test";
import {
  isProvisionalOpenCodeMessage,
  MAX_STREAM_MESSAGES,
  OpenCodeStreamState,
} from "./opencode-stream-state.js";

describe("OpenCodeStreamState turn clock", () => {
  test("beginTurn stamps and rejectTurn clears only the matching dispatch", () => {
    const state = new OpenCodeStreamState();
    state.beginTurn("session", 1_000);
    expect(state.turnStartedAt("session")).toBe(1_000);

    state.rejectTurn("session", 999);
    expect(state.turnStartedAt("session")).toBe(1_000);

    state.rejectTurn("session", 1_000);
    expect(state.turnStartedAt("session")).toBeUndefined();
  });

  test("ensureTurnStarted backfills once and keeps the first observation", () => {
    const state = new OpenCodeStreamState();
    expect(state.ensureTurnStarted("session", 1_000)).toBe(1_000);
    expect(state.ensureTurnStarted("session", 5_000)).toBe(1_000);
    expect(state.turnStartedAt("session")).toBe(1_000);
  });

  test("ensureTurnStarted ignores a stale expected event version", () => {
    const state = new OpenCodeStreamState();
    state.apply({
      type: "session.updated",
      properties: { sessionID: "session", info: { id: "session", title: "Streamed" } },
    } as never);
    const version = state.eventVersion("session");

    expect(state.ensureTurnStarted("session", 2_000, version - 1)).toBeUndefined();
    expect(state.turnStartedAt("session")).toBeUndefined();

    expect(state.ensureTurnStarted("session", 2_000, version)).toBe(2_000);
    expect(state.turnStartedAt("session")).toBe(2_000);
  });

  test("terminal events clear the turn clock", () => {
    const state = new OpenCodeStreamState();

    state.beginTurn("session", 1_000);
    state.apply({
      type: "session.error",
      properties: { sessionID: "session", error: { name: "ProviderError" } },
    } as never);
    expect(state.turnStartedAt("session")).toBeUndefined();

    state.beginTurn("session", 2_000);
    state.apply({
      type: "session.deleted",
      properties: { sessionID: "session", info: { id: "session" } },
    } as never);
    expect(state.turnStartedAt("session")).toBeUndefined();

    state.beginTurn("session", 3_000);
    state.apply({
      type: "session.status",
      properties: { sessionID: "session", status: { type: "idle" } },
    } as never);
    expect(state.turnStartedAt("session")).toBeUndefined();

    state.beginTurn("session", 4_000);
    state.apply({ type: "session.idle", properties: { sessionID: "session" } } as never);
    expect(state.turnStartedAt("session")).toBeUndefined();
  });

  test("busy and retry events establish the clock from observation time", () => {
    const state = new OpenCodeStreamState();

    state.apply(
      {
        type: "session.status",
        properties: { sessionID: "session", status: { type: "busy" } },
      } as never,
      7_000,
    );
    expect(state.turnStartedAt("session")).toBe(7_000);

    state.apply(
      {
        type: "session.status",
        properties: { sessionID: "session", status: { type: "retry" } },
      } as never,
      8_000,
    );
    expect(state.turnStartedAt("session")).toBe(7_000);
  });

  test("retry status keeps the turn running and publishes an advisory", () => {
    const state = new OpenCodeStreamState();
    state.apply(
      {
        type: "session.status",
        properties: {
          sessionID: "session",
          status: { type: "retry", attempt: 2, message: "Provider timed out" },
        },
      } as never,
      9_000,
    );
    expect(state.turnStartedAt("session")).toBe(9_000);
    expect(state.notices("session")).toEqual([
      {
        kind: "advisory",
        severity: "warning",
        message: "OpenCode is retrying the model request (attempt 2). Provider timed out",
      },
    ]);
  });

  test("retry status falls back when attempt or message is omitted", () => {
    const state = new OpenCodeStreamState();
    state.apply(
      {
        type: "session.status",
        properties: { sessionID: "session", status: { type: "retry" } },
      } as never,
      9_000,
    );
    expect(state.notices("session")).toEqual([
      {
        kind: "advisory",
        severity: "warning",
        message:
          "OpenCode is retrying the model request. The model request failed and is being retried.",
      },
    ]);

    state.apply(
      {
        type: "session.status",
        properties: {
          sessionID: "session",
          status: { type: "retry", message: "Provider timed out" },
        },
      } as never,
      9_500,
    );
    expect(state.notices("session")).toEqual([
      {
        kind: "advisory",
        severity: "warning",
        message: "OpenCode is retrying the model request. Provider timed out",
      },
    ]);
  });

  test("clears the retry advisory once the retried request is busy again", () => {
    const state = new OpenCodeStreamState();
    state.apply(
      {
        type: "session.status",
        properties: {
          sessionID: "session",
          status: { type: "retry", attempt: 1, message: "Provider timed out" },
        },
      } as never,
      9_000,
    );
    expect(state.notices("session")).toHaveLength(1);

    state.apply(
      {
        type: "session.status",
        properties: { sessionID: "session", status: { type: "busy" } },
      } as never,
      9_500,
    );
    expect(state.notices("session")).toEqual([]);
    expect(state.turnStartedAt("session")).toBe(9_000);
  });

  test("keeps the retry advisory across an authoritative transcript read", () => {
    const state = new OpenCodeStreamState();
    state.apply({
      type: "session.status",
      properties: {
        sessionID: "session",
        status: { type: "retry", attempt: 1, message: "Provider timed out" },
      },
    } as never);
    expect(state.replaceMessages("session", [])).toBe(true);
    expect(state.notices("session")).toHaveLength(1);

    state.apply({
      type: "session.status",
      properties: { sessionID: "session", status: { type: "idle" } },
    } as never);
    expect(state.notices("session")).toEqual([]);
  });

  test("a retry that needs the user fails the turn until the next one starts", () => {
    const state = new OpenCodeStreamState();
    const retry = {
      type: "session.status",
      properties: {
        sessionID: "session",
        status: {
          type: "retry",
          attempt: 1,
          message: "Upgrade to continue - https://opencode.ai/pricing",
          action: {
            reason: "free_tier_limit",
            provider: "opencode",
            title: "Free limit reached",
            message: "Subscribe to OpenCode Go.",
            label: "subscribe",
            link: "https://opencode.ai/pricing",
          },
          next: 1,
        },
      },
    } as never;
    const failure = {
      kind: "error" as const,
      message: "Free limit reached: Subscribe to OpenCode Go. https://opencode.ai/pricing",
    };
    state.beginTurn("session", 1_000);
    expect(state.apply(retry)).toEqual({
      sessionId: "session",
      status: "running",
      abortTurn: true,
    });
    expect(state.turnStartedAt("session")).toBeUndefined();
    expect(state.notices("session")).toEqual([failure]);
    // The provider coalesces in-flight aborts; a later event can retry a failed one.
    expect(state.apply(retry)).toEqual({
      sessionId: "session",
      status: "running",
      abortTurn: true,
    });

    state.apply({
      type: "session.error",
      properties: {
        sessionID: "session",
        error: { name: "MessageAbortedError", data: { message: "Aborted" } },
      },
    } as never);
    state.apply({
      type: "session.status",
      properties: { sessionID: "session", status: { type: "idle" } },
    } as never);
    expect(state.replaceMessages("session", [])).toBe(true);
    expect(state.notices("session")).toEqual([failure]);

    state.beginTurn("session", 2_000);
    expect(state.notices("session")).toEqual([]);
  });

  test("reconciliation clears a retry advisory after an SSE gap", () => {
    const state = new OpenCodeStreamState();
    state.apply({
      type: "session.status",
      properties: { sessionID: "session", status: { type: "retry", message: "temporary" } },
    } as never);
    state.markGap();
    state.endTurn("session");
    state.replaceMessages("session", []);
    expect(state.notices("session")).toEqual([]);
  });

  test("a renewed busy status clears an action failure", () => {
    const state = new OpenCodeStreamState();
    state.apply({
      type: "session.status",
      properties: {
        sessionID: "session",
        status: { type: "retry", action: { title: "Limit reached" } },
      },
    } as never);
    expect(state.turnFailure("session")?.message).toBe("Limit reached");
    state.apply({
      type: "session.status",
      properties: { sessionID: "session", status: { type: "busy" } },
    } as never);
    expect(state.turnFailure("session")).toBeUndefined();
    expect(state.notices("session")).toEqual([]);
  });

  test("session deletion discards the action failure and all cached notices", () => {
    const state = new OpenCodeStreamState();
    state.apply({
      type: "session.status",
      properties: {
        sessionID: "session",
        status: { type: "retry", action: { title: "Limit reached" } },
      },
    } as never);
    state.apply({ type: "session.deleted", properties: { sessionID: "session" } } as never);
    expect(state.turnFailure("session")).toBeUndefined();
    expect(state.notices("session")).toEqual([]);
  });

  test("keeps the first session error after a dispatch for that request", () => {
    const state = new OpenCodeStreamState();
    const error = (name: string, message?: string) =>
      state.apply(
        {
          type: "session.error",
          properties: {
            sessionID: "session",
            error: { name, data: message === undefined ? {} : { message } },
          },
        } as never,
        5_000,
      );
    // An error with no dispatch from this backend is not attributed.
    error("UnknownError", "external turn failed");
    expect(state.dispatchFailure("session", "request-1")).toBeUndefined();

    state.beginTurn("session", 1_000, "request-1");
    // A user stop is not a dispatch failure.
    error("MessageAbortedError");
    expect(state.dispatchFailure("session", "request-1")).toBeUndefined();
    error(
      "UnknownError",
      "ImageDecodeError: Image could not be decoded\n    at catch (/$bunfs/root/chunk.js:1:1)",
    );
    error("UnknownError", "a later error");
    expect(state.dispatchFailure("session", "request-1")).toEqual({
      requestId: "request-1",
      message: "ImageDecodeError: Image could not be decoded",
      observedAt: 5_000,
    });
    expect(state.dispatchFailure("session", "request-2")).toBeUndefined();

    // The next dispatch starts clean.
    state.beginTurn("session", 6_000, "request-2");
    expect(state.dispatchFailure("session", "request-1")).toBeUndefined();
    expect(state.dispatchFailure("session", "request-2")).toBeUndefined();
  });

  test.each([false, true])(
    "rejected dispatch clears error ownership; ambiguous=%s retains it",
    (ambiguous) => {
      const state = new OpenCodeStreamState();
      const error = (message: string) =>
        state.apply(
          {
            type: "session.error",
            properties: {
              sessionID: "session",
              error: { name: "UnknownError", data: { message } },
            },
          } as never,
          5_000,
        );
      state.beginTurn("session", 1_000, "previous");
      error("previous failure");
      state.beginTurn("session", 2_000, "next");
      expect(state.dispatchFailure("session", "previous")).toBeUndefined();
      // session.error already cleared the visible clock when the send rejects.
      error("next failure");
      state.rejectTurn("session", 1_000);
      expect(state.dispatchFailure("session", "next")?.message).toBe("next failure");
      state.rejectTurn("session", 2_000, ambiguous);
      error("late error");
      expect(state.turnStartedAt("session")).toBeUndefined();
      expect(state.dispatchFailure("session", "next")?.message).toBe(
        ambiguous ? "next failure" : undefined,
      );
    },
  );

  test("attributes a late error to an ambiguous dispatch after its visible clock is cleared", () => {
    const state = new OpenCodeStreamState();
    state.beginTurn("session", 1_000, "ambiguous-request");
    state.rejectTurn("session", 1_000, true);
    state.apply(
      {
        type: "session.error",
        properties: {
          sessionID: "session",
          error: { name: "UnknownError", data: { message: "Image decode failed" } },
        },
      } as never,
      2_000,
    );
    expect(state.turnStartedAt("session")).toBeUndefined();
    expect(state.dispatchFailure("session", "ambiguous-request")).toEqual({
      requestId: "ambiguous-request",
      message: "Image decode failed",
      observedAt: 2_000,
    });
  });

  test("session.updated records the provider session model", () => {
    const state = new OpenCodeStreamState();
    state.apply({
      type: "session.updated",
      properties: {
        sessionID: "session",
        info: {
          id: "session",
          title: "Investigation",
          model: { providerID: "opencode-go", id: "deepseek-v4-flash", variant: "default" },
        },
      },
    } as never);
    expect(state.sessionModel("session")).toEqual({
      modelId: "opencode-go/deepseek-v4-flash",
      reasoningId: "default",
    });
  });
});

describe("OpenCodeStreamState usage ledger", () => {
  function message(id: string, input: number, cacheRead = 0) {
    return {
      info: {
        id,
        sessionID: "session",
        role: "assistant",
        tokens: { input, output: 0, cache: { read: cacheRead, write: 0 } },
        cost: 0.01,
        time: { created: 1, completed: 2 },
      },
      parts: [],
    };
  }

  test("keeps session and cache totals after a later snapshot replaces the transcript tail", () => {
    const state = new OpenCodeStreamState();
    const full = Array.from({ length: 80 }, (_, index) => message(`message-${index}`, 10, 100));
    expect(state.replaceMessages("session", full)).toBe(true);

    const tail = full.slice(-10);
    expect(state.replaceMessages("session", tail)).toBe(true);

    const usage = state.contextUsage("session", tail);
    expect(usage).toMatchObject({
      usedTokens: 110,
      inputTokens: 800,
      cacheReadTokens: 8_000,
      sessionTokens: 8_800,
    });
    expect(usage?.costUsd).toBeCloseTo(0.8);
  });

  test("records usage from message.updated after the transcript cache is dirty", () => {
    const state = new OpenCodeStreamState();
    const full = Array.from({ length: MAX_STREAM_MESSAGES }, (_, index) =>
      message(`message-${index}`, 1),
    );
    expect(state.replaceMessages("session", full)).toBe(true);

    state.apply({
      type: "message.updated",
      properties: { sessionID: "session", info: message("message-new-1", 1).info },
    } as never);
    expect(state.currentMessages("session")).toBeUndefined();

    state.apply({
      type: "message.updated",
      properties: { sessionID: "session", info: message("message-new-2", 1).info },
    } as never);

    expect(state.currentMessages("session")).toBeUndefined();
    expect(state.contextUsage("session", [])).toMatchObject({
      inputTokens: MAX_STREAM_MESSAGES + 2,
      sessionTokens: MAX_STREAM_MESSAGES + 2,
    });
  });

  test("records usage from message.updated during a gap before rehydration", () => {
    const state = new OpenCodeStreamState();
    expect(state.replaceMessages("session", [message("seed", 4)])).toBe(true);
    state.markGap();
    expect(state.currentMessages("session")).toBeUndefined();

    state.apply({
      type: "message.updated",
      properties: { sessionID: "session", info: message("after-gap-1", 3).info },
    } as never);
    state.apply({
      type: "message.updated",
      properties: { sessionID: "session", info: message("after-gap-2", 5).info },
    } as never);

    expect(state.currentMessages("session")).toBeUndefined();
    expect(state.contextUsage("session", [])).toMatchObject({
      inputTokens: 12,
      sessionTokens: 12,
    });
  });

  test("keeps lifetime spend after message.removed drops the transcript row", () => {
    const state = new OpenCodeStreamState();
    expect(state.replaceMessages("session", [message("keep", 2), message("drop", 7)])).toBe(true);

    state.apply({
      type: "message.removed",
      properties: { sessionID: "session", messageID: "drop" },
    } as never);

    expect(
      state.currentMessages("session")?.map((candidate) => {
        const info = (candidate as { info?: { id?: string } }).info;
        return info?.id;
      }),
    ).toEqual(["keep"]);
    expect(state.contextUsage("session")).toMatchObject({
      inputTokens: 9,
      sessionTokens: 9,
    });
  });
});

describe("OpenCodeStreamState touch", () => {
  test("moves a tracked session's revision without an event, and ignores unknown ones", () => {
    const state = new OpenCodeStreamState();
    state.register("session");
    const revision = state.revision("session");
    const eventVersion = state.eventVersion("session");

    state.touch("session");
    state.touch("unknown");

    expect(state.revision("session")).toBe(revision + 1);
    // Not an event: dispatch reconciliation keyed on event versions is unaffected.
    expect(state.eventVersion("session")).toBe(eventVersion);
    expect(state.revision("unknown")).toBe(0);
  });
});

describe("OpenCodeStreamState history paging", () => {
  const message = (id: string) => ({
    info: { id, sessionID: "session", role: "assistant", time: { created: 1 } },
    parts: [],
  });

  test("only a read shorter than it asked for proves the cache starts the session", () => {
    const state = new OpenCodeStreamState();
    state.replaceMessages("session", [message("a"), message("b")], undefined, 64);
    expect(state.currentMessagesFromStart("session")).toBe(true);
    // Streamed steps extend a window without changing where it starts.
    state.apply({
      type: "message.updated",
      properties: { sessionID: "session", info: message("c").info },
    } as never);
    expect(state.currentMessagesFromStart("session")).toBe(true);

    state.replaceMessages("session", [message("a"), message("b")], undefined, 2);
    expect(state.currentMessagesFromStart("session")).toBe(false);
    state.replaceMessages("session", [message("a")]);
    expect(state.currentMessagesFromStart("session")).toBe(false);
    // A dirty cache proves nothing.
    state.replaceMessages("session", [message("a")], undefined, 64);
    state.markGap();
    expect(state.currentMessagesFromStart("session")).toBe(false);
  });

  test("the history epoch survives appends and edits but not removals", () => {
    const state = new OpenCodeStreamState();
    state.replaceMessages("session", [message("a"), message("b")], undefined, 64);
    const initial = state.historyEpoch("session");
    state.apply({
      type: "message.updated",
      properties: { sessionID: "session", info: message("c").info },
    } as never);
    state.replaceMessages("session", [message("a"), message("b"), message("c")], undefined, 64);
    expect(state.historyEpoch("session")).toBe(initial);

    state.apply({
      type: "message.removed",
      properties: { sessionID: "session", messageID: "a" },
    } as never);
    const afterRemoval = state.historyEpoch("session");
    expect(afterRemoval).not.toBe(initial);

    // A removal seen while the cache is dirty still rewrote history.
    state.markGap();
    state.apply({
      type: "message.removed",
      properties: { sessionID: "session", messageID: "b" },
    } as never);
    expect(state.historyEpoch("session")).not.toBe(afterRemoval);
  });

  test("a reconnect keeps the epoch unless the re-read proves history was rewritten", () => {
    const state = new OpenCodeStreamState();
    const seeded = ["a", "b", "c", "d"].map(message);
    state.replaceMessages("session", seeded, undefined, 64);
    const initial = state.historyEpoch("session");

    // A gap whose re-read holds the same history, plus a step streamed since.
    state.markGap();
    expect(state.historyEpoch("session")).toBe(initial);
    let version = state.eventVersion("session");
    expect(state.replaceMessages("session", [...seeded, message("e")], version, 64)).toBe(true);
    expect(state.historyEpoch("session")).toBe(initial);

    // Reconnects that see nothing change keep paging alive across them.
    for (let pass = 0; pass < 3; pass += 1) {
      state.markGap();
      version = state.eventVersion("session");
      state.replaceMessages("session", [...seeded, message("e")], version, 64);
    }
    expect(state.historyEpoch("session")).toBe(initial);

    // A message removed while the stream was down never arrives as an event;
    // only the re-read shows it, and that is what moves the epoch.
    state.markGap();
    version = state.eventVersion("session");
    state.replaceMessages("session", ["a", "b", "d", "e"].map(message), version, 64);
    expect(state.historyEpoch("session")).not.toBe(initial);
  });

  test("a removal is caught after reconnect even when a read during the outage already shows it", () => {
    const state = new OpenCodeStreamState();
    state.replaceMessages("session", ["a", "b", "c"].map(message), undefined, 64);
    const initial = state.historyEpoch("session");
    state.markGap();
    // A display read while the stream is down already reflects the revert. It
    // mints cursors from the rewritten history, which must not stay valid.
    state.replaceMessages("session", ["a", "b"].map(message), undefined, 64);
    const duringOutage = state.historyEpoch("session");
    expect(duringOutage).not.toBe(initial);

    // A second removal during the same outage is checked against that read.
    state.replaceMessages("session", ["a"].map(message), undefined, 64);
    expect(state.historyEpoch("session")).not.toBe(duringOutage);
    const afterSecond = state.historyEpoch("session");

    // The reconnect's own read matches and ends verification.
    state.markGap();
    const version = state.eventVersion("session");
    state.replaceMessages("session", ["a"].map(message), version, 64);
    expect(state.historyEpoch("session")).toBe(afterSecond);
  });

  test("a re-read that shares nothing with a long cache cannot prove continuity", () => {
    const state = new OpenCodeStreamState();
    state.replaceMessages("session", ["a", "b"].map(message), undefined, 2);
    const initial = state.historyEpoch("session");
    state.markGap();
    state.replaceMessages("session", ["x", "y"].map(message), state.eventVersion("session"), 2);
    expect(state.historyEpoch("session")).not.toBe(initial);
  });

  test("notes messages changed in place, newest first, including during a gap", () => {
    const state = new OpenCodeStreamState();
    state.replaceMessages("session", ["a", "b", "c"].map(message), undefined, 64);
    state.apply({
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: { id: "p1", messageID: "a", type: "text", text: "late" },
      },
    } as never);
    state.apply({
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: { id: "p2", messageID: "b", type: "text", text: "late" },
      },
    } as never);
    expect(state.revisedMessageIds("session")).toEqual(["b", "a"]);

    state.apply({
      type: "message.removed",
      properties: { sessionID: "session", messageID: "b" },
    } as never);
    expect(state.revisedMessageIds("session")).toEqual(["a"]);

    // A tool result that lands while the stream is down is found by the
    // re-read's content check rather than by an event.
    const cached = state.currentMessages("session")!;
    state.markGap();
    const reread = cached.map((entry) =>
      (entry as { info: { id: string } }).info.id === "c"
        ? { ...(entry as object), parts: [{ id: "p3", messageID: "c", type: "text", text: "x" }] }
        : entry,
    );
    state.replaceMessages("session", reread, state.eventVersion("session"), 64);
    expect(state.revisedMessageIds("session")).toEqual(["c", "a"]);
  });

  test("streaming the newest message, or a new one, notes nothing", () => {
    const state = new OpenCodeStreamState();
    state.replaceMessages("session", ["a", "b"].map(message), undefined, 64);
    const part = (messageID: string, id: string) =>
      state.apply({
        type: "message.part.updated",
        properties: { sessionID: "session", part: { id, messageID, type: "text", text: "x" } },
      } as never);
    part("b", "p1");
    part("c", "p2");
    part("c", "p3");
    expect(state.revisedMessageIds("session")).toEqual([]);
    // Once a newer message exists, a change to an older one is a revision.
    part("b", "p4");
    expect(state.revisedMessageIds("session")).toEqual(["b"]);
  });

  test("a message created from a part event is provisional until OpenCode reports it", () => {
    const state = new OpenCodeStreamState();
    state.replaceMessages("session", [message("a")], undefined, 64);
    state.apply({
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: { id: "p1", messageID: "b", type: "text", text: "early" },
      },
    } as never);
    const placeholder = state.currentMessages("session")!.at(-1);
    expect(isProvisionalOpenCodeMessage(placeholder)).toBe(true);
    expect(isProvisionalOpenCodeMessage(state.currentMessages("session")![0])).toBe(false);
    state.apply({
      type: "message.updated",
      properties: { sessionID: "session", info: message("b").info },
    } as never);
    expect(isProvisionalOpenCodeMessage(state.currentMessages("session")!.at(-1))).toBe(false);
  });

  test("epochs are never reused by another instance or a session seen again", () => {
    const first = new OpenCodeStreamState();
    const second = new OpenCodeStreamState();
    expect(first.historyEpoch("session")).not.toBe(second.historyEpoch("session"));
    const before = first.historyEpoch("session");
    first.clear();
    expect(first.historyEpoch("session")).not.toBe(before);
  });
});

test.each(["rejected", "throwing"])(
  "a %s reconnect read cannot leave a stale gap baseline after stream recovery",
  (failure) => {
    const state = new OpenCodeStreamState();
    const row = (id: string) => ({
      info: { id, role: "assistant", time: { created: 1 } },
      parts: [],
    });
    state.replaceMessages("session", [row("a"), row("b")], undefined, 2);
    const epoch = state.historyEpoch("session");
    state.markGap();
    const version = state.eventVersion("session");
    state.apply({
      type: "session.status",
      properties: { sessionID: "session", status: { type: "busy" } },
    } as never);
    if (failure === "rejected")
      expect(state.replaceMessages("session", [row("stale")], version, 2)).toBe(false);
    // A throwing read never reaches replacement. An unguarded reconcile recovers.
    state.replaceMessages("session", [row("a"), row("b")], undefined, 2);
    state.replaceMessages("session", [row("a"), row("b")], undefined, 2);
    for (let i = 0; i < 70; i++)
      state.apply({
        type: "message.updated",
        properties: { sessionID: "session", info: row(`new-${i}`).info },
      } as never);
    state.replaceMessages(
      "session",
      Array.from({ length: 64 }, (_, i) => row(`new-${i + 6}`)),
      undefined,
      64,
    );
    expect(state.historyEpoch("session")).toBe(epoch);
  },
);

describe("OpenCodeStreamState fork model seed", () => {
  const sessionUpdated = (sessionID: string, id: string, variant?: string) =>
    ({
      type: "session.updated",
      properties: {
        sessionID,
        info: { id: sessionID, model: { providerID: "opencode-go", id, variant } },
      },
    }) as never;

  test("prefers the fork's own model, then the source's streamed model", () => {
    const state = new OpenCodeStreamState();
    state.apply(sessionUpdated("source", "deepseek-v4.1-flash", "high"));

    state.seedForkedSessionModel(
      "fork-a",
      { id: "fork-a", model: { providerID: "opencode-go", id: "kimi-k3" } },
      "source",
    );
    expect(state.sessionModel("fork-a")).toEqual({ modelId: "opencode-go/kimi-k3" });

    state.seedForkedSessionModel("fork-b", { id: "fork-b" }, "source");
    expect(state.sessionModel("fork-b")).toEqual({
      modelId: "opencode-go/deepseek-v4.1-flash",
      reasoningId: "high",
    });

    state.seedForkedSessionModel("fork-c", { id: "fork-c" }, "unknown-source");
    expect(state.sessionModel("fork-c")).toEqual({});
  });

  test("never overwrites a model the stream already reported for the fork", () => {
    const state = new OpenCodeStreamState();
    state.apply(sessionUpdated("fork", "glm-5", "max"));
    state.seedForkedSessionModel(
      "fork",
      { id: "fork", model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } },
      "source",
    );
    expect(state.sessionModel("fork")).toEqual({
      modelId: "opencode-go/glm-5",
      reasoningId: "max",
    });
  });
});
