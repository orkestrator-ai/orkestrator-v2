import { describe, expect, it } from "bun:test";
import { hasPendingInitialPrompt } from "./reconcile-guards";

describe("hasPendingInitialPrompt", () => {
  it("returns true when initialPrompt exists and has not been sent", () => {
    expect(hasPendingInitialPrompt("do something", false)).toBe(true);
  });

  it("returns false when initialPrompt exists but has already been sent", () => {
    expect(hasPendingInitialPrompt("do something", true)).toBe(false);
  });

  it("returns false when there is no initialPrompt", () => {
    expect(hasPendingInitialPrompt(undefined, false)).toBe(false);
  });

  it("returns false when there is no initialPrompt and sent flag is true", () => {
    expect(hasPendingInitialPrompt(undefined, true)).toBe(false);
  });

  it("returns false for an empty string initialPrompt", () => {
    expect(hasPendingInitialPrompt("", false)).toBe(false);
  });
});
