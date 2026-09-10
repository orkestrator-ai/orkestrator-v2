import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  newReviewValidationRun,
  isReviewValidationRun,
  parseReviewValidationPlan,
  type ReviewValidationPlan,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { REVIEW_VALIDATION_CONTROL, REVIEW_VALIDATION_WORKER } from "./review-validation-worker.js";
import { verifyValidationArtifacts } from "./review-validation-artifacts.js";
import type { Environment } from "./models.js";
import { createHostTestScheduler } from "@orkestrator/protocol/host-test-scheduler";
import { validationPreparation } from "./review-validation-service.js";
import { parseReviewPreparationValidation } from "./commands-review.js";

const fixtures: Array<{ root: string; run: ReviewValidationRun }> = [];
const command = (
  id: string,
  shell: string,
  extra: Partial<ReviewValidationPlan["commands"][number]> = {},
) => ({
  id,
  command: shell,
  cwd: ".",
  dependsOn: [],
  resources: [],
  weight: 1 as const,
  timeoutMs: 5000,
  ...extra,
});
async function fixture(commands: ReviewValidationPlan["commands"] = []) {
  const root = await mkdtemp(path.join(tmpdir(), "review-validation-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "source.txt"), "original\n");
  await writeFile(path.join(root, ".gitignore"), ".orkestrator/\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  const run = newReviewValidationRun(`review-validation-${randomUUID()}`, {
    headRef: git("rev-parse", "HEAD"),
    commands,
    limitations: commands.length ? [] : ["No checks configured"],
  });
  const entry = { root, run };
  fixtures.push(entry);
  return { ...entry, git };
}
async function control(
  root: string,
  run: ReviewValidationRun,
  action = "start",
  extraEnv: Record<string, string> = {},
) {
  const payload = Buffer.from(JSON.stringify({ root, run, action })).toString("base64");
  const child = Bun.spawn(
    [process.execPath, "-e", REVIEW_VALIDATION_CONTROL, payload, REVIEW_VALIDATION_WORKER],
    {
      cwd: "/",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ORKESTRATOR_TEST_SCHEDULER_DIR: path.join(root, ".orkestrator", "scheduler"),
        ...extraEnv,
      },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  const result: unknown = JSON.parse(stdout);
  expect(isReviewValidationRun(result)).toBe(true);
  return result as ReviewValidationRun;
}
async function completed(root: string, run: ReviewValidationRun) {
  let next = await control(root, run);
  const deadline = Date.now() + 12000;
  while (["planned", "running"].includes(next.status) && Date.now() < deadline) {
    await Bun.sleep(50);
    next = await control(root, run, "status");
  }
  expect(["planned", "running"]).not.toContain(next.status);
  return next;
}
afterEach(async () => {
  for (const { root, run } of fixtures.splice(0)) {
    await control(root, run, "cancel").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("independent commands overlap, output stays in artifacts, and reconnect does not redispatch", async () => {
  const { root, run } = await fixture([
    command(
      "first",
      "touch .orkestrator/first; for i in {1..100}; do [ -f .orkestrator/second ] && break; sleep 0.02; done; test -f .orkestrator/second && printf 'first output'",
    ),
    command(
      "second",
      "touch .orkestrator/second; for i in {1..100}; do [ -f .orkestrator/first ] && break; sleep 0.02; done; test -f .orkestrator/first && printf 'second output'",
    ),
  ]);
  // Concurrent launch acknowledgements can race; the external claim owns dispatch.
  await Promise.all([control(root, run), control(root, run)]);
  const result = await completed(root, run);
  expect(result.status).toBe("completed");
  expect(result.results.map((r) => r.status)).toEqual(["passed", "passed"]);
  expect(JSON.stringify(result)).not.toContain('first output"');
  expect(await readFile(path.join(root, result.results[0]!.stdoutPath!), "utf8")).toBe(
    "first output",
  );
  const restored = await control(root, run);
  expect(restored).toEqual(result);
  expect(result.results[0]!.stdoutSha256).toHaveLength(64);
});

test("shared resources serialize; failed dependencies skip while independent checks finish", async () => {
  const { root, run } = await fixture([
    command(
      "build",
      "mkdir .orkestrator/exclusive; sleep 0.15; rmdir .orkestrator/exclusive; exit 7",
      { resources: ["dist"] },
    ),
    command("other", "mkdir .orkestrator/exclusive; rmdir .orkestrator/exclusive", {
      resources: ["dist"],
    }),
    command("dependent", "exit 0", { dependsOn: ["build"] }),
  ]);
  const result = await completed(root, run);
  expect(result.results.map((r) => r.status)).toEqual(["failed", "passed", "skipped"]);
  expect(result.results[0]!.exitCode).toBe(7);
  expect(result.results[2]!.stdoutPath).toBeNull();
});

test("changed source before or during validation invalidates the snapshot", async () => {
  const before = await fixture([command("check", "exit 0")]);
  await writeFile(path.join(before.root, "source.txt"), "changed\n");
  expect((await completed(before.root, before.run)).status).toBe("failed");
  const during = await fixture([command("check", "printf changed > source.txt")]);
  expect((await completed(during.root, during.run)).error).toContain("changed during validation");
});

test("cancellation terminates children and a cancelled launch cannot start commands", async () => {
  const { root, run } = await fixture([command("slow", "sleep 10; touch .orkestrator/unexpected")]);
  await control(root, run);
  const cancelled = await control(root, run, "cancel");
  expect(cancelled.status).toBe("cancelled");
  expect((await control(root, run)).status).toBe("cancelled");
  const early = await fixture([command("never", "touch .orkestrator/unexpected")]);
  await control(early.root, early.run, "cancel");
  expect((await completed(early.root, early.run)).status).toBe("cancelled");
});

test("timeout and output overflow become incomplete evidence, never assertion failures", async () => {
  const { root, run } = await fixture([
    command("timeout", "sleep 20", { timeoutMs: 1000 }),
    command("overflow", "head -c 34000000 /dev/zero"),
  ]);
  const result = await completed(root, run);
  expect(result.results.map((r) => r.status)).toEqual(["incomplete", "incomplete"]);
  expect(result.results[0]!.limitation).toContain("timed out");
  expect(result.results[1]!.limitation).toContain("incomplete");
  expect(result.results[1]!.stdoutBytes).toBe(32 * 1024 * 1024);
});

test("artifact verification rejects a same-size log replacement", async () => {
  const { root, run } = await fixture([command("check", "printf hello")]);
  const result = await completed(root, run);
  const environment = { environmentType: "local", worktreePath: root } as Environment;
  const runner = async () => "";
  await verifyValidationArtifacts(environment, runner, result.results);
  const artifact = path.join(root, result.results[0]!.stdoutPath!);
  await chmod(artifact, 0o600);
  await writeFile(artifact, "other");
  expect(verifyValidationArtifacts(environment, runner, result.results)).rejects.toThrow(
    "SHA-256 changed",
  );
});

test("plans reject cycles, escaped directories, and excessive transport size", () => {
  const plan = { headRef: "1".repeat(40), commands: [command("a", "true")], limitations: [] };
  expect(parseReviewValidationPlan(plan)).toEqual(plan);
  expect(() =>
    parseReviewValidationPlan({ ...plan, commands: [command("a", "true", { dependsOn: ["a"] })] }),
  ).toThrow();
  expect(() =>
    parseReviewValidationPlan({ ...plan, commands: [command("a", "true", { cwd: "../other" })] }),
  ).toThrow();
  expect(() =>
    parseReviewValidationPlan({
      ...plan,
      commands: Array.from({ length: 32 }, (_, i) => command(`a${i}`, "x".repeat(8000))),
    }),
  ).toThrow();
});

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
    await Bun.sleep(1300);
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

test("a snapshot changed during host admission never executes stale validation", async () => {
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
    expect(done.status).toBe("failed");
    expect(done.error).toContain("changed while");
    expect(done.results[0]!.stdoutPath).toBeNull();
    expect(Bun.file(path.join(root, ".orkestrator/should-not-run")).exists()).resolves.toBe(false);
  } finally {
    scheduler.release(ticket);
    scheduler.close();
  }
});

test("temporary infrastructure exit codes are not reported as assertion failures", async () => {
  const { root, run } = await fixture([command("unavailable", "exit 75")]);
  const done = await completed(root, run);
  expect(done.results[0]).toMatchObject({ status: "incomplete", exitCode: 75 });
  expect(
    parseReviewPreparationValidation(validationPreparation(done).validation, done.id)[0]!.status,
  ).toBe("incomplete");
});

test("incomplete unstarted commands remain incomplete in sealed preparation evidence", () => {
  const run = newReviewValidationRun("review-validation-incomplete", {
    headRef: "a".repeat(40),
    commands: [command("check", "true")],
    limitations: [],
  });
  run.status = "completed";
  Object.assign(run.results[0]!, {
    status: "incomplete",
    limitation: "Capacity wait expired; command did not run",
  });
  expect(isReviewValidationRun(run)).toBe(true);
  const evidence = parseReviewPreparationValidation(validationPreparation(run).validation, run.id);
  expect(evidence[0]).toMatchObject({
    status: "incomplete",
    exitCode: null,
    stdoutPath: null,
    stderrPath: null,
  });
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
    resources: ["resource:" + createHash("sha256").update("shared-database").digest("hex")],
  });
  try {
    await control(root, run);
    await Bun.sleep(1500);
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
