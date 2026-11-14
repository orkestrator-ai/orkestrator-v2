import { describe, expect, test } from "bun:test";
import type { RoutingToolCall } from "./coordinator-live-routing.js";
import {
  evaluateLaunchDefaultsOmitted,
  evaluateListAgentsNotPolled,
  evaluateRequestIdsFresh,
  requestIdUsage,
} from "./coordinator-live-wording.js";

const call = (
  tool: string,
  args: Record<string, unknown> | undefined,
  state = "success",
): RoutingToolCall => ({ tool, row: 0, args, state });

describe("launch defaults", () => {
  test("launches without agent, modelId or reasoningId pass", () => {
    const result = evaluateLaunchDefaultsOmitted("investigate", [
      call("launch_environment", { requestId: "a", name: "w" }),
      call("launch_job", { requestId: "b", environmentId: "e" }),
    ]);
    expect(result).toEqual({
      name: "investigate-launch-defaults-omitted",
      passed: true,
      detail: "2 launches, none set agent, modelId, reasoningId",
    });
  });

  test("a case with no launch passes; delegation is the case's own check", () => {
    expect(evaluateLaunchDefaultsOmitted("review", [call("launch_multi_review", {})]).passed).toBe(
      true,
    );
  });

  test("any chosen field fails, named without its value", () => {
    const result = evaluateLaunchDefaultsOmitted("investigate", [
      call("launch_job", { requestId: "a", reasoningId: "secret-effort" }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.detail).toBe("1 launches; set reasoningId though the user named none");
  });

  test("a successful launch with unreadable arguments fails closed; a failed one is not judged", () => {
    expect(evaluateLaunchDefaultsOmitted("x", [call("launch_environment", undefined)]).passed).toBe(
      false,
    );
    expect(
      evaluateLaunchDefaultsOmitted("x", [call("launch_environment", undefined, "error")]).passed,
    ).toBe(true);
  });
});

describe("request ids", () => {
  test("distinct ids pass, and an exact retry under its id is allowed", () => {
    const calls = [
      call("create_ticket", { requestId: "a", title: "t" }),
      call("create_ticket", { title: "t", requestId: "a" }),
      call("start_build_pipeline", { requestId: "b", taskId: "t" }),
    ];
    expect(requestIdUsage(calls)).toEqual({ withRequestId: 3, distinct: 2, retries: 1, reused: 0 });
    expect(evaluateRequestIdsFresh(calls).passed).toBe(true);
  });

  test("argument order does not make a retry look like a new call", () => {
    const calls = [
      call("launch_job", { requestId: "a", options: { x: 1, y: 2 } }),
      call("launch_job", { options: { y: 2, x: 1 }, requestId: "a" }),
    ];
    expect(requestIdUsage(calls).reused).toBe(0);
  });

  test("one id for another tool or other arguments fails and names no id", () => {
    const calls = [
      call("create_ticket", { requestId: "same-id", title: "one" }),
      call("create_ticket", { requestId: "same-id", title: "two" }),
      call("launch_environment", { requestId: "other", name: "w" }),
      call("start_build_pipeline", { requestId: "other", taskId: "t" }),
    ];
    const result = evaluateRequestIdsFresh(calls);
    expect(result.passed).toBe(false);
    expect(result.detail).toBe(
      "4 calls with 2 request ids, 0 exact retries, 2 ids reused for another call",
    );
    expect(result.detail).not.toContain("same-id");
  });

  test("a scenario where no call carried a request id fails", () => {
    expect(evaluateRequestIdsFresh([call("list_environments", {})])).toEqual({
      name: "request-ids-fresh",
      passed: false,
      detail: "no call carried a request id",
    });
  });
});

test("list_agents may be read once per case, not polled", () => {
  expect(evaluateListAgentsNotPolled("c", [call("list_agents", {})]).passed).toBe(true);
  const polled = evaluateListAgentsNotPolled("c", [
    call("list_agents", {}),
    call("list_agents", {}),
  ]);
  expect(polled).toEqual({
    name: "c-list-agents-not-polled",
    passed: false,
    detail: "2 list_agents calls",
  });
});
