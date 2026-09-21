import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  createHostTestScheduler,
  HOST_TEST_SCHEDULER_SOURCE,
  testSchedulingPolicy,
} from "../../packages/protocol/src/host-test-scheduler";
import { createTestAdmission } from "../../scripts/test-admission";
import { createTestTimingsDirectory, runAllTests } from "../../scripts/test-all";

const cleanups: Array<() => void> = [];
function fixture(options = { workers: 2, memoryMiB: 128 }) {
  const directory = mkdtempSync(path.join(tmpdir(), "test-admission-fixture-"));
  const scheduler = createHostTestScheduler({ directory, ...options });
  cleanups.push(() => {
    scheduler.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = {
    owner: "a".repeat(64),
    workers: scheduler.capacity().workers,
    memoryMiB: options.memoryMiB,
  };
  return { directory, scheduler, request };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test("host tuning can exceed the suite cap but leaves hardware headroom", () => {
  const { scheduler } = fixture({ workers: 64, memoryMiB: 128 });
  expect(scheduler.capacity().workers).toBe(Math.max(1, Math.min(64, availableParallelism() - 2)));
});

test("workspace wildcards isolate worktrees and host resources still exclude them", () => {
  const { scheduler } = fixture();
  const a = "a".repeat(64),
    b = "b".repeat(64);
  const request = { owner: a, workers: 1, memoryMiB: 1 };
  const first = scheduler.enqueue({
    ...request,
    resources: scheduler.resources(a, ["workspace:*"]),
  });
  const other = scheduler.enqueue({
    ...request,
    owner: b,
    resources: scheduler.resources(b, ["workspace:dist"]),
  });
  expect(scheduler.poll(other).state).toBe("running");
  scheduler.release(other);
  const same = scheduler.enqueue({
    ...request,
    resources: scheduler.resources(a, ["workspace:dist"]),
  });
  expect(scheduler.poll(same).queueReason).toContain("exclusive resource");
  scheduler.release(same);
  scheduler.release(first);
  const host = scheduler.enqueue({
    ...request,
    resources: scheduler.resources(a, ["host:tcp:1422"]),
  });
  const blocked = scheduler.enqueue({
    ...request,
    owner: b,
    resources: scheduler.resources(b, ["host:tcp:1422"]),
  });
  expect(scheduler.poll(blocked).state).toBe("queued");
  scheduler.release(host);
  expect(scheduler.poll(blocked).state).toBe("running");
  scheduler.release(blocked);
});

test("interleaved cohort siblings use spare slots with a finite bypass budget", () => {
  const { scheduler } = fixture();
  const request = {
    owner: "a".repeat(64),
    workers: 1,
    memoryMiB: 1,
    resources: ["*"],
    cohort: "a".repeat(36),
  };
  const first = scheduler.enqueue(request);
  const outside = scheduler.enqueue({ owner: "b".repeat(64), workers: 1, memoryMiB: 1 });
  for (let i = 0; i < 32; i++) {
    const sibling = scheduler.enqueue(request);
    expect(scheduler.poll(sibling).state).toBe("running");
    expect(scheduler.poll(outside).state).toBe("queued");
    scheduler.release(sibling);
  }
  const overflow = scheduler.enqueue(request);
  expect(scheduler.poll(overflow).state).toBe("queued");
  scheduler.release(first);
  expect(scheduler.poll(outside).state).toBe("running");
  scheduler.release(outside);
  expect(scheduler.poll(overflow).state).toBe("running");
  scheduler.release(overflow);
});

test("a different worktree cannot share a cohort's resource exemption", () => {
  const { scheduler } = fixture();
  const request = {
    owner: "a".repeat(64),
    workers: 1,
    memoryMiB: 1,
    cohort: "a".repeat(36),
    resources: ["*"],
  };
  const first = scheduler.enqueue(request);
  const outside = scheduler.enqueue({ ...request, owner: "b".repeat(64) });
  expect(scheduler.poll(outside).state).toBe("queued");
  scheduler.release(first);
  scheduler.release(outside);
});

test("parallel group clocks measure wall time and exclude startup and idle gaps", async () => {
  const { scheduler, directory } = fixture({ workers: 2, memoryMiB: 4096 });
  const blocker = scheduler.enqueue({ owner: "b".repeat(64), workers: 2, memoryMiB: 1 });
  const channel = path.join(directory, "wall-clock.json");
  let now = 100;
  const admission = createTestAdmission(
    directory,
    { ORKESTRATOR_TEST_SCHEDULER_DIR: directory, ORKESTRATOR_VALIDATION_SCHEDULER_STATE: channel },
    () => {},
    () => now,
  );
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started = 0;
  now = 200; // setup is not charged
  const jobs = ["a", "b"].map((name) =>
    admission.run({ name, command: "unused", args: [], workers: 1 }, async () => {
      started++;
      await gate;
      return { status: 0 };
    }),
  );
  try {
    now = 500;
    scheduler.release(blocker);
    const deadline = Date.now() + 3000;
    while (started < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(started).toBe(2);
    now = 800;
    finish();
    await Promise.all(jobs);
    now = 1200; // finalization is not charged
    admission.close();
    expect(JSON.parse(readFileSync(channel, "utf8"))).toMatchObject({
      version: 1,
      timing: "wall",
      state: "completed",
      queuedMs: 300,
      executionMs: 300,
    });
  } finally {
    scheduler.release(blocker);
    finish();
    admission.cancel();
    await Promise.all(jobs);
  }
});

test("repository scheduling profiles are bounded and use exact command declarations", () => {
  expect(
    testSchedulingPolicy({
      version: 1,
      cooperativeCommands: ["full"],
      commandProfiles: {
        full: { resources: ["*"], covers: ["changed"] },
        lint: { workers: 1, memoryMiB: 128, noProgressTimeoutMs: 300_000 },
      },
    }).profiles.lint?.workers,
  ).toBe(1);
  expect(
    testSchedulingPolicy({
      version: 1,
      cooperativeCommands: [],
      commandProfiles: { lint: { noProgressTimeoutMs: 300_000 } },
    }).profiles.lint?.noProgressTimeoutMs,
  ).toBe(300_000);
  const accepted = testSchedulingPolicy({ version: 1, cooperativeCommands: [] });
  // Profiles are keyed by an attacker-irrelevant but prototype-sensitive string;
  // a null prototype keeps `profiles["constructor"]` a miss rather than a hit.
  expect(Object.getPrototypeOf(accepted.profiles)).toBeNull();
  expect(accepted.profiles["toString"]).toBeUndefined();
  const overflow = (count: number) => Array.from({ length: count }, (_, index) => `c${index}`);
  for (const invalid of [
    null,
    "config",
    [],
    { version: 2, cooperativeCommands: [] },
    { version: 1 },
    { version: 1, cooperativeCommands: "full" },
    { version: 1, cooperativeCommands: [""] },
    { version: 1, cooperativeCommands: ["x".repeat(1025)] },
    { version: 1, cooperativeCommands: overflow(33) },
    { version: 1, cooperativeCommands: [], commandProfiles: [] },
    { version: 1, cooperativeCommands: [], commandProfiles: null },
    {
      version: 1,
      cooperativeCommands: [],
      commandProfiles: Object.fromEntries(overflow(33).map((key) => [key, {}])),
    },
    { version: 1, cooperativeCommands: [], commandProfiles: { ["x".repeat(1025)]: {} } },
    { version: 1, cooperativeCommands: [], commandProfiles: { "": {} } },
    { version: 1, cooperativeCommands: [], commandProfiles: { invalid: null } },
    { version: 1, cooperativeCommands: [], commandProfiles: { invalid: [] } },
    { version: 1, cooperativeCommands: [], commandProfiles: { invalid: { workers: 0 } } },
    { version: 1, cooperativeCommands: [], commandProfiles: { invalid: { workers: 65 } } },
    { version: 1, cooperativeCommands: [], commandProfiles: { invalid: { workers: 1.5 } } },
    { version: 1, cooperativeCommands: [], commandProfiles: { invalid: { memoryMiB: 0 } } },
    { version: 1, cooperativeCommands: [], commandProfiles: { invalid: { memoryMiB: 1048577 } } },
    {
      version: 1,
      cooperativeCommands: [],
      commandProfiles: { invalid: { noProgressTimeoutMs: 999 } },
    },
    {
      version: 1,
      cooperativeCommands: [],
      commandProfiles: { invalid: { noProgressTimeoutMs: 7_200_001 } },
    },
    {
      version: 1,
      cooperativeCommands: [],
      commandProfiles: { invalid: { noProgressTimeoutMs: 1_000.5 } },
    },
    { version: 1, cooperativeCommands: [], commandProfiles: { invalid: { resources: [42] } } },
    { version: 1, cooperativeCommands: [], commandProfiles: { invalid: { covers: [42] } } },
    {
      version: 1,
      cooperativeCommands: [],
      commandProfiles: { invalid: { covers: overflow(33) } },
    },
  ])
    expect(() => testSchedulingPolicy(invalid)).toThrow();
});

test("a queue created before the bypass column migrates and keeps admitting", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "test-admission-legacy-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "queue.sqlite");
  // The scheduler directory is versioned `v1` and is deliberately shared with
  // worktrees running older builds, so an older row shape must still migrate.
  const legacy = new Database(databasePath, { create: true });
  legacy.exec(`CREATE TABLE jobs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
    owner TEXT NOT NULL, pid INTEGER NOT NULL, child INTEGER,
    workers INTEGER NOT NULL, memory INTEGER NOT NULL, resources TEXT NOT NULL,
    state TEXT NOT NULL, queued INTEGER NOT NULL, admitted INTEGER
  ); CREATE TABLE owners (id TEXT PRIMARY KEY, served INTEGER NOT NULL);
  CREATE TABLE budget (id INTEGER PRIMARY KEY CHECK(id=1), workers INTEGER, memory INTEGER);`);
  legacy
    .query(
      "INSERT INTO jobs (id,owner,pid,workers,memory,resources,state,queued) VALUES (?,?,?,?,?,?,'running',?)",
    )
    .run("legacy", "a".repeat(64), process.pid, 1, 1, "[]", Date.now());
  legacy.exec("INSERT INTO owners VALUES ('" + "a".repeat(64) + "', 0)");
  legacy.exec("INSERT INTO budget VALUES (1, 2, 128)");
  legacy.close();
  const scheduler = createHostTestScheduler({ directory, workers: 2, memoryMiB: 128 });
  cleanups.push(() => scheduler.close());
  // The retained legacy reservation keeps the budget frozen at its own values.
  expect(scheduler.capacity()).toEqual({ workers: 2, memoryMiB: 128 });
  const id = scheduler.enqueue({ owner: "b".repeat(64), workers: 1, memoryMiB: 1 });
  expect(scheduler.poll(id).state).toBe("running");
  // Read-write, not readonly: SQLite in WAL mode needs to initialise its shared
  // index, which a readonly handle cannot do.
  const reader = new Database(databasePath);
  expect(reader.query("SELECT bypasses FROM jobs WHERE id='legacy'").get()).toEqual({
    bypasses: 0,
  });
  reader.close();
  scheduler.release(id);
});

test("memory pressure and a heavy fair-turn waiter cannot be bypassed by unrelated small jobs", () => {
  const { scheduler } = fixture();
  const first = scheduler.enqueue({ owner: "a".repeat(64), workers: 1, memoryMiB: 100 });
  const heavy = scheduler.enqueue({ owner: "b".repeat(64), workers: 1, memoryMiB: 100 });
  const small = scheduler.enqueue({ owner: "c".repeat(64), workers: 1, memoryMiB: 1 });
  expect(scheduler.poll(heavy).queueReason).toContain("estimated memory budget");
  expect(scheduler.poll(small).queueReason).toContain("fair turn");
  scheduler.release(first);
  expect(scheduler.poll(heavy).state).toBe("running");
  expect(scheduler.poll(small).state).toBe("running");
  scheduler.release(heavy);
  scheduler.release(small);
});

test("workspace exclusion also covers commands without named resources; legacy locks stay global", () => {
  const { scheduler } = fixture();
  const owner = "a".repeat(64);
  const request = { owner, workers: 1, memoryMiB: 1 };
  const first = scheduler.enqueue({
    ...request,
    resources: scheduler.resources(owner, ["workspace:*"]),
  });
  const empty = scheduler.enqueue(request);
  expect(scheduler.poll(empty).state).toBe("queued");
  scheduler.release(first);
  scheduler.release(empty);
  expect(scheduler.resources(owner, ["*"])).toEqual(["*"]);
  expect(scheduler.resources(owner, ["database"])).toEqual(
    scheduler.resources("b".repeat(64), ["host:database"]),
  );
});

test("the scheduler factory remains self-contained after production bundling", async () => {
  const { directory } = fixture();
  const build = await Bun.build({
    entrypoints: [
      path.resolve(import.meta.dir, "../../packages/protocol/src/host-test-scheduler.ts"),
    ],
    target: "bun",
    minify: true,
  });
  expect(build.success).toBe(true);
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(await build.outputs[0]!.text()).toString("base64")
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const scheduler = (${module.HOST_TEST_SCHEDULER_SOURCE})(${JSON.stringify({ directory })}); console.log(scheduler.capacity().workers); scheduler.close();`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(errors).toBe("");
  expect(code).toBe(0);
  expect(Number(output.trim())).toBeGreaterThan(0);
});

test("linked worktrees never concurrently overwrite the same timing profile", () => {
  const { directory } = fixture();
  const first = path.join(directory, "first"),
    second = path.join(directory, "second");
  mkdirSync(first);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: first, stdio: "ignore" });
  git("init", "-b", "main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  git("worktree", "add", "--detach", second, "HEAD");
  const a = createTestTimingsDirectory(first),
    b = createTestTimingsDirectory(second);
  try {
    expect(a).not.toBe(b);
    expect(createTestTimingsDirectory(first)).toBe(a);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("host ceiling, fair worktree turns, and FIFO prevent heavy request starvation", () => {
  const { scheduler, request } = fixture();
  const first = scheduler.enqueue(request);
  const otherWorktree = scheduler.enqueue({ ...request, owner: "b".repeat(64) });
  const sameWorktree = scheduler.enqueue(request);
  expect(scheduler.poll(first).state).toBe("running");
  expect(scheduler.poll(sameWorktree).state).toBe("queued");
  expect(scheduler.poll(otherWorktree).state).toBe("queued");
  scheduler.release(first);
  expect(scheduler.poll(otherWorktree).state).toBe("running");
  expect(scheduler.poll(sameWorktree).state).toBe("queued");
  scheduler.release(otherWorktree);
  expect(scheduler.poll(sameWorktree).state).toBe("running");
  scheduler.release(sameWorktree);
});

test("resource exclusion, queue bounds, cancellation and frozen budgets", () => {
  const { scheduler, request, directory } = fixture();
  const first = scheduler.enqueue({
    ...request,
    workers: 1,
    memoryMiB: 1,
    resources: ["simulator"],
  });
  const next = scheduler.enqueue({
    ...request,
    workers: 1,
    memoryMiB: 1,
    resources: ["simulator"],
  });
  expect(scheduler.poll(next).state).toBe("queued");
  const lower = createHostTestScheduler({ directory, workers: 1, memoryMiB: 1 });
  expect(lower.capacity()).toEqual(scheduler.capacity());
  lower.close();
  scheduler.release(next);
  expect(() => scheduler.poll(next)).toThrow("will not be repeated");
  expect(() => scheduler.enqueue({ ...request, memoryMiB: 129 })).toThrow("exceeds");
  const queued = Array.from({ length: 255 }, () => scheduler.enqueue(request));
  expect(() => scheduler.enqueue(request)).toThrow("queue is full");
  for (const id of queued) scheduler.release(id);
  scheduler.release(first);
});

test("cooperative constituents share exclusive resources without exposing them to other runs", () => {
  const { scheduler, request } = fixture();
  const cohort = "a".repeat(36);
  const first = scheduler.enqueue({
    ...request,
    workers: 1,
    memoryMiB: 1,
    resources: ["*"],
    cohort,
  });
  const second = scheduler.enqueue({
    ...request,
    workers: 1,
    memoryMiB: 1,
    resources: ["*"],
    cohort,
  });
  expect(scheduler.poll(second).state).toBe(request.workers >= 2 ? "running" : "queued");
  const outside = scheduler.enqueue({
    ...request,
    owner: "b".repeat(64),
    workers: 1,
    memoryMiB: 1,
  });
  expect(scheduler.poll(outside).state).toBe("queued");
  scheduler.release(first);
  expect(scheduler.poll(second).state).toBe("running");
  expect(scheduler.poll(outside).state).toBe("queued");
  scheduler.release(second);
  expect(scheduler.poll(outside).state).toBe("running");
  scheduler.release(outside);
});

test("independent processes share admission; a dead owner is recovered without redispatch", async () => {
  const { scheduler, directory, request } = fixture();
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const scheduler = (${HOST_TEST_SCHEDULER_SOURCE})(${JSON.stringify({ directory, workers: request.workers, memoryMiB: 128 })}); const id = scheduler.enqueue(${JSON.stringify(request)}); console.log(id); setInterval(() => {}, 1000);`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value).trim()).toMatch(/^[a-f0-9-]{36}$/);
    reader.releaseLock();
    const next = scheduler.enqueue({ ...request, owner: "b".repeat(64) });
    expect(scheduler.poll(next).state).toBe("queued");
    child.kill("SIGKILL");
    await child.exited;
    expect(scheduler.poll(next).state).toBe("running");
    scheduler.release(next);
  } finally {
    child.kill();
    await child.exited;
  }
});

