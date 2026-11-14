// Review validation worker: host and local queueing, reconnect, queue deadlines and queued cancellation.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { newReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import { createHostTestScheduler } from "@orkestrator/protocol/node/host-test-scheduler";
import { validationPreparation } from "./review-validation-service.js";
import { parseReviewPreparationValidation } from "./commands-review.js";
import { tmpdir } from "node:os";
import {
  fixtures,
  fixture,
  control,
  observeUntil,
  completed,
  waitUntilQueued,
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

test("waiting for a shared workspace resource is reported as queue time with its reason", async () => {
  const { root, run } = await fixture([
    command("build", "sleep 1", { resources: ["dist"] }),
    command("check", "exit 0", { resources: ["dist"] }),
  ]);
  await control(root, run, "start");
  const waiting = await observeUntil(
    root,
    run,
    (next) => next.results[0]?.status === "running" && next.results[1]?.status === "queued",
    5000,
  );
  expect(waiting.results[1]!.queueReason).toContain("Waiting for build");
  const done = await completed(root, run);
  expect(done.results.map((r) => r.status)).toEqual(["passed", "passed"]);
  expect(done.results[1]!.queuedMs).toBeGreaterThan(700);
  expect(done.results[1]!.queueReason).toBeUndefined();
});

test("waiting for the local command budget reports queue time and clears its reason on start", async () => {
  const gate = (name: string) => `until [ -f .orkestrator/release-${name} ]; do sleep 0.02; done`;
  const { root, run, git } = await fixture([
    command("first", gate("first"), { weight: 2, timeoutMs: 10000 }),
    command("second", gate("second"), { weight: 2, timeoutMs: 10000 }),
    command("third", gate("third"), { timeoutMs: 10000 }),
  ]);
  // Leave host capacity spare so the third command is waiting only on this
  // review's local budget, not on an admission ticket or shared resource.
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: [],
      commandProfiles: Object.fromEntries(
        run.plan.commands.map((entry) => [entry.command, { workers: 2, memoryMiB: 64 }]),
      ),
    }),
  );
  git("add", ".");
  git("commit", "-m", "bounded host reservations");
  run.plan.headRef = git("rev-parse", "HEAD");
  await control(root, run, "start");
  const waiting = await observeUntil(
    root,
    run,
    (next) =>
      next.results[0]?.status === "running" &&
      next.results[1]?.status === "running" &&
      next.results[2]?.status === "queued" &&
      next.results[2].queuedMs! >= 100,
    5000,
  );
  expect(waiting.results[2]!.queueReason).toBe("Waiting for this review's local command budget");
  expect(waiting.results[2]!.startedAt).toBeUndefined();
  await writeFile(path.join(root, ".orkestrator/release-first"), "release");
  const running = await observeUntil(
    root,
    run,
    (next) => next.results[2]?.status === "running",
    5000,
  );
  expect(running.results[1]!.status).toBe("running");
  expect(running.results[2]!.queuedMs).toBeGreaterThanOrEqual(waiting.results[2]!.queuedMs!);
  expect(running.results[2]!.queueReason).toBeUndefined();
  await Promise.all(
    ["second", "third"].map((name) =>
      writeFile(path.join(root, `.orkestrator/release-${name}`), "release"),
    ),
  );
  const done = await completed(root, run);
  expect(done.results.map((result) => result.status)).toEqual(["passed", "passed", "passed"]);
  expect(done.results[2]!.queueReason).toBeUndefined();
}, 15000);

