import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import {
  createHostTestScheduler,
  HOST_TEST_SCHEDULER_SOURCE,
} from "../../packages/protocol/src/host-test-scheduler";
import { createTestAdmission } from "../../scripts/test-admission";
import { createTestTimingsDirectory, runAllTests } from "../../scripts/test-all";

const cleanups: Array<() => void> = [];
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "test-admission-fixture-"));
  const scheduler = createHostTestScheduler({ directory, workers: 2, memoryMiB: 128 });
  cleanups.push(() => {
    scheduler.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = { owner: "a".repeat(64), workers: scheduler.capacity().workers, memoryMiB: 128 };
  return { directory, scheduler, request };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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
