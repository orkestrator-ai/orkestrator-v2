import { describe, expect, test } from "bun:test";
import { isDefaultTimestampEnvironmentName } from "./environment-name";

describe("isDefaultTimestampEnvironmentName", () => {
  test("matches stored default timestamp names", () => {
    expect(isDefaultTimestampEnvironmentName("202606201234567")).toBe(true);
  });

  test("matches older hyphenated timestamp names", () => {
    expect(isDefaultTimestampEnvironmentName("20260620-123456")).toBe(true);
  });

  test("does not match custom names", () => {
    expect(isDefaultTimestampEnvironmentName("review-oauth-callback")).toBe(false);
  });
});
