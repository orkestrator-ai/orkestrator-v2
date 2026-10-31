import { expect, test } from "bun:test";
import { resolveSessionTitleGenerationPolicy } from "./session-title-generation.js";

test("only an absent title policy uses the sharing default", () => {
  expect(resolveSessionTitleGenerationPolicy(undefined)).toBe("any-signed-in");
  for (const invalid of [null, "", "future-policy", 42, false, {}]) {
    expect(resolveSessionTitleGenerationPolicy(invalid)).toBe("off");
  }
  for (const policy of ["any-signed-in", "own-platform", "off"] as const) {
    expect(resolveSessionTitleGenerationPolicy(policy)).toBe(policy);
  }
});
