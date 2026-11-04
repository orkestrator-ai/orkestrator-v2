import { afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CommandFailedError, runCommand } from "./shell.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  Object.defineProperty(process, "platform", platform);
});

function fixture(windows = false, groupAlive = false) {
  Object.defineProperty(process, "platform", {
    value: windows ? "win32" : "linux",
    configurable: true,
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 123456789,
    exitCode: 0,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  const spawn = spyOn(childProcess, "spawn").mockReturnValue(
    child as unknown as childProcess.ChildProcessWithoutNullStreams,
  );
  const kill = spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === 0 && !groupAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  const childKill = spyOn(child, "kill");
  restores.push(
    () => spawn.mockRestore(),
    () => kill.mockRestore(),
    () => childKill.mockRestore(),
  );
  return { child, kill, childKill };
}

for (const output of ["", "stdout", "stderr"]) {
  test(`lost close with empty group preserves exit and selected ${output || "fallback"} message`, async () => {
    const { child, kill } = fixture();
    const pending = runCommand("git", [], { outputCloseGraceMs: 5, timeoutMs: 500 }).catch(
      (error) => error,
    );
    if (output) child[output as "stdout" | "stderr"].write("captured\n");
    child.emit("exit", 0, null);
    const failure = await pending;
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect(failure).toMatchObject({
      timedOut: true,
      outputCloseTimedOut: true,
      exitCode: 0,
      signal: null,
      aborted: false,
      stdout: output === "stdout" ? "captured\n" : "",
    });
    expect(failure.message).toBe(
      output ? "captured" : "Command output did not close within 5 ms of exit",
    );
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });
}

test("close before grace settles once and cancels the probe", async () => {
  const { child, kill } = fixture();
  const pending = runCommand("git", [], { outputCloseGraceMs: 20 });
  child.emit("exit", 0, null);
  child.stdout.write("complete");
  child.emit("close", 0, null);
  expect((await pending).stdout).toBe("complete");
  await Bun.sleep(30);
  expect(kill).not.toHaveBeenCalled();
});

for (const windows of [false, true]) {
  for (const abort of [false, true]) {
    test(`${windows ? "Windows" : "POSIX"} ${abort ? "abort" : "deadline"} wins while output is open`, async () => {
      const { child, kill, childKill } = fixture(windows, true);
      const controller = new AbortController();
      const pending = runCommand("git", [], {
        outputCloseGraceMs: 5,
        timeoutMs: abort ? 500 : 20,
        signal: controller.signal,
      }).catch((error) => error);
      child.emit("exit", 0, null);
      if (abort) {
        await Bun.sleep(15);
        controller.abort();
      }
      const failure = await pending;
      expect(failure).toMatchObject({ timedOut: true, outputCloseTimedOut: false, aborted: abort });
      child.emit("close", 0, null);
      if (windows) {
        expect(childKill).toHaveBeenCalledWith("SIGKILL");
        expect(kill).not.toHaveBeenCalled();
      } else expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    });
  }
}
