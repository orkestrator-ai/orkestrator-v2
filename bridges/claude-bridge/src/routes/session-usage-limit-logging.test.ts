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
import sessionRoutes from "./session.js";

/**
 * The prompt route logs a turn's rejection once it settles, on both completion
 * paths: the durable claim (a request id) and the plain background turn. A
 * usage-limit refusal the turn already logged as a warning must not reappear
 * there as an error-level `prompt.processing-failed`, including a refusal known
 * only from the turn's rejected `rate_limit_event`, whose wording no text
 * classifier recognises. Any other failure still does.
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
      test(`${failure.name} ${failure.usageLimited ? "is not" : "is"} a processing failure`, async () => {
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

          const settledLine = failure.usageLimited ? PROCESSING_USAGE_LIMITED : PROCESSING_FAILED;
          const settledSpy = failure.usageLimited ? debugs : errors;
          await waitFor(() => lines(settledSpy).some((line) => line.startsWith(settledLine)));

          expect(session.status).toBe("error");
          if (failure.usageLimited) {
            expect(bridgeErrorLines()).toEqual([]);
            expect(lines(warnings)).toContain(
              "[bridge.claude] prompt.usage-limited errorClass=Error",
            );
          } else {
            expect(session.errorCode).toBeUndefined();
            expect(bridgeErrorLines().some((line) => line.startsWith(PROCESSING_FAILED))).toBe(
              true,
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
