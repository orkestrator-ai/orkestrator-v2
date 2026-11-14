// Review validation worker: cooperative runner channels, stale and unsealed runners, and measured CPU reservations.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHostTestScheduler } from "@orkestrator/protocol/node/host-test-scheduler";
import {
  fixture,
  control,
  observeUntil,
  completed,
  waitFor,
  cooperativeFixture,
  command,
  cleanupReviewValidationFixtures,
} from "./review-validation-worker-test-support.js";

// Every test here spawns a real validation worker plus a Bun control process
// per start, status or cancel, and its own observation bounds run to 12 s. The
// 5 s Bun default is shorter than those bounds, so a loaded host timed tests
// out mid-run; afterEach then cancelled the live run and the still-running
// body reported "cancelled" (case 0745) or the test simply timed out (0302).
setDefaultTimeout(30_000);
afterEach(cleanupReviewValidationFixtures);

test("cooperative admission continues when the worktree is already dirty", async () => {
  const { root, run } = await cooperativeFixture(
    [
      command("check", "bun cooperative.ts", {
        weight: 1,
        timeoutMs: 10_000,
        resources: ["cooperative-dirty"],
      }),
    ],
    {
      "cooperative.ts": `import { createTestAdmission } from __MODULE__;
const admission = createTestAdmission(import.meta.dir, process.env, console.log);
const result = await admission.run({ name: "fixture", command: "unused", args: [], workers: 1, exclusive: true }, async () => ({ status: 0 }));
admission.close(); process.exitCode = result.status ?? 1;
`,
    },
  );
  await writeFile(path.join(root, "source.txt"), "changed\n");
  const done = await completed(root, run);
  expect(done.status).toBe("completed");
  expect(done.error).toBeUndefined();
  expect(done.results[0]!.status).toBe("passed");
  expect(done.results[0]!.limitation).toBeNull();
  expect(done.environmentChanges).toEqual(["source.txt"]);
  expect(await readFile(path.join(root, done.results[0]!.stdoutPath!), "utf8")).toContain(
    "NOTE worktree is dirty while queued",
  );
});

test("cooperative parallel groups do not multiply queue or execution deadlines", async () => {
  // Each of the two groups queues for GROUP_QUEUE_MS and then runs for
  // GROUP_RUN_MS, side by side. Summed per group, either total would pass its
  // deadline (2 x 2200 > 4000); measured as wall time, each stays well under
  // it. The remaining 1.8 s is headroom for what a loaded host adds inside the
  // measured windows: spawning the status probe, the admission's 100 ms poll,
  // and the admitted group's synchronous Git snapshot checks. With 650 ms groups
  // and 1 s deadlines that headroom was 350 ms, and a slow status probe alone
  // pushed the queue wait past its deadline (case 0227).
  const GROUP_QUEUE_MS = 2200;
  const GROUP_RUN_MS = 2200;
  const DEADLINE_MS = 4000;
  const { root, run } = await cooperativeFixture(
    [command("parallel", "bun parallel.ts", { weight: 2, timeoutMs: DEADLINE_MS })],
    {
      "parallel.ts": `import { createTestAdmission } from __MODULE__;
const admission = createTestAdmission(import.meta.dir, process.env, console.log);
const jobs = ["a", "b"].map(name => admission.run({ name, command: "unused", args: [], workers: 1 }, async () => { await Bun.sleep(${GROUP_RUN_MS}); return { status: 0 }; }));
await Bun.write(".orkestrator/enqueued", "ready");
const results = await Promise.all(jobs);
admission.close(); process.exitCode = results.some(result => result.status !== 0) ? 1 : 0;
`,
    },
  );
  const scheduler = createHostTestScheduler({
    directory: path.join(root, ".orkestrator", "scheduler"),
    workers: 2,
    memoryMiB: 4096,
  });
  const blocker = scheduler.enqueue({ owner: "b".repeat(64), workers: 2, memoryMiB: 1 });
  try {
    await control(root, run, "start", { ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS: String(DEADLINE_MS) });
    const deadline = Date.now() + 5000;
    while (!existsSync(path.join(root, ".orkestrator/enqueued")) && Date.now() < deadline)
      await Bun.sleep(20);
    expect(existsSync(path.join(root, ".orkestrator/enqueued"))).toBe(true);
    // Both groups were enqueued before the marker was written.
    const enqueuedAt = Date.now();
    await observeUntil(
      root,
      run,
      (next) => next.results[0]?.queueReason?.includes("worker slots") === true,
      10_000,
    );
    const waiting = await control(root, run, "status");
    expect(waiting.results[0]!.status).toBe("queued");
    expect(waiting.results[0]!.queueReason).toContain("worker slots");
    // Release at a fixed point after enqueue, however long the probes took.
    await Bun.sleep(Math.max(0, enqueuedAt + GROUP_QUEUE_MS - Date.now()));
    scheduler.release(blocker);
    const done = await completed(root, run);
    expect(done.results[0]!.status).toBe("passed");
    expect(done.results[0]!.durationMs).toBeLessThan(DEADLINE_MS);
    expect(done.results[0]!.queuedMs).toBeLessThan(DEADLINE_MS);
    expect(done.results[0]!.queueReason).toBeUndefined();
  } finally {
    scheduler.release(blocker);
    scheduler.close();
  }
}, 30000);