test("separate runners queue without starting children and cancellation removes their ticket", async () => {
  const { directory } = fixture();
  const env = { ORKESTRATOR_TEST_SCHEDULER_DIR: directory };
  const a = createTestAdmission(directory, env, () => {}),
    b = createTestAdmission(directory, env, () => {});
  let finish!: () => void,
    started = false;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const group = { name: "fixture", command: "unused", args: [], exclusive: true };
  const running = a.run(group, async () => {
    started = true;
    await gate;
    return { status: 0 };
  });
  expect(started).toBe(true);
  let duplicateStarted = false;
  const pending = b.run(group, async () => {
    duplicateStarted = true;
    return { status: 0 };
  });
  await Bun.sleep(150);
  expect(duplicateStarted).toBe(false);
  b.cancel();
  expect(await pending).toMatchObject({ status: 75, infrastructureError: true });
  finish();
  expect(await running).toMatchObject({ status: 0 });
  a.close();
  b.close();
});

test("unconfigured nested aggregate commands report incomplete instead of deadlocking", async () => {
  const lines: string[] = [];
  expect(
    await runAllTests({
      env: { ORKESTRATOR_TEST_PARENT_RESERVATION: "parent-run" },
      log: (line) => lines.push(line),
    }),
  ).toBe(75);
  expect(lines.join("\n")).toContain("avoided double reservation");
});