test("cooperative queue time preserves an earlier local resource wait", async () => {
  const { root, run, git } = await cooperativeFixture(
    [
      command("build", "until [ -f .orkestrator/release-local ]; do sleep 0.02; done", {
        resources: ["dist"],
        timeoutMs: 10000,
      }),
      command("check", "bun cooperative.ts", {
        resources: ["dist", "host:cooperative-gate"],
        timeoutMs: 1000,
      }),
    ],
    {
      "cooperative.ts": `import { createTestAdmission } from __MODULE__;
const admission = createTestAdmission(import.meta.dir, process.env, console.log);
const result = await admission.run({ name: "fixture", command: "unused", args: [], workers: 1 }, async () => ({ status: 0 }));
admission.close(); process.exitCode = result.status ?? 1;`,
    },
  );
  // The build must fit beside the external blocker even on a small-memory
  // host; only the cooperative command should wait on that blocker.
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: ["bun cooperative.ts"],
      commandProfiles: {
        [run.plan.commands[0]!.command]: { workers: 1, memoryMiB: 64 },
      },
    }),
  );
  git("add", ".");
  git("commit", "-m", "bounded build reservation");
  run.plan.headRef = git("rev-parse", "HEAD");
  const scheduler = createHostTestScheduler({
    directory: path.join(root, ".orkestrator", "scheduler"),
    workers: 8,
    memoryMiB: 8192,
  });
  const blocker = scheduler.enqueue({
    owner: "b".repeat(64),
    workers: 1,
    memoryMiB: 1,
    resources: scheduler.resources(scheduler.owner(root), ["host:cooperative-gate"]),
  });
  try {
    await control(root, run, "start");
    const localWait = await observeUntil(
      root,
      run,
      (next) =>
        next.results[0]?.status === "running" &&
        next.results[1]?.status === "queued" &&
        next.results[1].queueReason?.includes("Waiting for build") === true &&
        next.results[1].queuedMs! >= 100,
      5000,
    );
    await writeFile(path.join(root, ".orkestrator/release-local"), "release");
    const hostWait = await observeUntil(
      root,
      run,
      (next) =>
        next.results[0]?.status === "passed" &&
        next.results[1]?.status === "queued" &&
        next.results[1].queueReason?.includes("exclusive resource") === true &&
        next.results[1].queuedMs! >= localWait.results[1]!.queuedMs! + 100,
      5000,
    );
    expect(hostWait.results[1]!.durationMs).toBe(0);
    scheduler.release(blocker);
    const done = await completed(root, run);
    const projection = JSON.parse(
      await readFile(
        path.join(root, ".orkestrator/review-artifacts", run.id, "scheduler-1.json"),
        "utf8",
      ),
    ) as { queuedMs: number; executionMs: number };
    expect(done.results.map((result) => result.status)).toEqual(["passed", "passed"]);
    expect(projection.queuedMs).toBeGreaterThan(0);
    expect(done.results[1]!.queuedMs).toBeGreaterThanOrEqual(
      localWait.results[1]!.queuedMs! + projection.queuedMs,
    );
    expect(done.results[1]!.durationMs).toBe(projection.executionMs);
    expect(done.results[1]!.durationMs).toBeLessThan(done.results[1]!.queuedMs!);
    expect(done.results[1]!.queueReason).toBeUndefined();
  } finally {
    scheduler.release(blocker);
    scheduler.close();
  }
}, 15000);

test("host queue survives reconnect, excludes wait from timeout, and cancels without running", async () => {
  const { root, run } = await fixture([command("check", "printf admitted", { timeoutMs: 1000 })]);
  const scheduler = createHostTestScheduler({
    directory: path.join(root, ".orkestrator", "scheduler"),
  });
  const capacity = scheduler.capacity();
  const ticket = scheduler.enqueue({
    owner: scheduler.owner(root),
    workers: capacity.workers,
    memoryMiB: capacity.memoryMiB,
  });
  try {
    await control(root, run);
    await waitUntilQueued(root, run);
    await Bun.sleep(1050);
    const waiting = await control(root, run, "status");
    expect(waiting.results[0]!.status).toBe("queued");
    expect(waiting.results[0]!.startedAt).toBeUndefined();
    expect(waiting.results[0]!.stdoutPath).toBeNull();
    scheduler.release(ticket);
    const done = await completed(root, run);
    expect(done.results[0]!.status).toBe("passed");
    expect(done.results[0]!.queuedMs).toBeGreaterThan(1000);
    expect(done.results[0]!.durationMs).toBeLessThan(1000);
  } finally {
    scheduler.release(ticket);
    scheduler.close();
  }
});

test("worktree drift during host admission still runs and records the changed files", async () => {
  const { root, run } = await fixture([command("check", "touch .orkestrator/should-not-run")]);
  const scheduler = createHostTestScheduler({
    directory: path.join(root, ".orkestrator", "scheduler"),
  });
  const capacity = scheduler.capacity();
  const ticket = scheduler.enqueue({
    owner: scheduler.owner(root),
    workers: capacity.workers,
    memoryMiB: capacity.memoryMiB,
  });
  try {
    await control(root, run);
    const deadline = Date.now() + 3000;
    while (
      (await control(root, run, "status")).results[0]!.status !== "queued" &&
      Date.now() < deadline
    )
      await Bun.sleep(50);
    await writeFile(path.join(root, "source.txt"), "changed while waiting");
    scheduler.release(ticket);
    const done = await completed(root, run);
    expect(done.status).toBe("completed");
    expect(done.error).toBeUndefined();
    expect(done.results[0]!.status).toBe("passed");
    expect(done.environmentChanges).toEqual(["source.txt"]);
    expect(Bun.file(path.join(root, ".orkestrator/should-not-run")).exists()).resolves.toBe(true);
  } finally {
    scheduler.release(ticket);
    scheduler.close();
  }
});