test("legacy cooperative channels are timed by observed state, not summed group totals", async () => {
  const { root, run } = await cooperativeFixture(
    [command("legacy", "bun legacy.ts", { timeoutMs: 1000 })],
    {
      "legacy.ts": `const publish = state => require("node:fs").writeFileSync(process.env.ORKESTRATOR_VALIDATION_SCHEDULER_STATE, JSON.stringify({ version: 1, state, heartbeat: Date.now(), executionMs: 9999999, queuedMs: 9999999 }));
publish("running"); await Bun.sleep(250); publish("completed");`,
    },
  );
  const done = await completed(root, run);
  expect(done.results[0]!.status).toBe("passed");
  expect(done.results[0]!.durationMs).toBeLessThan(1000);
  expect(done.results[0]!.queuedMs).toBeLessThan(1000);
  // Fixture Git setup and worker startup are outside the command's one-second
  // execution budget and may take longer on a busy host.
}, 15000);

test("a cooperative command returning to the queue frees its local weight", async () => {
  const { root, run } = await cooperativeFixture(
    [
      command("cooperative", "bun pause.ts", { weight: 2, timeoutMs: 10000 }),
      command("gate", "sleep 0.4"),
      command("independent", "touch .orkestrator/independent-ran", { dependsOn: ["gate"] }),
    ],
    {
      "pause.ts": `const fs = require("node:fs");
let state = "running";
const publish = () => fs.writeFileSync(process.env.ORKESTRATOR_VALIDATION_SCHEDULER_STATE, JSON.stringify({ version: 1, state, heartbeat: Date.now(), executionMs: 0, queuedMs: 0 }));
publish(); const heartbeat = setInterval(publish, 100);
await Bun.sleep(700); state = "queued"; publish();
const deadline = Date.now() + 4000;
while (!fs.existsSync(".orkestrator/independent-ran") && Date.now() < deadline) await Bun.sleep(20);
clearInterval(heartbeat); state = "completed"; publish();
process.exitCode = fs.existsSync(".orkestrator/independent-ran") ? 0 : 1;`,
    },
  );
  const done = await completed(root, run);
  expect(done.results.map((result) => result.status)).toEqual(["passed", "passed", "passed"]);
});

test("a cooperative command queued on the host does not hold the local runner slot", async () => {
  const { root, run } = await cooperativeFixture(
    [
      command("cooperative", "bun cooperative.ts", {
        weight: 2,
        timeoutMs: 30000,
        resources: ["shared-database"],
      }),
      command("independent", "touch .orkestrator/independent-ran"),
    ],
    {
      "cooperative.ts": `import { createTestAdmission } from __MODULE__;
const admission = createTestAdmission(import.meta.dir, process.env, console.log);
const result = await admission.run({ name: "fixture", command: "unused", args: [], workers: 1 }, async () => { await Bun.sleep(50); return { status: 0 }; });
admission.close(); process.exitCode = result.status ?? 1;
`,
    },
  );
  const scheduler = createHostTestScheduler({
    directory: path.join(root, ".orkestrator", "scheduler"),
    workers: 2,
    memoryMiB: 4096,
  });
  const ticket = scheduler.enqueue({
    owner: scheduler.owner(root),
    workers: 1,
    memoryMiB: 1,
    resources: scheduler.resources(scheduler.owner(root), ["shared-database"]),
  });
  try {
    await control(root, run, "start", {
      ORKESTRATOR_TEST_HOST_WORKERS: "2",
      ORKESTRATOR_TEST_HOST_MEMORY_MIB: "4096",
    });
    const queuedDeadline = Date.now() + 8000;
    while (Date.now() < queuedDeadline) {
      if ((await control(root, run, "status")).results[0]!.status === "queued") break;
      await Bun.sleep(50);
    }
    const ranDeadline = Date.now() + 5000;
    while (
      !(await Bun.file(path.join(root, ".orkestrator/independent-ran")).exists()) &&
      Date.now() < ranDeadline
    )
      await Bun.sleep(50);
    expect(await Bun.file(path.join(root, ".orkestrator/independent-ran")).exists()).toBe(true);
    expect((await control(root, run, "status")).results[0]!.status).toBe("queued");
    scheduler.release(ticket);
    const done = await completed(root, run);
    expect(done.results.map((result) => result.status)).toEqual(["passed", "passed"]);
  } finally {
    scheduler.release(ticket);
    scheduler.close();
  }
}, 30000);

