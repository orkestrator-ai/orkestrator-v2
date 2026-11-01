import { describe, expect, test } from "bun:test";
import { formatLogError, isSafeLogError, logErrorFromWire } from "./log-error.js";

describe("formatLogError", () => {
  test("keeps name, code, errno, syscall and a bounded message", () => {
    const failure = Object.assign(new Error("open failed"), {
      code: "ENOENT",
      errno: -2,
      syscall: "open",
    });
    expect(formatLogError(failure, { stack: false })).toEqual({
      name: "Error",
      message: "open failed",
      code: "ENOENT",
      errno: -2,
      syscall: "open",
    } as never);
  });

  test("marks only its own output as safe", () => {
    expect(isSafeLogError(formatLogError(new Error("x")))).toBe(true);
    expect(isSafeLogError({ name: "Error", message: "x" })).toBe(false);
    expect(Object.isFrozen(formatLogError(new Error("x")))).toBe(true);
  });

  test("never emits an error's other enumerable fields", () => {
    const failure = Object.assign(new Error("x"), {
      request: { headers: { authorization: "private" } },
      response: "private",
      path: "private",
    });
    expect(JSON.stringify(formatLogError(failure))).not.toContain("private");
  });

  test("CommandFailedError: the message is the child's stderr, so it is dropped", () => {
    class CommandFailedError extends Error {
      readonly stdout = "private stdout";
      readonly exitCode = 128;
      readonly signal = null;
      constructor() {
        super("fatal: private stderr");
        this.name = "CommandFailedError";
      }
    }
    const formatted = formatLogError(new CommandFailedError());
    const text = JSON.stringify(formatted);
    expect(text).not.toContain("private");
    expect(formatted.outputOmitted).toBe(true);
    expect(formatted.exitCode).toBe(128);
    expect(formatted.name).toBe("CommandFailedError");
  });

  test("exec and spawn failures: stdout, stderr, cmd and spawnargs never appear", () => {
    const exec = Object.assign(new Error("Command failed: git log --private\nfatal: private"), {
      cmd: "git log --private",
      stdout: "private",
      stderr: "fatal: private",
      code: 128,
    });
    const spawn = Object.assign(new Error("spawn git ENOENT"), {
      spawnargs: ["log", "--private"],
      code: "ENOENT",
      syscall: "spawn git",
    });
    expect(JSON.stringify(formatLogError(exec))).not.toContain("private");
    const spawned = formatLogError(spawn);
    expect(JSON.stringify(spawned)).not.toContain("private");
    expect(spawned).toMatchObject({ code: "ENOENT", syscall: "spawn git", outputOmitted: true });
  });

  test("stack frames come without the message, even one that holds `at` lines", () => {
    const failure = new Error("first line\n    at private (/secret:1:1)\nprivate tail");
    const formatted = formatLogError(failure);
    expect(JSON.stringify(formatted.stack)).not.toContain("private");
    expect(formatted.stack?.length).toBeGreaterThan(0);
    expect(formatted.stack?.every((frame) => frame.startsWith("at "))).toBe(true);
  });

  test("a command failure whose stack header was rewritten gets no frames", () => {
    const failure = Object.assign(new Error("new message"), {
      stdout: "x",
      stack: "Error: old private message\n    at private (/secret:1:1)",
    });
    expect(formatLogError(failure).stack).toBeUndefined();
  });

  test("bounds message and stack, and collapses the message to one line", () => {
    const failure = new Error(`${"m".repeat(5000)}\nsecond`);
    failure.stack = Array.from(
      { length: 50 },
      (_, index) => `    at f${index} (${"p".repeat(500)})`,
    ).join("\n");
    const formatted = formatLogError(failure);
    expect(formatted.message?.length).toBeLessThan(1100);
    expect(formatted.message).toEndWith("...[truncated]");
    expect(formatted.stack).toHaveLength(8);
    expect(formatted.stack?.every((frame) => frame.length < 280)).toBe(true);
    expect(formatLogError(new Error("a\nb\u2028c")).message).toBe("a b c");
  });

  test("redacts credential shapes in the message", () => {
    const formatted = formatLogError(
      new Error("GET https://x.test/a?token=abcdef123456 Bearer abcdefghijklmnop"),
    );
    expect(formatted.message).not.toContain("abcdef123456");
    expect(formatted.message).not.toContain("abcdefghijklmnop");
  });

  test("follows a bounded chain of causes without their stacks", () => {
    const failure = new Error("a", {
      cause: new Error("b", { cause: new Error("c", { cause: new Error("d") }) }),
    });
    const formatted = formatLogError(failure, { stack: false });
    expect(formatted.cause?.message).toBe("b");
    expect(formatted.cause?.stack).toBeUndefined();
    expect(formatted.cause?.cause?.message).toBe("c");
    expect(formatted.cause?.cause?.cause).toBeUndefined();
  });

  test("handles a cause that is a command failure", () => {
    const failure = new Error("wrapped", {
      cause: Object.assign(new Error("private"), { stderr: "private" }),
    });
    expect(JSON.stringify(formatLogError(failure))).not.toContain("private");
  });

  test("an AggregateError keeps its size and first member", () => {
    const failure = new AggregateError(
      [Object.assign(new Error("first"), { code: "EPERM" }), new Error("second")],
      "2 failed",
    );
    const formatted = formatLogError(failure, { stack: false });
    expect(formatted.errorCount).toBe(2);
    expect(formatted.cause).toMatchObject({ message: "first", code: "EPERM" });
    expect(logErrorFromWire(JSON.parse(JSON.stringify(formatted)))?.errorCount).toBe(2);
  });

  test.each([
    ["a string", "boom", { name: "NonError", message: "boom" }],
    ["undefined", undefined, { name: "NonError", message: "[undefined]" }],
    ["a number", 7, { name: "NonError", message: "[number]" }],
    ["a plain object", { secret: "private" }, { name: "NonError", message: "[object]" }],
    ["null", null, { name: "NonError", message: "[object]" }],
  ])("describes %s without its contents", (_label, value, expected) => {
    expect(formatLogError(value)).toEqual(expected as never);
  });

  test("an error-like object is formatted by its message, nothing else", () => {
    expect(formatLogError({ name: "Odd", message: "m", extra: "private" })).toEqual({
      name: "Odd",
      message: "m",
    } as never);
  });

  test("an odd name or code is dropped rather than copied", () => {
    const failure = Object.assign(new Error("m"), { code: "has spaces and private text" });
    failure.name = "private\nname";
    const text = JSON.stringify(formatLogError(failure, { stack: false }));
    expect(text).not.toContain("private");
  });

  test("an object whose getters throw still formats", () => {
    const hostile = new Proxy(new Error("m"), {
      get() {
        throw new Error("private");
      },
    });
    expect(() => formatLogError(hostile)).not.toThrow();
    expect(JSON.stringify(formatLogError(hostile))).not.toContain("private");
  });
});

describe("logErrorFromWire", () => {
  test("rebuilds a relayed error with the same bounds and drops unknown keys", () => {
    const revived = logErrorFromWire({
      name: "Error",
      message: "m".repeat(5000),
      code: "ENOENT",
      stack: [...Array.from({ length: 20 }, () => "at f (a:1:1)"), 7],
      stdout: "private",
      cause: { name: "TypeError", message: "inner" },
    })!;
    expect(isSafeLogError(revived)).toBe(true);
    expect(revived.message?.length).toBeLessThan(1100);
    expect(revived.stack).toHaveLength(8);
    expect(revived.cause?.message).toBe("inner");
    expect(JSON.stringify(revived)).not.toContain("private");
  });

  test.each([[null], ["text"], [{}], [{ name: "bad\nname" }], [[1]]])(
    "%j is not an error",
    (value) => {
      expect(logErrorFromWire(value)).toBeNull();
    },
  );
});
