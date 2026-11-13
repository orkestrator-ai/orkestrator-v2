import { expect, test } from "bun:test";

const script = new URL("../scripts/coordinator-sweep-bench.ts", import.meta.url).pathname;

test("the sweep bench's --owed mode delivers every wake and counts the per-wake repair", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      script,
      "--projects",
      "2",
      "--open",
      "1",
      "--finished",
      "0",
      "--iterations",
      "1",
      "--owed",
      "3",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).not.toContain("were not delivered");
  expect(exitCode).toBe(0);
  const result = JSON.parse(stdout) as {
    owed: number;
    wakes: { mailWrites: number; coordinatorWrites: number };
    wakesWithoutRepair: { mailWrites: number };
    ensureCallsPerPass: number;
    syncsPerPass: number;
  };
  expect(result.owed).toBe(3);
  // One notice per wake, in both variants.
  expect(result.wakes.mailWrites).toBe(3);
  expect(result.wakesWithoutRepair.mailWrites).toBe(3);
  // Two coordinator writes per wake: the chosen kind, then woken.
  expect(result.wakes.coordinatorWrites).toBe(6);
  // What 6660 task 2 measured: each wake repairs its main, and each repair
  // syncs every mailbox, on top of the sweep's own sync.
  expect(result.ensureCallsPerPass).toBe(3);
  expect(result.syncsPerPass).toBe(4);
}, 60_000);