test("a cooperative channel that goes stale is marked incomplete", async () => {
  const { root, run } = await cooperativeFixture(
    [command("stale", "bun stale.ts", { weight: 1, timeoutMs: 30000, resources: ["stale"] })],
    {
      "stale.ts": `const fs = require("node:fs");
fs.writeFileSync(process.env.ORKESTRATOR_VALIDATION_SCHEDULER_STATE, JSON.stringify({ version: 1, pid: process.pid, state: "running", heartbeat: Date.now(), executionMs: 0, queuedMs: 0 }));
setInterval(() => {}, 1000);
`,
    },
  );
  const done = await waitFor(root, run, 15000, { ORKESTRATOR_COOPERATIVE_STALE_MS: "800" });
  expect(done.results[0]!.status).toBe("incomplete");
  expect(done.results[0]!.limitation).toContain("stopped reporting");
});

test("a cooperative runner that exits without sealing is incomplete", async () => {
  const { root, run } = await cooperativeFixture(
    [
      command("unsealed", "bun unsealed.ts", {
        weight: 1,
        timeoutMs: 5000,
        resources: ["unsealed"],
      }),
    ],
    {
      "unsealed.ts": `import { createTestAdmission } from __MODULE__;
createTestAdmission(import.meta.dir, process.env, console.log);
process.exit(0);
`,
    },
  );
  const done = await completed(root, run);
  expect(done.results[0]!.status).toBe("incomplete");
  expect(done.results[0]!.limitation).toContain("did not seal");
});

test("a cooperative startup slower than the stall threshold is not mistaken for a stalled runner", async () => {
  const { root, run } = await cooperativeFixture(
    [
      command("slow-start", "bun slow-cooperative.ts", {
        weight: 1,
        timeoutMs: 8000,
        resources: ["slow-startup"],
      }),
    ],
    {
      "slow-cooperative.ts": `import { createTestAdmission } from __MODULE__;
await Bun.sleep(1500);
const admission = createTestAdmission(import.meta.dir, process.env, console.log);
const result = await admission.run({ name: "fixture", command: "unused", args: [], workers: 1 }, async () => ({ status: 0 }));
admission.close(); process.exitCode = result.status ?? 1;
`,
    },
  );
  // The child stays silent past the stale window (1000 ms) before its first
  // publish, so the startup window — not the stale window — must cover it. The
  // threshold keeps a wide slack above the sleep so spawn/transpile latency on a
  // loaded host cannot turn a slow-but-healthy startup into a stall.
  const done = await waitFor(root, run, 12000, {
    ORKESTRATOR_COOPERATIVE_STALE_MS: "1000",
    ORKESTRATOR_COOPERATIVE_STARTUP_MS: "10000",
  });
  expect(done.results[0]!.status).toBe("passed");
}, 20000);

test("a measured command reserves its observed CPU use on the next run", async () => {
  // The same command twice: the first run is sized by weight, the second by
  // the first run's measured parallelism. Sleeping uses almost no CPU. The
  // step between them makes the rerun meaningful, so it is not skipped as an
  // identical repeat.
  const { root, run } = await fixture([
    command("first", "sleep 1.2"),
    command("between", "touch .orkestrator/between", { dependsOn: ["first"] }),
    command("second", "sleep 1.2", { dependsOn: ["between"] }),
  ]);
  const done = await waitFor(root, run, 15000, { ORKESTRATOR_TEST_HOST_WORKERS: "4" });
  expect(done.results.map((result) => result.status)).toEqual(["passed", "passed", "passed"]);
  expect(done.results[0]).toMatchObject({ reservedWorkers: 4 });
  expect(done.results[0]!.cpuMs).toBeLessThan(done.results[0]!.durationMs);
  expect(done.results[2]).toMatchObject({ reservedWorkers: 1 });
}, 30000);
