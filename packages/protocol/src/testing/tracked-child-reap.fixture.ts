// Runs in its own Bun process: an unhandled late runtime error must fail it.
import assert from "node:assert/strict";
import { CommandFailedError, runCommand } from "../node/command-capture.js";
import { darwinReaperSystem } from "../node/lost-exit-reaper.js";

const system = darwinReaperSystem();
assert(system);
const originalSpawn = Bun.spawn;
const unrelated = originalSpawn(["sh", "-c", "sleep 0.2; exit 19"], {
  stdout: "ignore",
  stderr: "ignore",
});
let realExit: Promise<number> | undefined;
let lateError = "";
let reaped = false;
Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  const child = originalSpawn(...args);
  // Register the real runtime promise before taking its wait status away.
  realExit = child.exited.catch((error: Error) => {
    lateError = error.message;
    return -1;
  });
  const deadline = Date.now() + 5_000;
  // Keep Bun's event loop parked until the kernel has an exit. No runtime mock:
  // Bun really owns this child and will call waitpid after we yield.
  while (true) {
    const found = system.inspect(child.pid);
    if (found && found !== "gone" && found.state.startsWith("Z")) break;
    assert(Date.now() < deadline, "tracked child never became a zombie");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
  assert.equal(system.waitNoHang(child.pid), child.pid);
  reaped = true;
  return child;
}) as typeof Bun.spawn;
const controller = new AbortController();
try {
  const capture = runCommand("sh", ["-c", "exit 7"], { signal: controller.signal });
  // Capture is settled synchronously before Bun delivers the genuine ECHILD.
  controller.abort();
  await assert.rejects(
    capture,
    (error: unknown) => error instanceof CommandFailedError && error.aborted,
  );
  assert(reaped);
  assert.equal(await realExit, -1);
  assert.match(lateError, /ECHILD/);
  assert.equal(await unrelated.exited, 19);
  assert.equal(unrelated.exitCode, 19);
  // Give any unhandled rejection/error a full event-loop turn to surface.
  await Bun.sleep(50);
  console.log("tracked late ECHILD preserved");
} finally {
  Bun.spawn = originalSpawn;
}
