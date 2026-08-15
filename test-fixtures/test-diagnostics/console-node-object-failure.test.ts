import { expect, test } from "bun:test";

test("prints a bounded Node-only object diagnostic", () => {
  console.error("intentional node diagnostic canary", {
    payload: "x".repeat(100_000),
    nested: { value: "y".repeat(100_000) },
  });
  expect(false).toBe(true);
});