test("dead-owner cleanup drains the registered child group before returning capacity", async () => {
  const { scheduler, directory, request } = fixture();
  const owner = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
const scheduler = (${HOST_TEST_SCHEDULER_SOURCE})(${JSON.stringify({ directory, workers: request.workers, memoryMiB: 128 })});
const ticket = scheduler.enqueue(${JSON.stringify(request)});
const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
scheduler.registerChild(ticket, child.pid);
console.log(child.pid); setInterval(() => {}, 1000);
`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  let childPid: number | undefined;
  try {
    const reader = owner.stdout.getReader();
    childPid = Number(new TextDecoder().decode((await reader.read()).value).trim());
    reader.releaseLock();
    expect(Number.isSafeInteger(childPid) && childPid > 1).toBe(true);
    const next = scheduler.enqueue({ ...request, owner: "b".repeat(64) });
    expect(scheduler.poll(next).state).toBe("queued");
    owner.kill("SIGKILL");
    await owner.exited;
    const deadline = Date.now() + 3000;
    while (scheduler.poll(next).state === "queued" && Date.now() < deadline) await Bun.sleep(20);
    expect(scheduler.poll(next).state).toBe("running");
    expect(() => process.kill(-childPid!, 0)).toThrow();
    scheduler.release(next);
  } finally {
    owner.kill("SIGKILL");
    await owner.exited;
    if (childPid && Number.isSafeInteger(childPid) && childPid > 1) {
      try {
        process.kill(-childPid, "SIGKILL");
      } catch {}
    }
  }
});

test("a reused owner pid releases capacity instead of stranding it", async () => {
  const { scheduler, directory, request } = fixture();
  const owner = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const scheduler = (${HOST_TEST_SCHEDULER_SOURCE})(${JSON.stringify({ directory, workers: request.workers, memoryMiB: 128 })}); const id = scheduler.enqueue(${JSON.stringify(request)}); console.log(id); setInterval(() => {}, 1000);`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = owner.stdout.getReader();
    const id = new TextDecoder().decode((await reader.read()).value).trim();
    reader.releaseLock();
    expect(id).toMatch(/^[a-f0-9-]{36}$/);
    owner.kill("SIGKILL");
    await owner.exited;
    // Simulate pid reuse: the dead owner's pid now belongs to an unrelated live
    // process, so only the birth token can tell them apart.
    const db = new Database(path.join(directory, "queue.sqlite"));
    try {
      db.query("UPDATE jobs SET pid=?, pidBorn=? WHERE id=?").run(
        process.pid,
        "unrelated-live-process",
        id,
      );
    } finally {
      db.close();
    }
    const next = scheduler.enqueue({ ...request, owner: "b".repeat(64) });
    expect(scheduler.poll(next).state).toBe("running");
    scheduler.release(next);
  } finally {
    owner.kill("SIGKILL");
    await owner.exited;
  }
});

