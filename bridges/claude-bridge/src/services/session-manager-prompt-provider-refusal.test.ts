import { describe, expect, spyOn, test } from "bun:test";
import { createSession, nextQueryCall, sendPrompt, track } from "./session-manager-test-harness.js";

/**
 * A turn the provider refused on the account's or the service's state (a
 * failing API, a refused login) is reported to the session in the provider's
 * words; nothing in the bridge failed. `bridge.claude:query.failed` was mostly
 * those (a Cloudflare 403 on every open session at once), which buried the
 * failures that are the bridge's, so they are warnings under their own events.
 * The session's error and status are unchanged.
 */

function captureConsole() {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const lines = (spy: typeof errors) => spy.mock.calls.map((call) => String(call[0]));
  return {
    bridgeErrorLines: () => lines(errors).filter((line) => line.includes("[bridge.claude]")),
    warnLines: () => lines(warnings),
    restore: () => {
      errors.mockRestore();
      warnings.mockRestore();
    },
  };
}

/** The synthetic reply Claude Code writes for a model request that failed. */
function apiErrorReply(error: string, text: string, parentToolUseId: string | null = null) {
  return {
    type: "assistant",
    uuid: `api-error-${error}`,
    session_id: "sdk-session",
    parent_tool_use_id: parentToolUseId,
    error,
    message: {
      id: `msg-${error}`,
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text }],
    },
  };
}

const answer = {
  type: "assistant",
  uuid: "answer-1",
  session_id: "sdk-session",
  parent_tool_use_id: null,
  message: {
    id: "msg-answer",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "Recovered." }],
  },
};

async function runFailedTurn(name: string, frames: Record<string, unknown>[]) {
  const session = createSession(name);
  track(session.id);
  const prompt = sendPrompt(session.id, "hello");
  const call = await nextQueryCall();
  for (const frame of frames) call.push(frame);
  call.finish();
  const rejection = await prompt.then(
    () => undefined,
    (error: unknown) => error,
  );
  return { session, rejection };
}

describe("provider refusal log level", () => {
  test("a turn that ended on a server error is a warning, not query.failed", async () => {
    const logs = captureConsole();
    try {
      const { session, rejection } = await runFailedTurn("provider-refusal-server", [
        apiErrorReply("server_error", "API Error: 500 Internal server error."),
        {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 500,
          result: "API Error: 500 Internal server error.",
        },
      ]);

      expect(rejection).toBeInstanceOf(Error);
      expect(session.status).toBe("error");
      expect(session.error).toBe("Claude ended the turn on an API error.");
      expect(session.errorCode).toBeUndefined();
      // The route reads this marker to keep its own completion log a non-error.
      expect((rejection as { providerRefused?: unknown }).providerRefused).toBe(true);
      expect((rejection as { usageLimited?: unknown }).usageLimited).toBeUndefined();
      expect(logs.bridgeErrorLines()).toEqual([]);
      expect(logs.warnLines()).toContain(
        "[bridge.claude] prompt.provider-refused errorClass=Error reason=server_error",
      );
      expect(
        logs
          .warnLines()
          .some((line) =>
            line.startsWith(
              "[bridge.claude] query.provider-refused reason=server_error apiStatus=500 ",
            ),
          ),
      ).toBe(true);
    } finally {
      logs.restore();
    }
  });

  test("a request the bridge built wrongly is still query.failed, with its code", async () => {
    const logs = captureConsole();
    try {
      const { rejection } = await runFailedTurn("provider-refusal-invalid", [
        apiErrorReply("invalid_request", "API Error: 400 invalid tool schema"),
        { type: "result", subtype: "success", is_error: true, api_error_status: 400 },
      ]);

      expect((rejection as { providerRefused?: unknown }).providerRefused).toBeUndefined();
      expect(logs.bridgeErrorLines()).toContain("[bridge.claude] prompt.failed errorClass=Error");
      const failed = logs
        .bridgeErrorLines()
        .find((line) => line.startsWith("[bridge.claude] query.failed "));
      expect(failed).toContain("subtype=success");
      expect(failed).toContain("isError=true");
      expect(failed).toContain("reason=invalid_request");
      expect(failed).toContain("apiStatus=400");
      expect(logs.warnLines().filter((line) => line.includes("provider-refused"))).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  test("a real answer after the failed request clears its code", async () => {
    const logs = captureConsole();
    try {
      await runFailedTurn("provider-refusal-recovered", [
        apiErrorReply("overloaded", "API Error: 529 Overloaded"),
        answer,
        { type: "result", subtype: "error_during_execution", is_error: true },
      ]);

      expect(
        logs.bridgeErrorLines().some((line) => line.startsWith("[bridge.claude] query.failed ")),
      ).toBe(true);
      expect(logs.warnLines().filter((line) => line.includes("provider-refused"))).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  test("a subagent's failed request does not decide the root turn's fate", async () => {
    const logs = captureConsole();
    try {
      await runFailedTurn("provider-refusal-subagent", [
        apiErrorReply("overloaded", "API Error: 529 Overloaded", "toolu-task-1"),
        { type: "result", subtype: "error_during_execution", is_error: true },
      ]);

      expect(
        logs.bridgeErrorLines().some((line) => line.startsWith("[bridge.claude] query.failed ")),
      ).toBe(true);
      expect(logs.warnLines().filter((line) => line.includes("provider-refused"))).toEqual([]);
    } finally {
      logs.restore();
    }
  });
});