test("HEAD change during host admission still refuses stale validation", async () => {
  const { root, run, git } = await fixture([command("check", "touch .orkestrator/should-not-run")]);
  const scheduler = createHostTestScheduler({
    directory: path.join(root, ".orkestrator", "scheduler"),
  });
  const capacity = scheduler.capacity();
  const ticket = scheduler.enqueue({
    owner: scheduler.owner(root),
    workers: capacity.workers,
    memoryMiB: capacity.memoryMiB,
  });
  try {
    await control(root, run);
    const deadline = Date.now() + 3000;
    while (
      (await control(root, run, "status")).results[0]!.status !== "queued" &&
      Date.now() < deadline
    )
      await Bun.sleep(50);
    await writeFile(path.join(root, "source.txt"), "committed while waiting\n");
    git("add", ".");
    git("commit", "-m", "moved head while queued");
    scheduler.release(ticket);
    const done = await completed(root, run);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("HEAD changed");
    expect(done.results[0]!.stdoutPath).toBeNull();
    expect(Bun.file(path.join(root, ".orkestrator/should-not-run")).exists()).resolves.toBe(false);
  } finally {
    scheduler.release(ticket);
    scheduler.close();
  }
});

test("queue deadline and queued cancellation produce no command side effects", async () => {
  const { root, run } = await fixture([command("check", "touch .orkestrator/should-not-run")]);
  const scheduler = createHostTestScheduler({
    directory: path.join(root, ".orkestrator", "scheduler"),
  });
  const capacity = scheduler.capacity();
  const ticket = scheduler.enqueue({
    owner: scheduler.owner(root),
    workers: capacity.workers,
    memoryMiB: capacity.memoryMiB,
  });
  try {
    await control(root, run, "start", { ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS: "1000" });
    const done = await completed(root, run);
    expect(done.status).toBe("completed");
    expect(done.results[0]).toMatchObject({
      status: "incomplete",
      stdoutPath: null,
      durationMs: 0,
    });
    expect(
      parseReviewPreparationValidation(validationPreparation(done).validation, done.id)[0]!.status,
    ).toBe("incomplete");
    const cancelled = newReviewValidationRun(run.id + "-cancel", run.plan);
    fixtures.push({ root, run: cancelled });
    await control(root, cancelled);
    await Bun.sleep(150);
    expect((await control(root, cancelled, "cancel")).status).toBe("cancelled");
    expect(await Bun.file(path.join(root, ".orkestrator/should-not-run")).exists()).toBe(false);
  } finally {
    scheduler.release(ticket);
    scheduler.close();
  }
});

test("cooperative group admission avoids double reservation and excludes host wait from command timeout", async () => {
  const { root, run, git } = await fixture([
    command("check", "bun cooperative.ts", {
      weight: 2,
      timeoutMs: 1000,
      resources: ["shared-database"],
    }),
  ]);
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({ version: 1, cooperativeCommands: ["bun cooperative.ts"] }),
  );
  const modulePath = path.resolve(import.meta.dir, "../../../../scripts/test-admission.ts");
  await writeFile(
    path.join(root, "cooperative.ts"),
    `import { createTestAdmission } from ${JSON.stringify(modulePath)};
const admission = createTestAdmission(import.meta.dir, process.env, console.log);
const result = await admission.run({ name: "fixture", command: "unused", args: [], workers: 1 }, async () => { console.log("test executed"); await Bun.sleep(50); return { status: 0 }; });
admission.close(); process.exitCode = result.status ?? 1;
`,
  );
  git("add", ".");
  git("commit", "-m", "cooperative runner");
  run.plan.headRef = git("rev-parse", "HEAD");
  const scheduler = createHostTestScheduler({
    directory: path.join(root, ".orkestrator", "scheduler"),
  });
  const ticket = scheduler.enqueue({
    owner: scheduler.owner(root),
    workers: 1,
    memoryMiB: 1,
    resources: scheduler.resources(scheduler.owner(root), ["shared-database"]),
  });
  try {
    await control(root, run);
    await waitUntilQueued(root, run);
    await Bun.sleep(1050);
    const waiting = await control(root, run, "status");
    expect(waiting.results[0]!.status).toBe("queued");
    scheduler.release(ticket);
    const done = await completed(root, run);
    expect(done.results[0]!.status).toBe("passed");
    expect(done.results[0]!.queuedMs).toBeGreaterThan(1000);
    expect(done.results[0]!.durationMs).toBeLessThan(1000);
    expect(await readFile(path.join(root, done.results[0]!.stdoutPath!), "utf8")).toContain(
      "test executed",
    );
  } finally {
    scheduler.release(ticket);
    scheduler.close();
  }
});

