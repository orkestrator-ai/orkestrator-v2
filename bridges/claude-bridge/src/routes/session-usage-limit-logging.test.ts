import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { configureLogger } from "@orkestrator/protocol/logger";
import {
  createSession,
  nextQueryCall,
  track,
  waitFor,
  withTemporaryClaudeHome,
} from "../services/session-manager-test-harness.js";
import { markTurnFailureReported } from "../services/session-manager-prompt-turn-lifecycle.js";
import sessionRoutes, { logPromptProcessingFailure } from "./session.js";

/**
 * The prompt route logs a turn's rejection once it settles, on both completion
 * paths: the durable claim (a request id) and the plain background turn. A
 * usage-limit refusal the turn already logged as a warning must not reappear
 * there as an error-level `prompt.processing-failed`, including a refusal known
 * only from the turn's rejected `rate_limit_event`, whose wording no text
 * classifier recognises. Nor may any other failure the turn already logged as
 * `prompt.failed`: one failed turn is one error in the diagnostics, and the
 * route keeps its copy (with the message) at debug as
 * `prompt.processing-reported`. Only a rejection the turn never reported is a
 * `prompt.processing-failed` error.
 */

const app = new Hono().route("/session", sessionRoutes);

const rejected = {
  type: "rate_limit_event",
  uuid: "rate-limit-1",
  session_id: "sdk-session",
  rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_900_000_000 },
};

const PROCESSING_FAILED = "[bridge.claude] prompt.processing-failed";
const PROCESSING_USAGE_LIMITED = "[bridge.claude] prompt.processing-usage-limited";
const PROCESSING_REPORTED = "[bridge.claude] prompt.processing-reported";
const PROMPT_FAILED = "[bridge.claude] prompt.failed";

let errors: ReturnType<typeof spyOn<Console, "error">>;
let warnings: ReturnType<typeof spyOn<Console, "warn">>;
let debugs: ReturnType<typeof spyOn<Console, "debug">>;
const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => String(call[0]));
const bridgeErrorLines = () => lines(errors).filter((line) => line.includes("[bridge.claude]"));

beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  warnings = spyOn(console, "warn").mockImplementation(() => {});
  debugs = spyOn(console, "debug").mockImplementation(() => {});
  configureLogger({ areaLevels: { "bridge.claude": "debug" } });
});

afterEach(() => {
  configureLogger({ areaLevels: {} });
  errors.mockRestore();
  warnings.mockRestore();
  debugs.mockRestore();
});

type Failure = {
  name: string;
  events: Record<string, unknown>[];
  usageLimited: boolean;
};

const failures: Failure[] = [
  {
    name: "a refusal in the provider's words",
    events: [
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You've hit your 5-hour limit · resets 5:30am (Europe/London)",
      },
    ],
    usageLimited: true,
  },
  {
    name: "a rejected rate_limit_event with generic wording",
    // Wording that no text classifier would read as a usage limit.
    events: [
      rejected,
      { type: "result", subtype: "success", is_error: true, result: "Request refused." },
    ],
    usageLimited: true,
  },
  {
    name: "an ordinary failure",
    events: [{ type: "result", subtype: "success", is_error: true, errors: ["Overloaded"] }],
    usageLimited: false,
  },
];

