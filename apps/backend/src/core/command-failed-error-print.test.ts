import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { installBoundedConsole } from "../bounded-console.js";
import { CommandFailedError, GitRemoteTimeoutError, runCommand } from "./shell.js";

const MARKER = "PRIVATE-OUTPUT";
const ONE_MEBIBYTE = 1024 * 1024;
/** 8 frames of 240 characters, their separators and the fixed fields. */
const MAX_PRINTED_CHARS = 2_400;

function failure(): CommandFailedError {
  return new CommandFailedError(`fatal: ${MARKER}\n${"e".repeat(ONE_MEBIBYTE)}`, {
    stdout: `${MARKER}${"o".repeat(ONE_MEBIBYTE)}`,
    exitCode: 128,
  });
}

function expectSafe(printed: string): void {
  expect(printed).not.toContain(MARKER);
  expect(printed).not.toContain("eeee");
  expect(printed).not.toContain("oooo");
  expect(printed.length).toBeLessThan(MAX_PRINTED_CHARS);
}

/** What a raw `console` call writes in the backend, through the real bounded console. */
function printedThroughBoundedConsole(...args: unknown[]): string {
  let written = "";
  const stream = {
    write(chunk: string, callback: (error?: Error | null) => void) {
      written += chunk;
      callback();
      return true;
    },
  };
  const target = { ...console } as Console;
  const installed = installBoundedConsole({ stdout: stream, stderr: stream, console: target });
  try {
    target.warn(...args);
  } finally {
    installed.uninstall();
  }
  return written;
}

describe("CommandFailedError printing", () => {
  test("a raw console call stays bounded and carries no output", () => {
    const printed = printedThroughBoundedConsole("[Backend] Failed:", failure());
    expectSafe(printed);
    expect(printed).toContain("[Backend] Failed: CommandFailedError");
    expect(printed).toContain("exitCode=128");
    expect(printed).toContain("outputOmitted=true");
  });

  test("Bun's own console prints the same safe form", () => {
    const shell = join(dirname(import.meta.path), "shell.ts");
    const script = `
      const { CommandFailedError } = await import(${JSON.stringify(shell)});
      const error = new CommandFailedError("fatal: ${MARKER}", {
        stdout: "${MARKER}",
        exitCode: 128,
      });
      console.warn("prefix", error);
      console.warn("nested", { error });
    `;
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("reason=unclassified exitCode=128");
    expect(result.stderr).not.toContain(MARKER);
  });

  test.each([
    ["a format placeholder", ["failed %s", failure()]],
    ["an object placeholder", ["failed %o", failure()]],
    ["a JSON placeholder", ["failed %j", failure()]],
    ["a nested field", ["failed", { error: failure() }]],
    ["an array member", ["failed", [failure()]]],
    ["a wrapper's cause", ["failed", new Error("outer", { cause: failure() })]],
  ])("%s is bounded too", (_label, args) => {
    expectSafe(printedThroughBoundedConsole(...args));
  });

  test("JSON carries the classified fields and no output", () => {
    const parsed = JSON.parse(JSON.stringify({ error: failure() })) as {
      error: Record<string, unknown>;
    };
    expectSafe(JSON.stringify(parsed));
    expect(parsed.error).toMatchObject({
      name: "CommandFailedError",
      reason: "unclassified",
      exitCode: 128,
      signal: null,
      outputOmitted: true,
    });
    for (const field of ["stdout", "stderr", "cmd", "spawnargs", "message"]) {
      expect(parsed.error[field]).toBeUndefined();
    }
  });

  test("inspect prints one line with app-relative frames", () => {
    const printed = inspect(failure());
    expectSafe(printed);
    expect(printed).not.toContain("\n");
    expect(printed).toContain("apps/backend/src/core/command-failed-error-print.test.ts:");
    expect(printed).not.toContain(process.env.HOME!);
  });

  test("the reason lets a raw site still say what happened", () => {
    const branch = new CommandFailedError("fatal: a branch named 'x' already exists", {
      exitCode: 128,
    });
    expect(inspect(branch)).toContain("reason=branch-exists exitCode=128");
    expect(inspect(branch)).not.toContain("named 'x'");
  });

  test("the fields callers rely on are unchanged", () => {
    const error = failure();
    expect(error.message).toContain(MARKER);
    expect(error.stdout).toContain(MARKER);
    expect(error.exitCode).toBe(128);
    expect(error).toBeInstanceOf(Error);
  });

  test("a subclass prints safely under its own name", () => {
    const printed = inspect(new GitRemoteTimeoutError(`fatal: ${MARKER}`, { signal: "SIGTERM" }));
    expect(printed).toContain("GitRemoteTimeoutError reason=timed-out");
    expect(printed).toContain("signal=SIGTERM");
    expect(printed).not.toContain(MARKER);
  });
});

