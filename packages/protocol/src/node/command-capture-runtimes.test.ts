import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loseBunExitEvents } from "../testing/lost-exit.js";
import {
  CommandFailedError,
  runCommand,
  runCommandBuffer,
  setCommandCaptureMetrics,
} from "./command-capture.js";

const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("a lost completion event", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("fails at the deadline with what was written, never as a success", async () => {
    restore = loseBunExitEvents();
    const error = await runCommand("sh", ["-c", "printf written; exit 0"], {
      timeoutMs: 300,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).timedOut).toBe(true);
    expect((error as CommandFailedError).stdout).toBe("written");
  });

  test("fails at the deadline with a stdin payload too", async () => {
    restore = loseBunExitEvents();
    await expect(
      runCommand("cat", [], { stdin: "payload", timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(CommandFailedError);
  });
});

posixOnly("command capture without a pipe reader", () => {
  test("a background child holding the output does not delay a success", async () => {
    const started = Date.now();
    const { stdout } = await runCommand("sh", ["-c", "printf done; sleep 5 & exit 0"]);
    expect(stdout).toBe("done");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("stderr can have its own limit", async () => {
    const script = "printf 123456 >&2; printf 123456";
    const { stderr } = await runCommand("sh", ["-c", script], {
      maxOutputBytes: 6,
      maxStderrBytes: 10,
    });
    expect(stderr).toBe("123456");
    const error = await runCommand("sh", ["-c", script], {
      maxOutputBytes: 10,
      maxStderrBytes: 5,
    }).then(
      () => undefined,
      (reason: unknown) => reason as CommandFailedError,
    );
    expect(error?.outputLimitExceeded).toBe(true);
    expect(error?.stderr).toBe("12345");
  });

  test("an invalid stderr limit is refused before anything runs", async () => {
    await expect(runCommand("true", [], { maxStderrBytes: 0 })).rejects.toBeInstanceOf(RangeError);
  });
});

posixOnly("capture metrics", () => {
  afterEach(() => setCommandCaptureMetrics(undefined));

  test("reports each started command and the stdout bytes of a success", async () => {
    const started: Array<[string, readonly string[]]> = [];
    const bytes: number[] = [];
    setCommandCaptureMetrics({
      started: (command, args) => started.push([command, args]),
      capturedBytes: (count) => bytes.push(count),
    });
    await runCommandBuffer("sh", ["-c", "printf 123"]);
    await runCommand("sh", ["-c", "exit 3"]).catch(() => undefined);
    expect(started).toEqual([
      ["sh", ["-c", "printf 123"]],
      ["sh", ["-c", "exit 3"]],
    ]);
    expect(bytes).toEqual([3]);
  });
});

/**
 * Electron's main process runs the SSH adapter on this capture and has no `Bun`,
 * so the same module has to work bundled for Node and started by a real `node`.
 */
posixOnly("under Node", () => {
  const SCENARIO = `
import { CommandFailedError, runCommand, runCommandBuffer } from ${JSON.stringify(
    path.join(import.meta.dir, "command-capture.ts"),
  )};
const failure = (promise) => promise.then(
  () => "succeeded",
  (error) => error instanceof CommandFailedError
    ? {
        exitCode: error.exitCode,
        signal: error.signal,
        timedOut: error.timedOut,
        aborted: error.aborted,
        missing: error.executableMissing,
        overLimit: error.outputLimitExceeded,
        stdout: error.stdout,
        stderr: error.stderr,
      }
    : String(error),
);
const controller = new AbortController();
setTimeout(() => controller.abort(), 50);
console.log(JSON.stringify({
  bun: typeof Bun !== "undefined",
  ok: await runCommand("sh", ["-c", "printf out; printf err >&2"]),
  bytes: (await runCommandBuffer("sh", ["-c", "printf abc"])).stdout.toString("hex"),
  payload: (await runCommand("cat", [], { stdin: "payload" })).stdout,
  earlyExit: await failure(runCommand("sh", ["-c", "exit 4"], { stdin: "x".repeat(1 << 20) })),
  exit: await failure(runCommand("sh", ["-c", "printf o; printf e >&2; exit 7"])),
  missing: await failure(runCommand("/nonexistent/orkestrator-tool")),
  timeout: await failure(runCommand("sh", ["-c", "printf partial; exec sleep 30"], { timeoutMs: 200, waitForTermination: true, waitForDescendants: true })),
  overLimit: await failure(runCommand("sh", ["-c", "printf 123456; exec sleep 30"], { maxOutputBytes: 5 })),
  aborted: await failure(runCommand("sleep", ["30"], { signal: controller.signal })),
}));
`;

  test("bundled for Node, it captures, bounds and classifies the same way", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ork-capture-node-"));
    try {
      const entry = path.join(scratch, "entry.mjs");
      writeFileSync(entry, SCENARIO);
      const built = await Bun.build({
        entrypoints: [entry],
        target: "node",
        format: "esm",
        outdir: path.join(scratch, "out"),
      });
      expect(built.success).toBe(true);
      const { stdout } = await runCommand("node", [path.join(scratch, "out", "entry.js")], {
        timeoutMs: 30_000,
      });
      const facts = JSON.parse(stdout);
      expect(facts.bun).toBe(false);
      expect(facts.ok).toEqual({ stdout: "out", stderr: "err" });
      expect(facts.bytes).toBe("616263");
      expect(facts.payload).toBe("payload");
      expect(facts.earlyExit.exitCode).toBe(4);
      expect(facts.exit).toMatchObject({ exitCode: 7, stdout: "o", stderr: "e" });
      expect(facts.missing.missing).toBe(true);
      expect(facts.timeout).toMatchObject({ timedOut: true, stdout: "partial" });
      expect(facts.overLimit).toMatchObject({ overLimit: true, stdout: "12345" });
      expect(facts.aborted).toMatchObject({ aborted: true, timedOut: true });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 40_000);
});
