import { describe, expect, test } from "bun:test";
import { terminalWriteWasDelivered } from "./shared";

describe("terminalWriteWasDelivered", () => {
  test("treats only an explicit false verdict as non-delivery", () => {
    expect(terminalWriteWasDelivered({ delivered: false })).toBe(false);
    expect(terminalWriteWasDelivered({ delivered: true })).toBe(true);
  });

  test("keeps compatibility with backends that omit a delivery verdict", () => {
    for (const value of [undefined, null, {}, { delivered: "false" }, false, "result"]) {
      expect(terminalWriteWasDelivered(value)).toBe(true);
    }
  });
});