test("admission queue time excludes runner setup and idle gaps", async () => {
  const { directory } = fixture();
  const channel = path.join(directory, "channel.json");
  const admission = createTestAdmission(
    directory,
    {
      ORKESTRATOR_TEST_SCHEDULER_DIR: directory,
      ORKESTRATOR_VALIDATION_SCHEDULER_STATE: channel,
    },
    () => {},
  );
  const group = { name: "timing", command: "unused", args: [], exclusive: true };
  await Bun.sleep(350); // setup before the first group
  await admission.run(group, async () => ({ status: 0 }));
  await Bun.sleep(350); // idle gap between groups
  await admission.run(group, async () => ({ status: 0 }));
  admission.close();
  const value = JSON.parse(readFileSync(channel, "utf8")) as { queuedMs: number };
  expect(value.queuedMs).toBeLessThan(200);
});

test("a failed publish in the admission finally does not discard a group's result", async () => {
  const { directory } = fixture();
  const channelDirectory = path.join(directory, "channel");
  mkdirSync(channelDirectory);
  const channel = path.join(channelDirectory, "state.json");
  const admission = createTestAdmission(
    directory,
    {
      ORKESTRATOR_TEST_SCHEDULER_DIR: directory,
      ORKESTRATOR_VALIDATION_SCHEDULER_STATE: channel,
    },
    () => {},
  );
  const group = { name: "fixture", command: "unused", args: [], exclusive: true };
  expect((await admission.run(group, async () => ({ status: 0 }))).status).toBe(0);
  rmSync(channelDirectory, { recursive: true, force: true });
  // The channel can no longer be written; the run must still resolve rather than
  // reject and lose the group's result.
  const result = await admission.run(group, async () => ({ status: 0 }));
  expect(result).toMatchObject({ status: 75, infrastructureError: true });
  admission.close();
});

test("cooperative admission continues on a dirty worktree and still refuses a moved HEAD", async () => {
  const { directory } = fixture();
  const worktree = path.join(directory, "worktree");
  mkdirSync(worktree);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-b", "main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const head = git("rev-parse", "HEAD").trim();
  writeFileSync(path.join(worktree, "dirty.txt"), "changed\n");
  const notes: string[] = [];
  const admission = createTestAdmission(
    worktree,
    {
      ORKESTRATOR_TEST_SCHEDULER_DIR: directory,
      ORKESTRATOR_VALIDATION_HEAD_REF: head,
      ORKESTRATOR_VALIDATION_SCHEDULER_STATE: path.join(directory, "channel.json"),
    },
    (line) => notes.push(line),
  );
  const group = { name: "fixture", command: "unused", args: [], exclusive: true };
  expect((await admission.run(group, async () => ({ status: 0 }))).status).toBe(0);
  expect(notes.some((line) => line.includes("worktree is dirty"))).toBe(true);
  git("add", "dirty.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "moved");
  const stale = await admission.run(group, async () => ({ status: 0 }));
  expect(stale).toMatchObject({ status: 75, infrastructureError: true });
  expect(String(stale.output)).toContain("Repository changed while queued");
  admission.close();
});