test("a command that expires while queued keeps no stale queue explanation", async () => {
  const { root, run } = await fixture([command("blocked", "printf blocked")]);
  const scheduler = createHostTestScheduler({
    directory: path.join(root, ".orkestrator", "scheduler"),
    workers: 1,
    memoryMiB: 64,
  });
  const blocker = scheduler.enqueue({ owner: "b".repeat(64), workers: 1, memoryMiB: 64 });
  try {
    // The worker publishes "queued" together with its reason, and the test reads
    // that state file directly (no control process per poll), so seeing it needs
    // only a few 20 ms polls; 3 s of queueing leaves wide margin before expiry.
    await control(root, run, "start", { ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS: "3000" });
    const queued = await observeUntil(
      root,
      run,
      (next) => next.results[0]?.status === "queued" && next.results[0].queueReason !== undefined,
      3000,
    );
    expect(queued.results[0]!.queueReason).toContain("worker slots");
    let done = await control(root, run, "status");
    const deadline = Date.now() + 12000;
    while (["planned", "running"].includes(done.status) && Date.now() < deadline) {
      await Bun.sleep(50);
      done = await control(root, run, "status");
    }
    expect(done.results[0]!.status).toBe("incomplete");
    expect(done.results[0]!.limitation).toContain("Host capacity wait expired");
    expect(done.results[0]!.queueReason).toBeUndefined();
  } finally {
    scheduler.release(blocker);
    scheduler.close();
  }
}, 20000);

test("review validation queues across worktrees and rehydrates hashed artifacts", async () => {
  const first = await fixture([
    command(
      "first",
      "while [ ! -f .orkestrator/release-first ]; do sleep 0.1; done; printf first-output",
      { timeoutMs: 20000 },
    ),
  ]);
  const second = await fixture([command("second", "printf second-output")]);
  const schedulerDirectory = await mkdtemp(path.join(tmpdir(), "review-shared-scheduler-"));
  const scheduler = createHostTestScheduler({
    directory: schedulerDirectory,
    workers: 2,
    memoryMiB: 4096,
  });
  const blocker = scheduler.enqueue({ owner: "c".repeat(64), workers: 1, memoryMiB: 1 });
  const env = {
    ORKESTRATOR_TEST_SCHEDULER_DIR: schedulerDirectory,
    ORKESTRATOR_TEST_HOST_WORKERS: "2",
    ORKESTRATOR_TEST_HOST_MEMORY_MIB: "4096",
  };
  try {
    await control(first.root, first.run, "start", env);
    const firstDeadline = Date.now() + 8000;
    let firstState = await control(first.root, first.run, "status");
    while (
      ["pending", "queued"].includes(firstState.results[0]!.status) &&
      ["planned", "running"].includes(firstState.status) &&
      Date.now() < firstDeadline
    ) {
      await Bun.sleep(50);
      firstState = await control(first.root, first.run, "status");
    }
    expect(firstState.results[0]!.status).toBe("running");
    await control(second.root, second.run, "start", env);
    // The second worktree waits for the one remaining host slot.
    const secondDeadline = Date.now() + 5000;
    let secondState = await control(second.root, second.run, "status");
    while (
      secondState.results[0]!.status === "pending" &&
      ["planned", "running"].includes(secondState.status) &&
      Date.now() < secondDeadline
    ) {
      await Bun.sleep(50);
      secondState = await control(second.root, second.run, "status");
    }
    expect(secondState.results[0]!.status).toBe("queued");
    // Release the held first command only after the queued observation is
    // recorded, so host admission cannot be outrun by spawn latency.
    await mkdir(path.join(first.root, ".orkestrator"), { recursive: true });
    await writeFile(path.join(first.root, ".orkestrator", "release-first"), "release");
    scheduler.release(blocker);
    const doneFirst = await completed(first.root, first.run);
    const doneSecond = await completed(second.root, second.run);
    expect(doneFirst.results[0]!.status).toBe("passed");
    expect(doneSecond.results[0]!.status).toBe("passed");
    expect(doneFirst.results[0]!.stdoutSha256).toHaveLength(64);
    expect(doneSecond.results[0]!.stdoutSha256).toHaveLength(64);
  } finally {
    scheduler.release(blocker);
    scheduler.close();
    await rm(schedulerDirectory, { recursive: true, force: true });
  }
}, 30000);
