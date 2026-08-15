import { expect, test } from "bun:test";

test("prints a bounded DOM and error diagnostic", () => {
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Context window");
  button.textContent = "x".repeat(100_000);
  document.body.append(button);
  console.error("intentional diagnostic canary", button, new Error("canary failure"));
  expect(false).toBe(true);
});
