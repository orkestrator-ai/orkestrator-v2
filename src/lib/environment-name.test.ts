import { describe, expect, test } from "bun:test";
import { isDefaultTimestampEnvironmentName } from "./environment-name";

describe("environment name helpers", () => {
  test("recognizes legacy timestamp names", () => {
    expect(isDefaultTimestampEnvironmentName("20260415-123456")).toBe(true);
  });

  test("recognizes compact Electron timestamp names", () => {
    expect(isDefaultTimestampEnvironmentName("202604151234567")).toBe(true);
  });

  test("does not treat descriptive names as default timestamps", () => {
    expect(isDefaultTimestampEnvironmentName("review-oauth-flow")).toBe(false);
    expect(isDefaultTimestampEnvironmentName("20260415123456")).toBe(false);
  });
});
