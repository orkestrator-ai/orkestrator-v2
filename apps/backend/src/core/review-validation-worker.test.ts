import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  newReviewValidationRun,
  isReviewValidationRun,
  parseReviewValidationPlan,
  REVIEW_VALIDATION_ENVIRONMENT_CHANGE_PATH_MAX,
  REVIEW_VALIDATION_ENVIRONMENT_CHANGES_MAX,
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
const extraRoots: string[] = [];
async function gitOnPath(script: string): Promise<Record<string, string>> {
  const bin = await mkdtemp(path.join(tmpdir(), "review-validation-git-"));
  extraRoots.push(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await writeFile(
    path.join(bin, "git"),
    `#!/usr/bin/env bash\n${script}\nexec ${JSON.stringify(realGit)} "$@"\n`,
    { mode: 0o755 },
  );
  return { PATH: `${bin}:${process.env.PATH}` };
}
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
async function waitUntilQueued(root: string, run: ReviewValidationRun) {
  const deadline = Date.now() + 3000;
  let next = await control(root, run, "status");
  while (next.results[0]!.status !== "queued" && Date.now() < deadline) {
    await Bun.sleep(20);
    next = await control(root, run, "status");
  }
  expect(next.results[0]!.status).toBe("queued");
  return next;
}
async function waitFor(
  root: string,
  run: ReviewValidationRun,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
) {
  let next = await control(root, run, "start", extraEnv);
  const deadline = Date.now() + timeoutMs;
  while (["planned", "running"].includes(next.status) && Date.now() < deadline) {
    await Bun.sleep(100);
    next = await control(root, run, "status");
  }
  expect(["planned", "running"]).not.toContain(next.status);
  return next;
}
async function cooperativeFixture(
  commands: ReviewValidationPlan["commands"],
  scripts: Record<string, string>,
) {
  const context = await fixture(commands);
  const modulePath = path.resolve(import.meta.dir, "../../../../scripts/test-admission.ts");
  await writeFile(
    path.join(context.root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: Object.keys(scripts).map((name) => `bun ${name}`),
    }),
  );
  for (const [name, source] of Object.entries(scripts))
    await writeFile(
      path.join(context.root, name),
      source.replaceAll("__MODULE__", JSON.stringify(modulePath)),
    );
  context.git("add", ".");
  context.git("commit", "-m", "cooperative runner");
  context.run.plan.headRef = context.git("rev-parse", "HEAD");
  return context;
}
afterEach(async () => {
  for (const { root, run } of fixtures.splice(0)) {
    await control(root, run, "cancel").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
  await Promise.all(extraRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

test("worktree drift before or during validation is recorded without failing the run", async () => {
  const before = await fixture([command("check", "exit 0")]);
  await writeFile(path.join(before.root, "source.txt"), "changed\n");
  const dirtyBefore = await completed(before.root, before.run);
  expect(dirtyBefore.status).toBe("completed");
  expect(dirtyBefore.error).toBeUndefined();
  expect(dirtyBefore.results[0]!.status).toBe("passed");
  expect(dirtyBefore.environmentChanges).toEqual(["source.txt"]);
  expect(validationPreparation(dirtyBefore).uncommittedFiles).toEqual([
    { path: "source.txt", reason: "Changed since the review snapshot" },
  ]);
  const during = await fixture([command("check", "printf extra > extra.txt")]);
  await writeFile(path.join(during.root, "source.txt"), "changed\n");
  const dirtyDuring = await completed(during.root, during.run);
  expect(dirtyDuring.status).toBe("completed");
  expect(dirtyDuring.error).toBeUndefined();
  expect(dirtyDuring.environmentChanges).toEqual(["extra.txt", "source.txt"]);
});

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

test("records unquoted rename destinations and non-ASCII worktree paths", async () => {
  const { root, run, git } = await fixture([command("check", "exit 0")]);
  await writeFile(path.join(root, "α-file.txt"), "untracked\n");
  git("mv", "source.txt", "renamed.txt");
  const done = await completed(root, run);
  expect(done.status).toBe("completed");
  expect(done.environmentChanges).toEqual(["renamed.txt", "source.txt", "α-file.txt"]);
});

test("records a filename that contains a newline from NUL porcelain", async () => {
  const { root, run } = await fixture([command("check", "exit 0")]);
  await writeFile(path.join(root, "weird\nname.txt"), "untracked\n");
  const done = await completed(root, run);
  expect(done.status).toBe("completed");
  expect(done.environmentChanges).toEqual(["weird\nname.txt"]);
});

test("records untracked directory entries with a trailing slash", async () => {
  const { root, run } = await fixture([command("check", "exit 0")]);
  const done = await waitFor(
    root,
    run,
    12_000,
    await gitOnPath(`
for arg in "$@"; do
  if [ "$arg" = "--porcelain=v1" ]; then
    printf '?? nested/\\0'
    exit 0
  fi
done
`),
  );
  expect(done.status).toBe("completed");
  expect(done.environmentChanges).toEqual(["nested/"]);
});

test("fails when git status cannot be parsed as porcelain", async () => {
  const { root, run } = await fixture([command("check", "exit 0")]);
  const done = await waitFor(
    root,
    run,
    12_000,
    await gitOnPath(`
for arg in "$@"; do
  if [ "$arg" = "--porcelain=v1" ]; then
    printf 'not porcelain\\n'
    exit 0
  fi
done
`),
  );
  expect(done.status).toBe("failed");
  expect(done.error).toContain("Git status could not be read");
});

test("drops overlong drifted paths and makes a 1024-path cap observable", async () => {
  const { root, run } = await fixture([command("check", "exit 0")]);
  await mkdir(path.join(root, "drift"));
  await Promise.all(
    Array.from({ length: REVIEW_VALIDATION_ENVIRONMENT_CHANGES_MAX + 16 }, (_, index) =>
      writeFile(path.join(root, "drift", `f-${String(index).padStart(4, "0")}.txt`), "changed\n"),
    ),
  );
  const done = await completed(root, run);
  expect(done.status).toBe("completed");
  expect(done.environmentChanges).toHaveLength(REVIEW_VALIDATION_ENVIRONMENT_CHANGES_MAX);
  expect(done.environmentChanges?.[0]).toBe("drift/f-0000.txt");
  expect(done.environmentChanges?.at(-1)).toBe("drift/f-1023.txt");
  expect(done.environmentChangesOmitted).toBe(16);
  expect(isReviewValidationRun(done)).toBe(true);
  expect(validationPreparation(done).limitations).toEqual([
    "Environment change list was truncated; 16 additional paths were omitted",
  ]);

  const filtered = await fixture([command("check", "exit 0")]);
  const overlong = await waitFor(
    filtered.root,
    filtered.run,
    12_000,
    await gitOnPath(`
for arg in "$@"; do
  if [ "$arg" = "--porcelain=v1" ]; then
    python3 -c 'import sys; sys.stdout.buffer.write(b"?? " + b"a" * ${REVIEW_VALIDATION_ENVIRONMENT_CHANGE_PATH_MAX + 1} + b"\\0?? kept.txt\\0")'
    exit 0
  fi
done
`),
  );
  expect(overlong.status).toBe("completed");
  expect(overlong.environmentChanges).toEqual(["kept.txt"]);
  expect(overlong.environmentChangesOmitted).toBeUndefined();
}, 30_000);

test("environmentChangesOmitted must be a positive integer when present", () => {
  const run = newReviewValidationRun("review-validation-omitted", {
    headRef: "a".repeat(40),
    commands: [command("check", "true")],
    limitations: [],
  });
  run.status = "completed";
  Object.assign(run.results[0]!, { status: "passed", exitCode: 0 });
  run.environmentChanges = ["source.txt"];
  run.environmentChangesOmitted = 3;
  expect(isReviewValidationRun(run)).toBe(true);
  run.environmentChangesOmitted = 0;
  expect(isReviewValidationRun(run)).toBe(false);
});

test("HEAD change after discovery still fails validation", async () => {
  const { root, run, git } = await fixture([command("check", "exit 0")]);
  await writeFile(path.join(root, "source.txt"), "committed change\n");
  git("add", ".");
  git("commit", "-m", "moved head");
  const result = await completed(root, run);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("HEAD changed");
  expect(result.results[0]!.status).toBe("pending");
});

test("cancellation terminates children and a cancelled launch cannot start commands", async () => {
  const { root, run } = await fixture([command("slow", "sleep 10; touch .orkestrator/unexpected")]);
  await control(root, run);
  const cancelled = await control(root, run, "cancel");
  expect(cancelled.status).toBe("cancelled");
  expect((await control(root, run)).status).toBe("cancelled");
  // The child was killed mid-flight, so it never reached its trailing command.
  expect(existsSync(path.join(root, ".orkestrator", "unexpected"))).toBe(false);
  const early = await fixture([command("never", "touch .orkestrator/unexpected")]);
  await control(early.root, early.run, "cancel");
  expect((await completed(early.root, early.run)).status).toBe("cancelled");
  // A cancelled launch must not start the command that was never dispatched.
  expect(existsSync(path.join(early.root, ".orkestrator", "unexpected"))).toBe(false);
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

test("a ready foreground service is stopped by the no-output watchdog before its absolute timeout", async () => {
  const { root, run } = await fixture([
    command("stuck", "printf ready; sleep 60", { timeoutMs: 60000 }),
  ]);
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: [],
      commandProfiles: { [run.plan.commands[0]!.command]: { noProgressTimeoutMs: 5000 } },
    }),
  );
  await control(root, run, "start", { ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS: "1000" });
  const result = await completed(root, run);
  expect(result.results[0]!.status).toBe("incomplete");
  expect(result.results[0]!.limitation).toContain("no output for 1000ms");
  expect(result.results[0]!.durationMs).toBeLessThan(10000);
  expect(result.results[0]!.lastOutputAt).toBeDefined();
  expect((await control(root, run, "status")).results[0]!.lastOutputAt).toBe(
    result.results[0]!.lastOutputAt,
  );
});

test("stdout and stderr progress reset the ordinary command watchdog", async () => {
  const { root, run } = await fixture([
    command("progress", "for i in 1 2 3 4 5 6; do printf progress >&2; sleep 0.3; done"),
  ]);
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: [],
      commandProfiles: { [run.plan.commands[0]!.command]: { noProgressTimeoutMs: 5000 } },
    }),
  );
  await control(root, run, "start", { ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS: "1000" });
  const result = await completed(root, run);
  expect(result.results[0]!.status).toBe("passed");
  expect(result.results[0]!.stderrBytes).toBe(48);
  expect(result.results[0]!.lastOutputAt).toBeDefined();
});

