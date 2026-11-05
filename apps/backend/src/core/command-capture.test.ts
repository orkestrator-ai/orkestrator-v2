import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { CommandFailedError, runCommand, runCommandBuffer } from "./command-capture.js";

async function failure(run: Promise<unknown>): Promise<CommandFailedError> {
  const error = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CommandFailedError);
  return error as CommandFailedError;
}

describe("runCommand maxOutputBytes", () => {
  test("output exactly at the limit succeeds whole", async () => {
    const { stdout } = await runCommand("sh", ["-c", "printf 12345"], { maxOutputBytes: 5 });
    expect(stdout).toBe("12345");
  });

  test("stdout past the limit fails instead of settling truncated", async () => {
    const error = await failure(runCommand("sh", ["-c", "printf 123456"], { maxOutputBytes: 5 }));
    expect(error.outputLimitExceeded).toBe(true);
    expect(error.message).not.toContain("123456");
    expect(error.stdout).toBe("12345");
  });

  test("stderr has the same limit", async () => {
    const error = await failure(
      runCommand("sh", ["-c", "printf 123456 >&2"], { maxOutputBytes: 5 }),
    );
    expect(error.outputLimitExceeded).toBe(true);
    expect(error.stderr).toBe("12345");
  });

  test("a command still running past the limit is killed", async () => {
    const started = Date.now();
    const error = await failure(
      runCommand("sh", ["-c", "printf 123456; sleep 30"], { maxOutputBytes: 5, timeoutMs: 0 }),
    );
    expect(error.outputLimitExceeded).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("the limit can sit above the default", async () => {
    const bytes = 51 * 1024 * 1024;
    const command = `head -c ${bytes} /dev/zero`;
    const { stdout } = await runCommandBuffer("sh", ["-c", command], {
      maxOutputBytes: bytes,
    });
    expect(stdout.length).toBe(bytes);
    const error = await failure(runCommandBuffer("sh", ["-c", command]));
    expect(error.outputLimitExceeded).toBe(true);
  });

  test("an invalid limit is refused before anything runs", async () => {
    for (const maxOutputBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(runCommand("true", [], { maxOutputBytes })).rejects.toBeInstanceOf(RangeError);
    }
  });
});

describe("CommandFailedError output", () => {
  test("keeps stderr apart from stdout, and stdout's bytes undecoded", async () => {
    const error = await failure(
      runCommandBuffer("sh", ["-c", "printf '\\377out'; printf ' err ' >&2; exit 3"]),
    );
    expect(error.exitCode).toBe(3);
    expect(error.stderr).toBe(" err ");
    expect(error.stdoutBytes.equals(Buffer.from([0xff, 0x6f, 0x75, 0x74]))).toBe(true);
  });

  test("a timeout keeps what was written before it", async () => {
    const error = await failure(
      runCommandBuffer("sh", ["-c", "printf out; printf err >&2; exec sleep 30"], {
        timeoutMs: 100,
      }),
    );
    expect(error.timedOut).toBe(true);
    expect(error.stdoutBytes.toString()).toBe("out");
    expect(error.stderr).toBe("err");
  });

  test("redaction covers stderr and withholds the undecoded bytes", async () => {
    const error = await failure(
      runCommand("sh", ["-c", "printf hunter2; printf hunter2 >&2; exit 1"], {
        redactValues: ["hunter2"],
      }),
    );
    expect(error.stderr).toBe("[REDACTED]");
    expect(error.stdout).toBe("[REDACTED]");
    expect(error.stdoutBytes.length).toBe(0);
  });

  test("the printed forms leave stderr and the bytes out", async () => {
    const error = await failure(
      runCommandBuffer("sh", ["-c", "printf private-out; printf private-err >&2; exit 1"]),
    );
    for (const printed of [inspect(error), JSON.stringify(error)]) {
      expect(printed).not.toContain("private-out");
      expect(printed).not.toContain("private-err");
    }
  });
});
