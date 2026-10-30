import { describe, expect, test } from "bun:test";
import { environmentNameSignal } from "./environment-name-signal";

describe("environmentNameSignal", () => {
  test("maps each pull request state to its colour", () => {
    expect(environmentNameSignal({ waitingOnUser: false, prMergeState: "ready" })).toBe(
      "merge-ready",
    );
    expect(environmentNameSignal({ waitingOnUser: false, prMergeState: "conflicts" })).toBe(
      "merge-conflicts",
    );
    expect(environmentNameSignal({ waitingOnUser: false, prMergeState: null })).toBeNull();
  });

  test("an agent waiting for an answer outranks the pull request", () => {
    expect(environmentNameSignal({ waitingOnUser: true, prMergeState: "ready" })).toBe(
      "needs-answer",
    );
    expect(environmentNameSignal({ waitingOnUser: true, prMergeState: "conflicts" })).toBe(
      "needs-answer",
    );
    expect(environmentNameSignal({ waitingOnUser: true, prMergeState: null })).toBe("needs-answer");
  });
});
