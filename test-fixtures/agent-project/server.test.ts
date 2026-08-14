import { expect, test } from "bun:test";

test("fixture marker remains deterministic", () => {
  expect("fixture-v1").toBe("fixture-v1");
});