test("a healthy quiet command runs until its declared timeout without an opted-in watchdog", async () => {
  const { root, run } = await fixture([command("quiet", "sleep 1.2", { timeoutMs: 5000 })]);
  await control(root, run, "start", { ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS: "1000" });
  const result = await completed(root, run);
  expect(result.results[0]).toMatchObject({ status: "passed", exitCode: 0, limitation: null });
  expect(result.results[0]!.durationMs).toBeGreaterThanOrEqual(1000);
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

test("a failed second artifact open becomes a metadata-only incomplete result", async () => {
  const { root, run } = await fixture([command("check", "printf hello")]);
  const artifactDirectory = path.join(root, ".orkestrator", "review-artifacts", run.id);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(path.join(artifactDirectory, "validation-01.stderr.txt"), "pre-existing\n");
  const done = await completed(root, run);
  expect(done.status).toBe("completed");
  expect(done.results[0]).toMatchObject({
    status: "incomplete",
    stdoutPath: null,
    stderrPath: null,
  });
  expect(done.results[0]!.limitation).toBeTruthy();
  // The one-sided pair must remain parseable preparation evidence.
  const evidence = parseReviewPreparationValidation(
    validationPreparation(done).validation,
    done.id,
  );
  expect(evidence[0]).toMatchObject({ status: "incomplete", stdoutPath: null, stderrPath: null });
});

test("repository profiles avoid redundant suites and preserve dependent checks and plan identity", async () => {
  const { root, run } = await fixture([
    command("changed", "touch .orkestrator/changed-ran"),
    command("full", "touch .orkestrator/full-ran"),
    command("all", "touch .orkestrator/all-ran"),
    command("after", "touch .orkestrator/after-ran", { dependsOn: ["changed", "full"] }),
  ]);
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: [],
      commandProfiles: {
        [run.plan.commands[1]!.command]: { covers: [run.plan.commands[0]!.command] },
        [run.plan.commands[2]!.command]: {
          covers: run.plan.commands.slice(0, 2).map((cmd) => cmd.command),
        },
      },
    }),
  );
  const done = await completed(root, run);
  expect(done.plan).toEqual(run.plan);
  expect(done.results.map((result) => result.status)).toEqual([
    "skipped",
    "skipped",
    "passed",
    "passed",
  ]);
  expect(done.results[0]!.limitation).toContain("Covered by all");
  expect(existsSync(path.join(root, ".orkestrator/changed-ran"))).toBe(false);
  expect(existsSync(path.join(root, ".orkestrator/full-ran"))).toBe(false);
  expect(existsSync(path.join(root, ".orkestrator/all-ran"))).toBe(true);
  expect(existsSync(path.join(root, ".orkestrator/after-ran"))).toBe(true);
});