for (const withRequestId of [true, false]) {
  describe(`POST /session/:id/prompt ${withRequestId ? "with" : "without"} a request id`, () => {
    for (const failure of failures) {
      test(`${failure.name} ${failure.usageLimited ? "is not an error" : "is logged as one error"}`, async () => {
        await withTemporaryClaudeHome("claude-usage-limit-route-", async () => {
          const session = createSession(`usage-limit-route-${failure.name}`);
          track(session.id);

          const response = app.request(`/session/${session.id}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: "hello",
              ...(withRequestId ? { requestId: `usage-limit-${failure.name}` } : {}),
            }),
          });
          // The durable claim answers only once the turn's query has started.
          const call = await nextQueryCall();
          expect((await response).status).toBe(202);
          for (const event of failure.events) call.push(event);
          call.finish();

          const settledLine = failure.usageLimited ? PROCESSING_USAGE_LIMITED : PROCESSING_REPORTED;
          await waitFor(() => lines(debugs).some((line) => line.startsWith(settledLine)));

          expect(session.status).toBe("error");
          if (failure.usageLimited) {
            expect(bridgeErrorLines()).toEqual([]);
            expect(lines(warnings)).toContain(
              "[bridge.claude] prompt.usage-limited errorClass=Error",
            );
          } else {
            expect(session.errorCode).toBeUndefined();
            // The turn's own report is the one error for this failure.
            expect(bridgeErrorLines().filter((line) => line.startsWith(PROMPT_FAILED))).toEqual([
              "[bridge.claude] prompt.failed errorClass=Error",
            ]);
            expect(bridgeErrorLines().some((line) => line.startsWith(PROCESSING_FAILED))).toBe(
              false,
            );
            expect(lines(debugs).some((line) => line.startsWith(PROCESSING_USAGE_LIMITED))).toBe(
              false,
            );
          }
          if (failure.events.includes(rejected)) {
            expect(session.errorCode).toBe("usage-limit");
          }
        });
      });
    }
  });
}

/**
 * A turn the provider refused on another account or service state (a failing
 * API here) is logged by the turn as `prompt.provider-refused`; the route's
 * completion log must not report it again as a processing failure.
 */
for (const withRequestId of [true, false]) {
  test(`a provider refusal is not a processing failure ${withRequestId ? "with" : "without"} a request id`, async () => {
    await withTemporaryClaudeHome("claude-provider-refusal-route-", async () => {
      const session = createSession(`provider-refusal-route-${withRequestId}`);
      track(session.id);

      const response = app.request(`/session/${session.id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "hello",
          ...(withRequestId ? { requestId: "provider-refusal-route" } : {}),
        }),
      });
      const call = await nextQueryCall();
      expect((await response).status).toBe(202);
      call.push({
        type: "assistant",
        uuid: "api-error-server",
        session_id: "sdk-session",
        parent_tool_use_id: null,
        error: "server_error",
        message: {
          id: "msg-api-error",
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "API Error: 500 Internal server error." }],
        },
      });
      call.push({ type: "result", subtype: "success", is_error: true, api_error_status: 500 });
      call.finish();

      await waitFor(() =>
        lines(debugs).some((line) =>
          line.startsWith("[bridge.claude] prompt.processing-provider-refused"),
        ),
      );
      expect(session.status).toBe("error");
      expect(bridgeErrorLines()).toEqual([]);
      expect(lines(warnings)).toContain(
        "[bridge.claude] prompt.provider-refused errorClass=Error reason=server_error",
      );
    });
  });
}
describe("logPromptProcessingFailure", () => {
  test("a rejection the turn never reported is a processing failure", () => {
    logPromptProcessingFailure(new Error("Join failed before submission"));

    expect(bridgeErrorLines()).toHaveLength(1);
    expect(bridgeErrorLines()[0]).toStartWith(PROCESSING_FAILED);
    expect(lines(debugs).some((line) => line.startsWith(PROCESSING_REPORTED))).toBe(false);
  });

  test("a non-error rejection, which cannot be marked, is a processing failure", () => {
    logPromptProcessingFailure("failed");

    expect(bridgeErrorLines()).toHaveLength(1);
    expect(bridgeErrorLines()[0]).toStartWith(PROCESSING_FAILED);
  });

  test("a rejection the turn reported stays at debug with its message", () => {
    const error = new Error("Claude ended the turn on an API error.");
    markTurnFailureReported(error);

    logPromptProcessingFailure(error);

    expect(bridgeErrorLines()).toEqual([]);
    const reported = lines(debugs).filter((line) => line.startsWith(PROCESSING_REPORTED));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("Claude ended the turn on an API error.");
  });
});
