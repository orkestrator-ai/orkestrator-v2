import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installFatalRejectionGuard } from "./fatal-rejections.js";
import { formatLogError } from "./log-error.js";
import { redactSecrets } from "./secret-redaction.js";
import { SECRET_REDACTION_FIXTURES } from "./testing/secret-redaction-fixtures.js";

type Listener = (reason: unknown) => void;

function fakeProcess() {
  const listeners: Listener[] = [];
  return {
    listeners,
    on(_event: "unhandledRejection", listener: Listener) {
      listeners.push(listener);
      return this;
    },
    off(_event: "unhandledRejection", listener: Listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
      return this;
    },
  };
}

describe("fatal rejection guard", () => {
  test("serialized workers can install the guard without module dependencies", () => {
    const install = new Function(
      `return (${installFatalRejectionGuard.toString()})`,
    )() as typeof installFatalRejectionGuard;
    const target = fakeProcess();
    const warnings: string[] = [];
    install({
      label: "[worker]",
      force: true,
      onProcess: target,
      warn: (message) => warnings.push(message),
    });
    target.listeners[0]!(new Error("fixture"));
    expect(warnings[0]).toContain("[worker] Unhandled promise rejection (continuing): fixture");
  });
  test("reports an Error by name, message and stack", () => {
    const target = fakeProcess();
    const warnings: string[] = [];
    installFatalRejectionGuard({
      label: "[Backend]",
      force: true,
      warn: (message) => warnings.push(message),
      onProcess: target,
    });

    const abort = new DOMException("The operation was aborted.", "AbortError");
    target.listeners[0]?.(abort);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[Backend] Unhandled promise rejection (continuing)");
    // The name is the only part that identifies an abort; its message is generic.
    expect(warnings[0]).toContain("AbortError: The operation was aborted.");
  });

  test("reports non-Error rejection values without throwing", () => {
    const target = fakeProcess();
    const warnings: string[] = [];
    installFatalRejectionGuard({
      label: "[claude-bridge]",
      force: true,
      warn: (message) => warnings.push(message),
      onProcess: target,
    });

    for (const reason of [undefined, null, "plain string", 42, { code: "E_NOPE" }]) {
      expect(() => target.listeners[0]?.(reason)).not.toThrow();
    }
    expect(warnings).toHaveLength(5);
    expect(warnings[4]).toContain("[object Object] code=E_NOPE keys=1");
  });

  test("survives a reason that cannot be serialized", () => {
    const target = fakeProcess();
    const warnings: string[] = [];
    installFatalRejectionGuard({
      label: "[Backend]",
      force: true,
      warn: (message) => warnings.push(message),
      onProcess: target,
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => target.listeners[0]?.(circular)).not.toThrow();
    expect(warnings[0]).toContain("[object Object]");
  });

  describe("what it writes", () => {
    /** Everything but the prefix, which the live A/B runner counts by its exact text. */
    function reported(reason: unknown): string {
      const target = fakeProcess();
      const warnings: string[] = [];
      installFatalRejectionGuard({
        label: "[Backend]",
        force: true,
        warn: (message) => warnings.push(message),
        onProcess: target,
      });
      target.listeners[0]!(reason);
      expect(warnings).toHaveLength(1);
      const prefix = "[Backend] Unhandled promise rejection (continuing): ";
      expect(warnings[0]!.startsWith(prefix)).toBe(true);
      return warnings[0]!.slice(prefix.length);
    }
    /** 1 KiB of text, 16 frames of 240 characters, and their separators. */
    const MAX_REPORT_CHARS = 5_200;

    test("an oversized stack is capped to bounded frames", () => {
      const error = new Error("boom");
      error.stack = [
        "Error: boom",
        ...Array.from(
          { length: 5_000 },
          (_, index) => `    at f${index} (${"p".repeat(2_000)}:1:1)`,
        ),
      ].join("\n");
      const text = reported(error);
      expect(text.length).toBeLessThan(MAX_REPORT_CHARS);
      expect(text).toStartWith("boom | at f0 ");
      expect(text).toContain("at f15 ");
      expect(text).not.toContain("at f16 ");
    });

    test("an oversized message is cut", () => {
      const text = reported(new Error("m".repeat(1_000_000)));
      expect(text.length).toBeLessThan(MAX_REPORT_CHARS);
      expect(text).toContain("...[truncated]");
    });

    test("an oversized string is cut", () => {
      expect(reported("s".repeat(1_000_000)).length).toBeLessThanOrEqual(1024);
    });

    test("an arbitrary object is described by shape, never by its contents", () => {
      const text = reported({
        prompt: "PRIVATE",
        "PRIVATE key": 1,
        stdout: "PRIVATE".repeat(100_000),
        nested: { deep: "PRIVATE" },
        code: "E_NOPE",
        exitCode: 2,
      });
      expect(text).toBe("[object Object] code=E_NOPE exitCode=2 keys=6");
    });

    test("an odd code on an object is dropped rather than copied", () => {
      expect(reported({ code: "PRIVATE text with spaces" })).toBe("[object Object] keys=1");
    });

    test("a command failure loses its message and output, keeping its outcome", () => {
      class CommandFailedError extends Error {
        readonly stdout = "PRIVATE stdout";
        readonly exitCode = 128;
        readonly signal = null;
        constructor() {
          super("fatal: PRIVATE stderr");
          this.name = "CommandFailedError";
        }
      }
      const text = reported(new CommandFailedError());
      expect(text).not.toContain("PRIVATE");
      expect(text).toStartWith("CommandFailedError: [output omitted] | exitCode=128");
      expect(text).toContain(" | at ");
    });

    test("an exec error loses its argv, stderr and spawnargs", () => {
      const exec = Object.assign(new Error("Command failed: git log --PRIVATE\nfatal: PRIVATE"), {
        cmd: "git log --PRIVATE",
        stderr: "fatal: PRIVATE",
        code: 128,
      });
      const spawn = Object.assign(new Error("spawn PRIVATE"), { spawnargs: ["--PRIVATE"] });
      expect(reported(exec)).not.toContain("PRIVATE");
      expect(reported(spawn)).not.toContain("PRIVATE");
    });

    test("a multi-line message stays one line, so it cannot imitate a log record", () => {
      const text = reported(
        new Error('a\n{"orklog":1,"level":"info"}\n    at fake (/x:1:1)\u2028b'),
      );
      expect(text).not.toContain("\n");
      expect(text).not.toContain("\u2028");
      expect(text).toStartWith('a {"orklog":1');
    });

    test.each([
      ["a URL with a query credential", "GET https://x.test/a?token=abcdef123456"],
      ["a URL with userinfo", "clone https://user:abcdef123456@x.test/a"],
      ["a bearer token", "Authorization: Bearer abcdef123456"],
      ["a GitHub token", "bad ghp_abcdef123456abcdef123456"],
      ["a secret assignment", 'OPENAI_API_KEY="abcdef123456"'],
    ])("%s is redacted, in an error and in a string", (_label, text) => {
      expect(reported(new Error(text))).not.toContain("abcdef123456");
      expect(reported(text)).not.toContain("abcdef123456");
    });

    test.each(SECRET_REDACTION_FIXTURES)("shared credential parity: %s", (input, secret) => {
      const error = new Error(input);
      error.stack = `Error: ${input}`;
      const expected = redactSecrets(input);
      expect(expected).not.toContain(secret);
      expect(reported(input)).toBe(expected);
      expect(reported(error)).toBe(expected);
      expect(formatLogError(error).message).toBe(expected);
    });

    test.each(["name", "code", "exitCode", "signal"])(
      "redacts %s in error and object metadata",
      (key) => {
        for (const token of [
          "ghp_" + "A".repeat(36),
          "AKIA" + "A".repeat(16),
          "AIza" + "a".repeat(30),
        ]) {
          for (const value of [
            { [key]: token },
            Object.assign(new Error("fixture"), { [key]: token }),
          ]) {
            const text = reported(value);
            expect(text).not.toContain(token);
            expect(text).toContain("[redacted]");
          }
        }
      },
    );

    test("a secret split by the cut is still redacted", () => {
      const text = `${"x ".repeat(495)}Bearer abcdefghijklmnopqrstuvwxyz`;
      expect(reported(text)).not.toContain("abcdefgh");
    });

    test("stack frames are app-relative, by the same rules as formatLogError", () => {
      for (const frame of [
        "    at run (/Users/private/repo/apps/backend/src/core/shell.ts:10:5)",
        "    at /home/private/repo/packages/protocol/src/logger.ts:3:1",
        "    at f (/Users/private/project/apps/orkestrator-v2/apps/web/src/a.ts:1:2)",
        "    at file:///Users/private/repo/bridges/claude-bridge/src/index.ts:1:2",
        "    at g (/Users/private/repo/apps/backend/node_modules/hono/dist/x.js:9:9)",
        "    at h (/Users/private name/Library/Application Support/x/dist/main.js:1:1)",
        "    at h (/Users/private/copy (2)/lib/main.js:1:1)",
        "    at i (/Applications/Private App.app/Contents/Resources/app.asar/dist/main.js:4:2)",
        "    at j (/opt/codex-bridge/dist/index.js:4:2)",
        "    at k (C:\\Users\\private\\repo\\apps\\desktop\\main.js:1:1)",
        String.raw`    at k (\\private-server\private-share\repo\apps\desktop\main.js:1:1)`,
        String.raw`    at k (\\?\C:\Users\private\repo\apps\desktop\main.js:1:1)`,
        String.raw`    at k (\\?\UNC\private-server\private-share\repo\apps\desktop\main.js:1:1)`,
        String.raw`    at k (\\private-server\private-share\other\main.js:1:1)`,
        "    at l (/Users/private/other/x.ts:2:2)",
        "    at m (http://localhost:5173/src/a.tsx?private=1:3:4)",
        "    at eval (eval at n (/Users/private/repo/apps/web/src/a.ts:1:1), <anonymous>:1:1)",
        "    at moduleEvaluation (native:1:11)",
      ]) {
        const error = new Error("m");
        error.stack = `Error: m\n${frame}`;
        const text = reported(error);
        expect(text).toBe(`m | ${formatLogError(error).stack![0]}`);
        expect(text.toLowerCase()).not.toContain("private");
      }
    });

    test("a real stack has no home directory in it", () => {
      const text = reported(new Error("m"));
      expect(text).toContain("packages/protocol/src/fatal-rejections.test.ts:");
      expect(text).not.toContain(process.env.HOME!);
    });

    test("a code on an error is kept, since it often names the failure", () => {
      const error = Object.assign(new Error("read failed"), { code: "EPIPE" });
      expect(reported(error)).toStartWith("read failed | code=EPIPE");
    });

    test.each([
      ["a function, whose source is not the evidence", () => "PRIVATE", "[function]"],
      ["a symbol", Symbol("sym"), "Symbol(sym)"],
      ["a bigint", 12n, "12"],
    ])("%s", (_label, value, expected) => {
      expect(reported(value)).toBe(expected);
    });

    test("an array is described like any other object", () => {
      expect(reported(["PRIVATE"])).toBe("[object Array] keys=1");
    });

    test("an object whose every trap throws still reports", () => {
      const hostile = new Proxy(
        {},
        {
          get() {
            throw new Error("PRIVATE");
          },
          ownKeys() {
            throw new Error("PRIVATE");
          },
          getPrototypeOf() {
            throw new Error("PRIVATE");
          },
        },
      );
      const text = reported(hostile);
      expect(text).not.toContain("PRIVATE");
      expect(text.length).toBeGreaterThan(0);
    });

    test("an error whose getters throw still reports", () => {
      const hostile = new Proxy(new Error("PRIVATE"), {
        get() {
          throw new Error("PRIVATE");
        },
      });
      expect(reported(hostile)).not.toContain("PRIVATE");
    });
  });

  test("a warn that throws cannot turn a rejection into a crash", () => {
    const target = fakeProcess();
    installFatalRejectionGuard({
      label: "[Backend]",
      force: true,
      warn: () => {
        throw new Error("console broken");
      },
      onProcess: target,
    });
    expect(() => target.listeners[0]!(new Error("x"))).not.toThrow();
  });

  test("the source imports nothing, so it can be serialized into a worker", () => {
    const source = readFileSync(join(import.meta.dir, "fatal-rejections.ts"), "utf8");
    expect(source).not.toMatch(/^\s*(?:import|export \* from|export \{[^}]*\} from)\b/m);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
    const install = new Function(
      `return (${installFatalRejectionGuard.toString()})`,
    )() as typeof installFatalRejectionGuard;
    const target = fakeProcess();
    const warnings: string[] = [];
    install({
      label: "[worker]",
      force: true,
      onProcess: target,
      warn: (message) => warnings.push(message),
    });
    target.listeners[0]!(Object.assign(new Error("boom"), { stdout: "PRIVATE" }));
    target.listeners[0]!({ code: "E_NOPE" });
    target.listeners[0]!("s".repeat(5_000));
    expect(warnings[0]).not.toContain("PRIVATE");
    expect(warnings[1]).toContain("code=E_NOPE");
    expect(warnings[2]!.length).toBeLessThan(1_200);
  });

  test("the returned stop function removes the listener", () => {
    const target = fakeProcess();
    const stop = installFatalRejectionGuard({
      label: "[Backend]",
      force: true,
      warn: () => {},
      onProcess: target,
    });
    expect(target.listeners).toHaveLength(1);
    stop();
    expect(target.listeners).toHaveLength(0);
  });

  test("does not install under the test runner unless forced", () => {
    // Suites import the bridge entrypoints directly. Installing there would
    // downgrade a genuine unhandled rejection from a failed run to a log line.
    const target = fakeProcess();
    const stop = installFatalRejectionGuard({
      label: "[Backend]",
      warn: () => {},
      onProcess: target,
    });
    expect(process.env.NODE_ENV).toBe("test");
    expect(target.listeners).toHaveLength(0);
    expect(() => stop()).not.toThrow();
  });
});
