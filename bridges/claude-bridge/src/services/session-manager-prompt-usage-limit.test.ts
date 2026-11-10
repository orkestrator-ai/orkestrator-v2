import { describe, expect, spyOn, test } from "bun:test";
import { createSession, nextQueryCall, sendPrompt, track } from "./session-manager-test-harness.js";

const rejected = {
  type: "rate_limit_event",
  uuid: "rate-limit-1",
  session_id: "sdk-session",
  rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_900_000_000 },
};

/**
 * A turn Claude refused because the plan allowance is used up carries the
 * structured `errorCode` beside its error, from the turn's own
 * `rate_limit_event` status rather than the refusal's wording.
 */
describe("usage-limit failure code", () => {
  test("a failed turn whose rate_limit_event said rejected reports usage-limit", async () => {
    const session = createSession("usage-limit-rejected");
    track(session.id);

    const prompt = sendPrompt(session.id, "hello");
    const call = await nextQueryCall();
    call.push(rejected);
    // Wording that no text classifier would read as a usage limit.
    call.push({ type: "result", subtype: "success", is_error: true, result: "Request refused." });
    call.finish();

    await expect(prompt).rejects.toThrow();
    expect(session.status).toBe("error");
    expect(session.errorCode).toBe("usage-limit");
  });

  test("a failure without a rejected rate limit carries no code", async () => {
    const session = createSession("usage-limit-allowed");
    track(session.id);

    const prompt = sendPrompt(session.id, "hello");
    const call = await nextQueryCall();
    call.push({ ...rejected, rate_limit_info: { status: "allowed_warning", utilization: 0.91 } });
    call.push({ type: "result", subtype: "success", is_error: true, errors: ["Overloaded"] });
    call.finish();

    await expect(prompt).rejects.toThrow("Overloaded");
    expect(session.status).toBe("error");
    expect(session.errorCode).toBeUndefined();
  });

  test("the next turn clears the code", async () => {
    const session = createSession("usage-limit-cleared");
    track(session.id);

    const first = sendPrompt(session.id, "hello");
    const refused = await nextQueryCall();
    refused.push(rejected);
    refused.push({ type: "result", subtype: "success", is_error: true });
    refused.finish();
    await expect(first).rejects.toThrow();
    expect(session.errorCode).toBe("usage-limit");

    const second = sendPrompt(session.id, "continue");
    const resumed = await nextQueryCall();
    resumed.push({ type: "result", subtype: "success" });
    resumed.finish();
    await second;
    expect(session.status).toBe("idle");
    expect(session.errorCode).toBeUndefined();
  });
});

test.each([
  { isUsingOverage: true },
  { overageInUse: true },
  { overageStatus: "allowed" },
  { overageStatus: "allowed_warning" },
  { laterAllowed: true },
])("overage or a later allowed event does not label an unrelated failure: %j", async (info) => {
  const session = createSession("overage");
  track(session.id);
  const prompt = sendPrompt(session.id, "hello");
  const call = await nextQueryCall();
  call.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected", ...info } });
  if ("laterAllowed" in info) {
    call.push({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  }
  call.push({ type: "result", subtype: "success", is_error: true, errors: ["Unrelated failure"] });
  call.finish();
  await expect(prompt).rejects.toThrow();
  expect(session.errorCode).toBeUndefined();
});

/**
 * A used-up plan allowance is the account's state, reported to the session and
 * acted on by the backend; it is not a bridge failure. Logging it as
 * `prompt.failed` errors buried real failures under every limit a coordinator
 * fleet hit, so it is a warning under its own events instead.
 */
describe("usage-limit log level", () => {
  function captureConsole() {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    const lines = (spy: typeof errors) => spy.mock.calls.map((call) => String(call[0]));
    return {
      errorLines: () => lines(errors),
      warnLines: () => lines(warnings),
      restore: () => {
        errors.mockRestore();
        warnings.mockRestore();
      },
    };
  }

  test("a refusal in the provider's words is a warning, not prompt.failed", async () => {
    const session = createSession("usage-limit-log-text");
    track(session.id);
    const logs = captureConsole();
    try {
      const prompt = sendPrompt(session.id, "hello");
      const call = await nextQueryCall();
      call.push({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You've hit your 5-hour limit · resets 5:30am (Europe/London)",
      });
      call.finish();
      await expect(prompt).rejects.toThrow("You've hit your 5-hour limit");

      expect(session.status).toBe("error");
      expect(session.error).toBe("You've hit your 5-hour limit · resets 5:30am (Europe/London)");
      expect(logs.errorLines().filter((line) => line.includes("[bridge.claude]"))).toEqual([]);
      expect(logs.warnLines()).toContain("[bridge.claude] prompt.usage-limited errorClass=Error");
      expect(
        logs.warnLines().some((line) => line.startsWith("[bridge.claude] query.usage-limited ")),
      ).toBe(true);
    } finally {
      logs.restore();
    }
  });

  test("a rejected rate_limit_event is a warning whatever the result's wording", async () => {
    const session = createSession("usage-limit-log-event");
    track(session.id);
    const logs = captureConsole();
    try {
      const prompt = sendPrompt(session.id, "hello");
      const call = await nextQueryCall();
      call.push(rejected);
      call.push({ type: "result", subtype: "success", is_error: true, result: "Request refused." });
      call.finish();
      const rejection = await prompt.then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(session.errorCode).toBe("usage-limit");
      // The route reads this marker to keep its completion log a non-error:
      // the rejection's own wording does not say it was a usage limit.
      expect((rejection as { usageLimited?: unknown }).usageLimited).toBe(true);
      expect(logs.errorLines().filter((line) => line.includes("[bridge.claude]"))).toEqual([]);
      expect(logs.warnLines()).toContain("[bridge.claude] prompt.usage-limited errorClass=Error");
    } finally {
      logs.restore();
    }
  });

  test("any other failed turn is still logged as prompt.failed", async () => {
    const session = createSession("usage-limit-log-other");
    track(session.id);
    const logs = captureConsole();
    try {
      const prompt = sendPrompt(session.id, "hello");
      const call = await nextQueryCall();
      call.push({ type: "result", subtype: "success", is_error: true, errors: ["Overloaded"] });
      call.finish();
      const rejection = await prompt.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain("Overloaded");
      expect((rejection as { usageLimited?: unknown }).usageLimited).toBeUndefined();

      expect(logs.errorLines()).toContain("[bridge.claude] prompt.failed errorClass=Error");
      expect(
        logs.errorLines().some((line) => line.startsWith("[bridge.claude] query.failed ")),
      ).toBe(true);
      expect(logs.warnLines().filter((line) => line.includes("usage-limited"))).toEqual([]);
    } finally {
      logs.restore();
    }
  });
});
