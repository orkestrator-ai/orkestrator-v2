import { describe, test, expect } from "bun:test";
import { formatElapsed } from "./format-elapsed";

describe("formatElapsed", () => {
  test("formats 0 seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
  });

  test("formats seconds under a minute", () => {
    expect(formatElapsed(1)).toBe("1s");
    expect(formatElapsed(30)).toBe("30s");
    expect(formatElapsed(59)).toBe("59s");
  });

  test("formats exactly 60 seconds as 1m 0s", () => {
    expect(formatElapsed(60)).toBe("1m 0s");
  });

  test("formats minutes and seconds", () => {
    expect(formatElapsed(90)).toBe("1m 30s");
    expect(formatElapsed(125)).toBe("2m 5s");
  });

  test("formats large values", () => {
    expect(formatElapsed(3661)).toBe("61m 1s");
  });
});
