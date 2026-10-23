import { describe, expect, test } from "bun:test";
import { NATIVE_AGENT_RETIRED_DISPATCH_TTL_MS } from "@orkestrator/protocol/native-agent";
import {
  projectedRetiredDispatch,
  retiredDispatchNotice,
} from "./native-agent-retired-dispatch.js";

const retiredAt = "2026-10-23T10:00:00.000Z";
const at = Date.parse(retiredAt);

describe("projectedRetiredDispatch", () => {
  test("projects a recent marker with the platform's lost-outcome message", () => {
    const retired = projectedRetiredDispatch(
      "claude",
      { retiredDispatch: { requestId: "r-1", retiredAt } },
      at + 1_000,
    );
    expect(retired).toEqual({
      requestId: "r-1",
      retiredAt,
      message:
        "Claude Code could not confirm this message, so it may not have run. Check the conversation and send it again if it did not.",
    });
    expect(retiredDispatchNotice(retired!)).toEqual({
      kind: "warning",
      message: retired!.message,
      occurrenceId: "dispatch-outcome-lost:r-1",
    });
  });

  test("drops an expired, far-future or malformed marker", () => {
    const project = (retiredDispatch: unknown, now = at) =>
      projectedRetiredDispatch("cursor", { retiredDispatch: retiredDispatch as never }, now);
    expect(
      project({ requestId: "r-1", retiredAt }, at + NATIVE_AGENT_RETIRED_DISPATCH_TTL_MS),
    ).toBe(undefined);
    expect(
      project({ requestId: "r-1", retiredAt }, at - NATIVE_AGENT_RETIRED_DISPATCH_TTL_MS),
    ).toBe(undefined);
    expect(project(undefined)).toBeUndefined();
    expect(project({ requestId: 42, retiredAt })).toBeUndefined();
    expect(project({ requestId: " ", retiredAt })).toBeUndefined();
    expect(project({ requestId: "r-1", retiredAt: "not a date" })).toBeUndefined();
    expect(project({ requestId: "r-1" })).toBeUndefined();
  });
});
