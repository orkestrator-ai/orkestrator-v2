import { describe, expect, test } from "bun:test";
import { externalRevertCut } from "./external-revert.js";

const turn = (turnId: string | undefined) => [
  { role: "user" as const, ...(turnId ? { turnId } : {}) },
  { role: "assistant" as const, ...(turnId ? { turnId } : {}) },
];

describe("externalRevertCut", () => {
  test("cuts at the first message whose turn no longer exists", () => {
    const messages = [...turn("t1"), ...turn("t2"), ...turn("t3")];
    expect(externalRevertCut(messages, ["t1"], false)).toBe(2);
    expect(externalRevertCut(messages, [], false)).toBe(0);
  });

  test("leaves a transcript that already matches alone (our own rewind's echo)", () => {
    expect(externalRevertCut([...turn("t1"), ...turn("t2")], ["t1", "t2"], false)).toBeUndefined();
  });

  test("without turn ids, counts one turn per user message while idle", () => {
    const messages = [...turn(undefined), ...turn(undefined), ...turn(undefined)];
    expect(externalRevertCut(messages, ["a", "b"], false)).toBe(4);
    expect(externalRevertCut(messages, ["a", "b", "c"], false)).toBeUndefined();
    // A running turn may not be in app-server's list yet.
    expect(externalRevertCut(messages, ["a", "b"], true)).toBeUndefined();
  });
});