test("coverage does not remove prerequisites or turn a failed covering suite into success", async () => {
  const { root, run } = await fixture([
    command("setup", "touch .orkestrator/setup-ran"),
    command("full", "exit 1", { dependsOn: ["setup"] }),
    command("changed", "touch .orkestrator/changed-ran"),
    command("after", "touch .orkestrator/after-ran", { dependsOn: ["changed"] }),
  ]);
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: [],
      commandProfiles: {
        "exit 1": { covers: [run.plan.commands[0]!.command, run.plan.commands[2]!.command] },
      },
    }),
  );
  const done = await completed(root, run);
  expect(done.results.map((result) => result.status)).toEqual([
    "passed",
    "failed",
    "incomplete",
    "skipped",
  ]);
  expect(existsSync(path.join(root, ".orkestrator/setup-ran"))).toBe(true);
  expect(existsSync(path.join(root, ".orkestrator/changed-ran"))).toBe(false);
});

test("a profile requesting more than the host budget is clamped, not refused", async () => {
  const { root, run } = await fixture([command("heavy", "printf heavy")]);
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: [],
      commandProfiles: { "printf heavy": { resources: [], workers: 8, memoryMiB: 4096 } },
    }),
  );
  // Both declarations exceed this host ceiling; enqueue would reject them
  // outright, leaving the command permanently incomplete on a small machine.
  const done = await waitFor(root, run, 12000, {
    ORKESTRATOR_TEST_HOST_WORKERS: "1",
    ORKESTRATOR_TEST_HOST_MEMORY_MIB: "256",
  });
  expect(done.results[0]).toMatchObject({ status: "passed", exitCode: 0, limitation: null });
});

