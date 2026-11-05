import { afterEach, describe, expect, test } from "bun:test";
import { loseBunExitEvents } from "../../testing/lost-exit.js";
import { createSshAdapterContext } from "./context.js";
import { runBoundedCommand, type BoundedCommandOptions } from "./process-runner.js";

const context = createSshAdapterContext({ knownHostsFile: "/nonexistent/known_hosts" });

const BOUNDS: BoundedCommandOptions = {
  timeoutMs: 10_000,
  maxStdoutBytes: 1024,
  maxStderrBytes: 16,
};

function run(script: string, options: Partial<BoundedCommandOptions> = {}) {
  return runBoundedCommand(context, "sh", ["-c", script], { ...BOUNDS, ...options });
}

describe.skipIf(process.platform === "win32")("runBoundedCommand", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("a clean exit returns both streams", async () => {
    expect(await run("printf out; printf err >&2")).toEqual({
      exitCode: 0,
      signal: null,
      stdout: "out",
      stderr: "err",
      timedOut: false,
      overflowed: false,
      spawnFailed: false,
    });
  });

  test("a failing exit keeps its code and output", async () => {
    const result = await run("printf out; printf err >&2; exit 7");
    expect(result).toMatchObject({
      exitCode: 7,
      stdout: "out",
      stderr: "err",
      timedOut: false,
      spawnFailed: false,
    });
  });

  test("a binary that cannot start is reported as such", async () => {
    const result = await runBoundedCommand(context, "/nonexistent/orkestrator-ssh", [], BOUNDS);
    expect(result).toMatchObject({ spawnFailed: true, exitCode: null, stdout: "", stderr: "" });
  });

  test("the deadline settles a helper that does not exit", async () => {
    const result = await run("printf partial; exec sleep 30", { timeoutMs: 100 });
    expect(result).toMatchObject({ timedOut: true, stdout: "partial", spawnFailed: false });
  });

  test("stdout past its bound stops the helper and is reported", async () => {
    const started = Date.now();
    const result = await run("printf 123456; exec sleep 30", { maxStdoutBytes: 5 });
    expect(result).toMatchObject({ overflowed: true, stdout: "12345", timedOut: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("long stderr is clipped to its bound without failing the helper", async () => {
    const result = await run("printf 0123456789abcdefXYZ >&2");
    expect(result).toMatchObject({ exitCode: 0, stderr: "0123456789abcdef", overflowed: false });
  });

  test("an abort is not reported as a timeout", async () => {
    const controller = new AbortController();
    const running = run("exec sleep 30", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    expect(await running).toMatchObject({ timedOut: false, spawnFailed: false });
  });

  // A pipe capture waits for this helper to close its copy of the pipe.
  test("a background child still holding the output does not delay the result", async () => {
    const started = Date.now();
    const result = await run("printf done; sleep 5 & exit 0");
    expect(result).toMatchObject({ exitCode: 0, stdout: "done" });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  test("a lost completion event is a timeout, never a success", async () => {
    restore = loseBunExitEvents();
    const result = await run("printf out", { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
  });
});
