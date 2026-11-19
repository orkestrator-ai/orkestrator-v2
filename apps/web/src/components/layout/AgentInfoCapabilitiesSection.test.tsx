import { describe, expect, test } from "bun:test";

import { describeVerification } from "./AgentInfoCapabilitiesSection";

describe("describeVerification", () => {
  test("says nothing is confirmed loaded without a runtime report", () => {
    expect(
      describeVerification([
        { level: "present", status: "installed-next-session" },
        { level: "requested", status: "pending" },
      ]),
    ).toBe("1 of 2 checks found the files in place. None is confirmed loaded by the session yet.");
  });

  test("counts what the session confirmed loading and using", () => {
    expect(
      describeVerification([
        { level: "load-confirmed", status: "ready" },
        { level: "observed-in-use", status: "ready" },
        { level: "present", status: "failed" },
      ]),
    ).toBe("2 of 3 checks found the files in place. 2 confirmed loaded by this session, 1 used.");
  });

  test("an empty test has nothing to check", () => {
    expect(describeVerification([])).toBe("Nothing to check.");
  });
});
