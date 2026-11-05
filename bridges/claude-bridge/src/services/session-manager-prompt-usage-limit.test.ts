import { describe, expect, test } from "bun:test";
import { createSession, nextQueryCall, sendPrompt, track } from "./session-manager-test-harness.js";

/**
 * A turn Claude refused because the plan allowance is used up carries the
 * structured `errorCode` beside its error, from the turn's own
 * `rate_limit_event` status rather than the refusal's wording.
 */
describe("usage-limit failure code", () => {
  const rejected = {
    type: "rate_limit_event",
    uuid: "rate-limit-1",
    session_id: "sdk-session",
    rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_900_000_000 },
  };

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
