import { describe, expect, test } from "bun:test";
import { shellCommandEligibility } from "./shell-command";

const complete = { language: "bash", closed: true, live: false, clipped: false };

describe("shellCommandEligibility", () => {
  test("accepts a complete single-line shell command", () => {
    expect(shellCommandEligibility({ ...complete, source: "bun test ./src/a.test.ts" })).toEqual({
      ok: true,
      command: "bun test ./src/a.test.ts",
    });
    expect(shellCommandEligibility({ ...complete, source: "ls -la\n" })).toEqual({
      ok: true,
      command: "ls -la",
    });
    expect(
      shellCommandEligibility({ ...complete, language: "console", source: "$ git status" }),
    ).toEqual({
      ok: true,
      command: "git status",
    });
  });

  test.each([
    [{ language: "ts" }, "not-shell"],
    [{ language: null }, "not-shell"],
    [{ closed: false }, "incomplete"],
    [{ clipped: true }, "clipped"],
    [{ live: true }, "streaming"],
  ])("refuses %p (%s)", (override, reason) => {
    expect(shellCommandEligibility({ ...complete, source: "echo hi", ...override })).toEqual({
      ok: false,
      reason: reason as never,
    });
  });

  test("refuses multi-line commands, continuations and hidden characters", () => {
    expect(shellCommandEligibility({ ...complete, source: "echo a\necho b" })).toMatchObject({
      reason: "multi-line",
    });
    expect(shellCommandEligibility({ ...complete, source: "echo a\r\necho b" })).toMatchObject({
      reason: "multi-line",
    });
    expect(shellCommandEligibility({ ...complete, source: "make build \\" })).toMatchObject({
      reason: "continuation",
    });
    expect(shellCommandEligibility({ ...complete, source: "cat file |" })).toMatchObject({
      reason: "continuation",
    });
    expect(shellCommandEligibility({ ...complete, source: "true &&" })).toMatchObject({
      reason: "continuation",
    });
    expect(shellCommandEligibility({ ...complete, source: "cat <<EOF" })).toMatchObject({
      reason: "continuation",
    });
    expect(
      shellCommandEligibility({ ...complete, source: `rm -rf ${String.fromCharCode(0x202e)}/tmp` }),
    ).toMatchObject({
      reason: "hidden-characters",
    });
    expect(
      shellCommandEligibility({ ...complete, source: `echo${String.fromCharCode(0x200b)}hi` }),
    ).toMatchObject({
      reason: "hidden-characters",
    });
    expect(shellCommandEligibility({ ...complete, source: "echo\u0007" })).toMatchObject({
      reason: "hidden-characters",
    });
    expect(shellCommandEligibility({ ...complete, source: "   " })).toMatchObject({
      reason: "empty",
    });
  });
});

test("pathological near-matches stay bounded by the command length cap", () => {
  const started = performance.now();
  for (let n = 10; n <= 500; n += 10)
    shellCommandEligibility({
      source: "www.".repeat(n) + "x/a.ts:1",
      language: "bash",
      closed: true,
      live: false,
      clipped: false,
    });
  expect(performance.now() - started).toBeLessThan(250);
});
