import { describe, expect, test } from "bun:test";
import { ToolTracker, parseMessageContent } from "./session-manager-messages.js";
import {
  captureEvents,
  createSession,
  getSession,
  nextQueryCall,
  runPromptWithMessages,
  sendPrompt,
  track,
} from "./session-manager-test-harness.js";

function sdkMessage(uuid: string, timestamp: string, content: unknown[]): Record<string, unknown> {
  return { uuid, timestamp, message: { role: "assistant", content } };
}

describe("settle stamps", () => {
  /*
   * A long-running child is shown at the bottom of the transcript while it runs,
   * so the renderer needs to be told where it belongs once it stops. That answer
   * is recorded here, from the record carrying the result — never from this
   * process's clock, which would give a different answer every time the same
   * transcript was replayed.
   */
  const launch = sdkMessage("assistant-1", "2026-08-17T10:00:00.000Z", [
    {
      type: "tool_use",
      id: "task-1",
      name: "Task",
      input: { description: "Review the bridge" },
    },
  ]);
  const result = (isError = false) =>
    sdkMessage("user-1", "2026-08-17T10:04:30.000Z", [
      {
        type: "tool_result",
        tool_use_id: "task-1",
        content: isError ? "boom" : "done",
        is_error: isError,
      },
    ]);

  test.each([[false], [true]])(
    "stamps a child's terminal edge from the record that carried it (error: %s)",
    (isError) => {
      const toolTracker = new ToolTracker();
      parseMessageContent(launch, toolTracker);
      parseMessageContent(result(isError), toolTracker);

      const [part] = toolTracker.getTools();
      expect(part?.toolState).toBe(isError ? "failure" : "success");
      // The result record's own clock, so a replay after a restart reproduces
      // exactly this position rather than "whenever the bridge came back".
      expect(part?.settledAt).toBe("2026-08-17T10:04:30.000Z");
      // Distinct from the launch, which is where the card would otherwise snap
      // back to the moment the child finished.
      expect(part?.settledAt).not.toBe(part?.createdAt);
    },
  );

  test("leaves a child with no result unstamped", () => {
    const toolTracker = new ToolTracker();
    parseMessageContent(launch, toolTracker);

    const [part] = toolTracker.getTools();
    expect(part?.toolState).not.toBe("success");
    // Still running: it belongs at the bottom, and a position would move it off
    // the spot the reader is watching.
    expect(part?.settledAt).toBeUndefined();
  });

  test("keeps the first terminal edge when a later record repeats it", () => {
    const toolTracker = new ToolTracker();
    parseMessageContent(launch, toolTracker);
    parseMessageContent(result(), toolTracker);
    parseMessageContent(
      sdkMessage("user-2", "2026-08-17T11:00:00.000Z", [
        {
          type: "tool_result",
          tool_use_id: "task-1",
          content: "done again",
          is_error: false,
        },
      ]),
      toolTracker,
    );

    // A child settles once. Rewriting the stamp would move a card the reader has
    // already found in its place.
    expect(toolTracker.getTools()[0]?.settledAt).toBe("2026-08-17T10:04:30.000Z");
  });

  test("leaves the stamp off when the record carries no usable timestamp", () => {
    const toolTracker = new ToolTracker();
    parseMessageContent(launch, toolTracker);
    parseMessageContent(
      {
        uuid: "user-1",
        timestamp: "not-a-date",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "task-1",
              content: "done",
              is_error: false,
            },
          ],
        },
      },
      toolTracker,
    );

    const [part] = toolTracker.getTools();
    expect(part?.toolState).toBe("success");
    // No position is better than a wrong one: the card stays in its launch row.
    expect(part?.settledAt).toBeUndefined();
  });

  describe("the caller's fallback clock", () => {
    /*
     * `timestamp` is optional on an SDK record and older emitters omit it, so
     * the caller offers the one clock it assigned this record — receive time
     * live, or the record's position in a materialization on replay. It is a
     * fallback, never an override: a record that dated itself is still the
     * only thing that can reproduce the same answer on the next replay.
     */
    const undatedResult = (timestamp?: string) => ({
      uuid: "user-1",
      ...(timestamp === undefined ? {} : { timestamp }),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "task-1",
            content: "done",
            is_error: false,
          },
        ],
      },
    });

    const settleWith = (result: Record<string, unknown>, fallback?: string) => {
      const toolTracker = new ToolTracker();
      parseMessageContent(launch, toolTracker, undefined, undefined, undefined, fallback);
      parseMessageContent(result, toolTracker, undefined, undefined, undefined, fallback);
      return toolTracker.getTools()[0];
    };

    test("does not override a record that dated itself", () => {
      const part = settleWith(
        undatedResult("2026-08-17T10:04:30.000Z"),
        "2026-08-17T23:59:00.000Z",
      );

      expect(part?.toolState).toBe("success");
      expect(part?.settledAt).toBe("2026-08-17T10:04:30.000Z");
    });

    test("stamps a record that carries no clock of its own", () => {
      const part = settleWith(undatedResult(), "2026-08-17T10:04:30.000Z");

      expect(part?.toolState).toBe("success");
      expect(part?.settledAt).toBe("2026-08-17T10:04:30.000Z");
    });

    test("covers a record whose own clock is unreadable", () => {
      // An unparseable timestamp is no clock at all, so it takes the same path
      // as a missing one rather than leaving the card unplaced.
      const part = settleWith(undatedResult("not-a-date"), "2026-08-17T10:04:30.000Z");

      expect(part?.toolState).toBe("success");
      expect(part?.settledAt).toBe("2026-08-17T10:04:30.000Z");
    });

    test("is ignored when it is itself unreadable", () => {
      const part = settleWith(undatedResult(), "not-a-date");

      expect(part?.toolState).toBe("success");
      expect(part?.settledAt).toBeUndefined();
    });
  });
});