describe("failures runCommand produces", () => {
  const posixOnly = process.platform === "win32" ? test.skip : test;

  async function failed(
    script: string,
    options: Parameters<typeof runCommand>[2] = {},
  ): Promise<CommandFailedError> {
    const error = await runCommand("sh", ["-c", script], options).catch((caught) => caught);
    expect(error).toBeInstanceOf(CommandFailedError);
    return error as CommandFailedError;
  }

  posixOnly("a non-zero exit prints without its stdout or stderr", async () => {
    const error = await failed(`echo ${MARKER}; echo ${MARKER} >&2; exit 3`);
    expect(error.message).toContain(MARKER);
    const printed = printedThroughBoundedConsole("failed:", error);
    expectSafe(printed);
    expect(printed).toContain("reason=unclassified exitCode=3");
  });

  posixOnly("an overflow phrase in argv remains an ordinary exit", async () => {
    const error = await failed("exit 3 # maxBuffer length exceeded");
    expect(error.exitCode).toBe(3);
    expect(error.outputLimitExceeded).toBe(false);
    expect(inspect(error)).toContain("reason=unclassified exitCode=3");
  });

  posixOnly("a diagnostic phrase on a later argv line is not child output", async () => {
    const error = await failed("exit 3\n# fatal: not a git repository");
    expect(error.stdout).toBe("");
    expect(error.message).toContain("Command failed:");
    expect(inspect(error)).toContain("reason=unclassified exitCode=3");
  });

  posixOnly("stderr picks the reason without reaching the print", async () => {
    const printed = inspect(await failed("echo 'fatal: not a git repository' >&2; exit 128"));
    expect(printed).toContain("reason=not-a-repository exitCode=128");
    expect(printed).not.toContain("fatal:");
  });

  posixOnly("a deadline is timed-out, even when the child wrote first", async () => {
    const error = await failed(`echo ${MARKER} >&2; sleep 30`, { timeoutMs: 50 });
    expect(error.aborted).toBe(false);
    expect(inspect(error)).toContain("reason=timed-out");
  });

  posixOnly("an abort is aborted, not a timeout, even when the child wrote first", async () => {
    const controller = new AbortController();
    const pending = failed(`echo ${MARKER} >&2; sleep 30`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const error = await pending;
    expect(error.timedOut).toBe(true);
    expect(error.aborted).toBe(true);
    expect(inspect(error)).toContain("reason=aborted");
  });

  posixOnly("an abort before the command starts is aborted too", async () => {
    const error = await failed("exit 0", { signal: AbortSignal.abort() });
    expect(inspect(error)).toContain("reason=aborted");
  });

  posixOnly.each(["stdout", "stderr"])("%s over the capture limit is named", async (stream) => {
    const error = await failed(`yes ${"x".repeat(64)}${stream === "stderr" ? " >&2" : ""}`, {
      timeoutMs: 20_000,
    });
    expect(error.outputLimitExceeded).toBe(true);
    const printed = inspect(error);
    expect(printed).toContain("reason=output-too-large");
    expect(printed.length).toBeLessThan(MAX_PRINTED_CHARS);
  });

  test("a missing program is executable-missing", async () => {
    const error = await runCommand("orkestrator-no-such-program").catch((caught) => caught);
    expect(inspect(error)).toContain("reason=executable-missing");
  });
});
