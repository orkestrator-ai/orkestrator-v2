import { afterEach, expect, spyOn, test } from "bun:test";
import { writeSync } from "node:fs";
import { CommandFailedError, runCommand } from "./shell.js";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

// File capture must not depend on a pipe's close event. Model only the child's
// exit and write directly to the descriptors passed to the real spawn boundary.
function fixture() {
  const { promise: exited, resolve } = Promise.withResolvers<number>();
  let capture: { stdout: number; stderr: number };
  const child = {
    pid: 123456789,
    exitCode: 0,
    signalCode: null,
    stdin: { end: () => undefined },
    exited,
    kill: () => true,
  };
  const spawn = spyOn(Bun, "spawn").mockImplementation(((_args: unknown, options: unknown) => {
    capture = options as typeof capture;
    return child;
  }) as unknown as typeof Bun.spawn);
  const kill = spyOn(process, "kill").mockImplementation(() => true);
  const childKill = spyOn(child, "kill");
  restores.push(
    () => spawn.mockRestore(),
    () => kill.mockRestore(),
    () => childKill.mockRestore(),
  );
  return {
    child,
    kill,
    childKill,
    exit(output: "stdout" | "stderr" | undefined) {
      if (output) writeSync(capture[output], "captured\n");
      resolve(0);
    },
  };
}

for (const output of [undefined, "stdout", "stderr"] as const) {
  test(`leader exit captures ${output ?? "empty output"} without pipe closure`, async () => {
    const f = fixture();
    const pending = runCommand("git", [], { timeoutMs: 500 });
    f.exit(output);
    expect(await pending).toEqual({
      stdout: output === "stdout" ? "captured\n" : "",
      stderr: output === "stderr" ? "captured\n" : "",
    });
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.childKill).not.toHaveBeenCalled();
  });
}

for (const abort of [false, true]) {
  test(`${abort ? "abort" : "deadline"} still cancels a child with no exit`, async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = runCommand("git", [], {
      timeoutMs: abort ? 500 : 20,
      signal: controller.signal,
    }).catch((error) => error);
    if (abort) controller.abort();
    const failure = await pending;
    expect(failure).toBeInstanceOf(CommandFailedError);
    expect(failure).toMatchObject({ timedOut: true, aborted: abort });
    if (process.platform === "win32") {
      expect(f.childKill).toHaveBeenCalledWith("SIGKILL");
    } else expect(f.kill).toHaveBeenCalledWith(-f.child.pid, "SIGKILL");
    f.exit(undefined);
  });
}