test("an unusable scheduling config degrades to plain scheduling instead of losing every result", async () => {
  const { root, run } = await fixture([
    command("first", "printf first"),
    command("second", "printf second", { dependsOn: ["first"] }),
  ]);
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: ["printf first"],
      commandProfiles: { "printf second": { workers: 0 } },
    }),
  );
  const done = await completed(root, run);
  expect(done.status).toBe("completed");
  expect(done.results.map((result) => result.status)).toEqual(["passed", "passed"]);
  expect(done.error).toContain(".orkestrator-test-scheduler.json was ignored");
  // The declared cooperative command is scheduled as an ordinary one, so it must
  // not be left waiting for a reservation it never makes.
  expect(done.results[0]!.limitation).toBeNull();
});

test("malformed scheduling config JSON is ignored with the file named on the run", async () => {
  const { root, run } = await fixture([command("only", "printf only")]);
  await writeFile(path.join(root, ".orkestrator-test-scheduler.json"), "{not json");
  const done = await completed(root, run);
  expect(done.status).toBe("completed");
  expect(done.results[0]!.status).toBe("passed");
  expect(done.error).toContain(".orkestrator-test-scheduler.json was ignored");
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
    await control(root, run, "start", { ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS: "6000" });
    // The reason is written by the worker's heartbeat, not by the enqueue that
    // first reports "queued", so wait for the explanation itself.
    let queued = await waitUntilQueued(root, run);
    const explained = Date.now() + 3000;
    while (!queued.results[0]!.queueReason && Date.now() < explained) {
      await Bun.sleep(50);
      queued = await control(root, run, "status");
    }
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

test("precise repository resource profiles admit lightweight checks with spare host capacity", async () => {
  const { root, run } = await fixture([
    command("small", "printf small", { resources: ["host:*"], weight: 2 }),
  ]);
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: [],
      commandProfiles: { "printf small": { resources: [], workers: 1, memoryMiB: 64 } },
    }),
  );
  const scheduler = createHostTestScheduler({
    directory: path.join(root, ".orkestrator", "scheduler"),
    workers: 2,
    memoryMiB: 4096,
  });
  const blocker = scheduler.enqueue({ owner: "b".repeat(64), workers: 1, memoryMiB: 64 });
  try {
    const done = await completed(root, run);
    expect(done.results[0]!.status).toBe("passed");
    expect(done.plan).toEqual(run.plan);
  } finally {
    scheduler.release(blocker);
    scheduler.close();
  }
});

