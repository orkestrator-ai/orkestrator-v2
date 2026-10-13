import { describe, expect, test } from "bun:test";
import { backgroundCommandInstruction } from "./background-commands";

describe("backgroundCommandInstruction", () => {
  test("describes the CLI's built-in limits when nothing is configured", () => {
    const text = backgroundCommandInstruction({});
    expect(text).toContain("(30 minutes by default, 2 hours at most)");
    expect(text).toContain("must keep running longer than 2 hours");
  });

  test("follows the configured BASH_MAX_TIMEOUT_MS ceiling", () => {
    const text = backgroundCommandInstruction({ BASH_MAX_TIMEOUT_MS: String(12 * 3_600_000) });
    expect(text).toContain("(30 minutes by default, 12 hours at most)");
    expect(text).toContain("longer than 12 hours");
  });
});