describe("prompt suggestions", () => {
  test("records a suggestion the turn produced", async () => {
    const { session } = await runPromptWithMessages([
      { type: "prompt_suggestion", suggestion: "  Run the tests  " },
    ]);
    expect(session.promptSuggestion).toBe("Run the tests");
  });

  test("ignores a blank suggestion", async () => {
    const { session } = await runPromptWithMessages([
      { type: "prompt_suggestion", suggestion: "   " },
    ]);
    expect(session.promptSuggestion).toBeUndefined();
  });

  test("clears the previous suggestion when the next turn starts", async () => {
    const session = createSession("suggesting");
    track(session.id);

    const first = sendPrompt(session.id, "one");
    const firstCall = await nextQueryCall();
    firstCall.push({ type: "prompt_suggestion", suggestion: "Run the tests" });
    firstCall.finish();
    await first;
    expect(getSession(session.id)?.promptSuggestion).toBe("Run the tests");

    const { events, stop } = captureEvents();
    try {
      const second = sendPrompt(session.id, "two");
      const secondCall = await nextQueryCall();

      // Nothing else clears it, and GET /session/:id replays the snapshot on
      // every mount, restore and reconnect — so a consumed suggestion would be
      // resurrected turns later.
      expect(getSession(session.id)?.promptSuggestion).toBeUndefined();
      const cleared = events.find(
        (event) =>
          event.type === "session.updated" &&
          event.sessionId === session.id &&
          (event.data as object | undefined) !== undefined &&
          "promptSuggestion" in (event.data as object),
      );
      // JSON preserves null, so it is the explicit wire-level clear signal.
      expect(cleared).toBeDefined();
      expect((cleared!.data as { promptSuggestion?: string | null }).promptSuggestion).toBeNull();

      secondCall.finish();
      await second;
    } finally {
      stop();
    }

    expect(getSession(session.id)?.promptSuggestion).toBeUndefined();
  });
});