test("coverage aliases cannot introduce dependency cycles or bypass required setup", async () => {
  const { root, run } = await fixture([
    command("b", "printf b"),
    command("d", "printf d"),
    command("a", "printf a", { dependsOn: ["d"] }),
    command("c", "printf c", { dependsOn: ["b"] }),
    command("setup", "printf setup"),
    command("narrow", "printf narrow", { dependsOn: ["setup"] }),
    command("wide", "printf wide"),
  ]);
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: [],
      commandProfiles: {
        "printf a": { covers: ["printf b"] },
        "printf c": { covers: ["printf d"] },
        "printf wide": { covers: ["printf narrow"] },
      },
    }),
  );
  const done = await completed(root, run);
  expect(done.results.map((result) => result.status)).toEqual([
    "skipped",
    "passed",
    "passed",
    "passed",
    "passed",
    "passed",
    "passed",
  ]);
});

test("cooperative parallel groups do not multiply queue or execution deadlines", async () => {
  const { root, run } = await cooperativeFixture(
    [command("parallel", "bun parallel.ts", { weight: 2, timeoutMs: 1000 })],
    {
      "parallel.ts": `import { createTestAdmission } from __MODULE__;
const admission = createTestAdmission(import.meta.dir, process.env, console.log);
const jobs = ["a", "b"].map(name => admission.run({ name, command: "unused", args: [], workers: 1 }, async () => { await Bun.sleep(650); return { status: 0 }; }));
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
    await control(root, run, "start", { ORKESTRATOR_TEST_QUEUE_TIMEOUT_MS: "1000" });
    const deadline = Date.now() + 5000;
    while (!existsSync(path.join(root, ".orkestrator/enqueued")) && Date.now() < deadline)
      await Bun.sleep(20);
    expect(existsSync(path.join(root, ".orkestrator/enqueued"))).toBe(true);
    await Bun.sleep(650);
    const waiting = await control(root, run, "status");
    expect(waiting.results[0]!.status).toBe("queued");
    expect(waiting.results[0]!.queueReason).toContain("worker slots");
    scheduler.release(blocker);
    const done = await completed(root, run);
    expect(done.results[0]!.status).toBe("passed");
    expect(done.results[0]!.durationMs).toBeLessThan(1000);
    expect(done.results[0]!.queuedMs).toBeLessThan(1000);
    expect(done.results[0]!.queueReason).toBeUndefined();
  } finally {
    scheduler.release(blocker);
    scheduler.close();
  }
}, 15000);

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
});

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
