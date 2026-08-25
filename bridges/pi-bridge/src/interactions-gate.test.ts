/**
 * The approval gate with the gate actually on.
 *
 * `interactions.test.ts` exercises the parked-approval machinery directly,
 * because the default is off. This file turns the gate on, so the paths it
 * covers are the ones only `requestToolApproval` itself can take: the
 * read-only bypass, the pending cap, and the timeout — every one of which must
 * deny rather than approve.
 *
 * The gate is read per call rather than at import, so this holds whatever
 * order the suite happens to load these modules in. The timeout is not: it is
 * set before the dynamic import below, and lowered only so a test can prove
 * the denial without waiting five minutes.
 */
import { describe, expect, test } from "bun:test";

process.env.PI_BRIDGE_REQUIRE_APPROVAL = "1";
process.env.PI_BRIDGE_APPROVAL_TIMEOUT_MS = "1000";

const { requestToolApproval, resolveApproval } = await import("./interactions.js");
const { newSessionState } = await import("./agent-session.js");
const { MAX_PENDING_APPROVALS } = await import("./config.js");

describe("requestToolApproval with the gate on", () => {
  test("parks a mutating call and applies the answer it is given", async () => {
    const state = newSessionState();
    const decision = requestToolApproval(state, "call-1", "bash", { command: "rm -rf build" });

    // Parked, and visible to the rehydration route before anything answers.
    expect(state.approvals.size).toBe(1);
    const [id] = [...state.approvals.keys()];
    expect(resolveApproval(state, id!, "allow")).toBe(true);

    expect(await decision).toEqual({ block: false });
    expect(state.approvals.size).toBe(0);
  });

  test("denies with the reason the user gave", async () => {
    const state = newSessionState();
    const decision = requestToolApproval(state, "call-1", "bash", { command: "ls" });
    const [id] = [...state.approvals.keys()];
    resolveApproval(state, id!, "deny", "not on production");

    expect(await decision).toEqual({ block: true, reason: "not on production" });
  });

  test("lets a read-only tool through without asking", async () => {
    const state = newSessionState();
    // Reading is not the thing the gate exists to catch, and parking it would
    // make an approving user answer a prompt per file the model opens.
    expect(await requestToolApproval(state, "call-1", "read", { path: "a.ts" })).toEqual({
      block: false,
    });
    expect(state.approvals.size).toBe(0);
  });

  test("denies rather than parks once the pending cap is reached", async () => {
    const state = newSessionState();
    const parked = [];
    for (let index = 0; index < MAX_PENDING_APPROVALS; index += 1) {
      parked.push(requestToolApproval(state, `call-${index}`, "bash", { command: "ls" }));
    }
    expect(state.approvals.size).toBe(MAX_PENDING_APPROVALS);

    // Approving on a resource limit would run a command nobody saw, and
    // parking it would grow the map without bound.
    const overflow = await requestToolApproval(state, "call-overflow", "bash", { command: "ls" });
    expect(overflow.block).toBe(true);
    expect(overflow.reason).toContain("Too many tool calls");
    expect(state.approvals.size).toBe(MAX_PENDING_APPROVALS);

    // `Array.from`, not a spread: resolving deletes from the map being walked,
    // and a live Map iterator would skip entries.
    for (const [id] of Array.from(state.approvals)) resolveApproval(state, id, "deny");
    await Promise.all(parked);
  });

  test("denies a call nobody answered before it expired", async () => {
    const state = newSessionState();
    const decision = await requestToolApproval(state, "call-1", "bash", { command: "ls" });

    // The timeout is the case that matters most: an unanswered prompt is a
    // prompt nobody saw.
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("expired");
    expect(state.approvals.size).toBe(0);
  }, 10_000);

  test("answers an id it does not know as false rather than throwing", () => {
    const state = newSessionState();
    expect(resolveApproval(state, "never-existed", "allow")).toBe(false);
  });
});
