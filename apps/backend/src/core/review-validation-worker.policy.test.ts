// Review validation worker: worktree drift, repository profiles, coverage, host grants and on-demand suites.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  newReviewValidationRun,
  isReviewValidationRun,
  REVIEW_VALIDATION_ENVIRONMENT_CHANGE_PATH_MAX,
  REVIEW_VALIDATION_ENVIRONMENT_CHANGES_MAX,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { REVIEW_VALIDATION_WORKER } from "./review-validation-worker.js";
import { createHostTestScheduler } from "@orkestrator/protocol/node/host-test-scheduler";
import { validationPreparation } from "./review-validation-service.js";
import {
  gitOnPath,
  fixture,
  control,
  observeUntil,
  completed,
  waitFor,
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

test("an identical repeated command runs once and its copy is recorded as covered", async () => {
  const { root, run } = await fixture([
    command("cold", "echo run >> .orkestrator/runs"),
    command("warm", "echo run >> .orkestrator/runs", { dependsOn: ["cold"] }),
    command("after", "touch .orkestrator/after-ran", { dependsOn: ["warm"] }),
  ]);
  const done = await completed(root, run);
  expect(done.plan).toEqual(run.plan);
  expect(done.results.map((result) => result.status)).toEqual(["passed", "skipped", "passed"]);
  expect(done.results[1]!.limitation).toBe("Covered by cold (identical command)");
  expect(await readFile(path.join(root, ".orkestrator/runs"), "utf8")).toBe("run\n");
  expect(existsSync(path.join(root, ".orkestrator/after-ran"))).toBe(true);
});

test("an identical command still reruns after setup its first copy did not wait for", async () => {
  const { root, run } = await fixture([
    command("before", "echo run >> .orkestrator/runs"),
    command("migrate", "touch .orkestrator/migrated", { dependsOn: ["before"] }),
    command("again", "echo run >> .orkestrator/runs", { dependsOn: ["migrate"] }),
  ]);
  const done = await completed(root, run);
  expect(done.results.map((result) => result.status)).toEqual(["passed", "passed", "passed"]);
  expect(await readFile(path.join(root, ".orkestrator/runs"), "utf8")).toBe("run\nrun\n");
});

test("a repeat of a failed command is incomplete rather than skipped as passing", async () => {
  const { root, run } = await fixture([
    command("first", "echo run >> .orkestrator/runs; exit 1"),
    command("repeat", "echo run >> .orkestrator/runs; exit 1"),
  ]);
  const done = await completed(root, run);
  expect(done.results.map((result) => result.status)).toEqual(["failed", "incomplete"]);
  expect(done.results[1]!.limitation).toBe("Covering validation first did not pass");
  expect(await readFile(path.join(root, ".orkestrator/runs"), "utf8")).toBe("run\n");
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

// Playwright otherwise starts half the host's cores whatever was reserved, so
// the browser suite ran eight workers on a three-slot grant beside the full
// unit suite and timed out across unrelated specs (2026-10-31).
test("a command learns the slots it was granted and that review validation runs it", async () => {
  const report = `printf '%s %s' "$ORKESTRATOR_VALIDATION_GRANTED_WORKERS" "$ORKESTRATOR_REVIEW_VALIDATION"`;
  const { root, run } = await fixture([command("sized", report)]);
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: [],
      commandProfiles: { [report]: { resources: [], workers: 3, memoryMiB: 256 } },
    }),
  );
  const done = await waitFor(root, run, 12000, {
    ORKESTRATOR_TEST_HOST_WORKERS: "4",
    ORKESTRATOR_TEST_HOST_MEMORY_MIB: "1024",
    // An inherited value must not stand in for the grant.
    ORKESTRATOR_VALIDATION_GRANTED_WORKERS: "16",
  });
  expect(done.results[0]).toMatchObject({ status: "passed", reservedWorkers: 3 });
  expect(await readFile(path.join(root, done.results[0]!.stdoutPath!), "utf8")).toBe("3 1");
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

test("drift-check Git calls disable optional locks", async () => {
  const { root, run } = await fixture([command("check", "exit 0")]);
  const calls = path.join(root, ".git", "lock-settings");
  const env = await gitOnPath(`printf '%s:%s\\n' "$GIT_OPTIONAL_LOCKS" "$*" >> '${calls}'`);
  // Exercise the complete worker, including HEAD, status and usage-scope reads.
  const started = await control(root, run, "start", { ...env, GIT_OPTIONAL_LOCKS: "1" });
  if (["planned", "running"].includes(started.status)) {
    await observeUntil(root, run, (next) => !["planned", "running"].includes(next.status), 12_000);
  }
  const done = await control(root, run, "status");
  expect(done.status).toBe("completed");
  const recorded = (await readFile(calls, "utf8")).trim().split("\n");
  expect(recorded).toContain("0:rev-parse --verify HEAD^{commit}");
  expect(recorded).toContain("0:status --porcelain=v1 -z --untracked-files=all");
  expect(recorded).toContain("0:rev-parse --git-common-dir");
  expect(recorded.every((call) => call.startsWith("0:"))).toBe(true);
}, 15_000);

for (const interpreter of ["bun", "node"]) {
  test(`status timeout reports ETIMEDOUT and retries without fsmonitor (${interpreter})`, async () => {
    const { root } = await fixture();
    const calls = path.join(root, ".git", "status-calls");
    const env = await gitOnPath(`
printf '%s:%s\\n' "$GIT_OPTIONAL_LOCKS" "$*" >> '${calls}'
if [ "$1" = "status" ]; then
  exec '${process.execPath}' -e 'setInterval(() => {}, 1000)'
fi
`);
    // Execute the worker's exact status/path helpers with a shorter deadline.
    // This is a real spawnSync timeout, rather than an invented error object.
    // The deadline must outlast the fake Git's startup, or it dies before it
    // records the call this test asserts on.
    const helpers = REVIEW_VALIDATION_WORKER.slice(
      REVIEW_VALIDATION_WORKER.indexOf("function gitOptions()"),
      REVIEW_VALIDATION_WORKER.indexOf("const seenDriftPaths"),
    ).replace("timeout: 10000", "timeout: 2000");
    const script = `const { spawnSync } = require("node:child_process");
const root = ${JSON.stringify(root)};
${helpers}
const status = worktreeStatus();
process.stdout.write(JSON.stringify({ status: status.status, error: status.error?.code, stdout: status.stdout }));`;
    await writeFile(path.join(root, "source.txt"), "changed\n");
    const child = Bun.spawn([interpreter, "-e", script], {
      env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ status: 0, stdout: " M source.txt\0" });
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "0:status --porcelain=v1 -z --untracked-files=all",
      "0:-c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all",
    ]);
  }, 10_000);
}

test("worker captures drift after a real status timeout, and preserves non-timeout failures", async () => {
  for (const timeout of [true, false]) {
    const { root, run } = await fixture([command("check", "exit 0")]);
    const calls = path.join(root, ".git", "status-calls");
    const env = await gitOnPath(`
if [ "$1" = "status" ]; then
  printf 'initial\\n' >> '${calls}'
  ${timeout ? `exec '${process.execPath}' -e 'setInterval(() => {}, 1000)'` : "exit 128"}
fi
if [ "$1" = "-c" ]; then printf 'fallback\\n' >> '${calls}'; fi
`);
    await writeFile(path.join(root, "source.txt"), "changed\n");
    await control(
      root,
      run,
      "start",
      env,
      undefined,
      REVIEW_VALIDATION_WORKER.replace(
        'spawnSync("git", args, gitOptions())',
        'spawnSync("git", args, { ...gitOptions(), timeout: 500 })',
      ),
    );
    const done = await observeUntil(
      root,
      run,
      (next) => !["planned", "running"].includes(next.status),
      12_000,
    );
    expect(done.error ?? "").not.toContain("HEAD changed");
    const recorded = await readFile(calls, "utf8");
    if (timeout) {
      expect(done.status).toBe("completed");
      expect(done.environmentChanges).toEqual(["source.txt"]);
      expect(recorded).toContain("fallback");
    } else {
      expect(done.status).toBe("failed");
      expect(done.error).toContain("Git status could not be read");
      expect(recorded).not.toContain("fallback");
    }
  }
}, 20_000);

test("ordinary commands get a dedicated host grant without changing package parallelism", async () => {
  for (const packageWorkers of [undefined, "2"]) {
    const { root, run } = await fixture([
      command(
        "environment",
        'printf "%s,%s,%s" "${ORKESTRATOR_TEST_WORKERS-unset}" "$ORKESTRATOR_VALIDATION_GRANTED_WORKERS" "$ORKESTRATOR_REVIEW_VALIDATION"',
      ),
    ]);
    const done = await waitFor(root, run, 10000, {
      ORKESTRATOR_TEST_WORKERS: packageWorkers,
      ORKESTRATOR_VALIDATION_GRANTED_WORKERS: "99",
    });
    expect(done.results[0]!.status).toBe("passed");
    const result = done.results[0]!;
    expect(await readFile(path.join(root, result.stdoutPath!), "utf8")).toBe(
      `${packageWorkers ?? "unset"},${result.reservedWorkers},1`,
    );
  }
}, 30000);

test("a bridge validation plan keeps every package's serial worker default", async () => {
  const bridges = ["claude", "codex", "cursor", "pi", "acp"];
  const commands = await Promise.all(
    bridges.map(async (bridge) => {
      const manifest = JSON.parse(
        await readFile(
          path.resolve(import.meta.dir, `../../../../bridges/${bridge}-bridge/package.json`),
          "utf8",
        ),
      ) as { scripts: { "test:bridge": string } };
      // Execute the repository's real shell expansion, recording the Bun argv
      // instead of launching five unrelated suites inside this regression.
      return command(bridge, `bun() { printf '%s\\n' "$@"; }; ${manifest.scripts["test:bridge"]}`);
    }),
  );
  const { root, run } = await fixture(commands);
  const done = await waitFor(root, run, 15000, { ORKESTRATOR_TEST_WORKERS: undefined });
  expect(done.results.map((result) => result.status)).toEqual(bridges.map(() => "passed"));
  for (const result of done.results) {
    expect((await readFile(path.join(root, result.stdoutPath!), "utf8")).split("\n")).toContain(
      "--parallel=1",
    );
  }
}, 20000);

describe("repository-declared on-demand suites", () => {
  /** A branch off `origin/main` that changed only `src/feature.ts`. */
  async function onDemandFixture() {
    const context = await fixture([
      command("full", "printf full"),
      command("docker", "printf docker"),
      command("browser", "printf browser"),
    ]);
    context.git("update-ref", "refs/remotes/origin/main", "HEAD");
    await writeFile(
      path.join(context.root, ".orkestrator-test-scheduler.json"),
      JSON.stringify({
        version: 1,
        cooperativeCommands: [],
        commandProfiles: {
          "printf full": {
            onDemand: { when: ["scripts/test-tiers.ts"], instead: "printf fallback" },
          },
          "printf docker": { onDemand: { when: ["docker/**"] } },
          "printf browser": { onDemand: { when: ["src/**"] } },
        },
      }),
    );
    await mkdir(path.join(context.root, "src"), { recursive: true });
    await writeFile(path.join(context.root, "src", "feature.ts"), "export {};\n");
    context.git("add", ".");
    context.git("commit", "-m", "feature");
    context.run.plan.headRef = context.git("rev-parse", "HEAD");
    return context;
  }

  async function run(root: string, validation: ReviewValidationRun, targetRef?: string) {
    await control(root, validation, "start", {}, undefined, REVIEW_VALIDATION_WORKER, targetRef);
    await observeUntil(
      root,
      validation,
      (next) => !["planned", "running"].includes(next.status),
      12_000,
    );
    return control(root, validation, "status");
  }

  const output = (root: string, result: ReviewValidationRun["results"][number]) =>
    readFile(path.join(root, result.stdoutPath!), "utf8");

  test("an untriggered suite runs its replacement or nothing; a triggered one runs", async () => {
    const { root, run: validation } = await onDemandFixture();
    const final = await run(root, validation, "origin/main");
    expect(final.status).toBe("completed");
    const [full, docker, browser] = final.results;
    // The record keeps the planned command; the limitation says what ran.
    expect(full).toMatchObject({ command: "printf full", status: "passed" });
    expect(await output(root, full!)).toBe("fallback");
    expect(full!.limitation).toBe(
      "Ran printf fallback in its place: .orkestrator-test-scheduler.json runs printf full only when the change touches scripts/test-tiers.ts, and this change does not",
    );
    expect(docker).toMatchObject({ status: "skipped", stdoutPath: null });
    expect(docker!.limitation).toStartWith("On demand, not run:");
    expect(browser).toMatchObject({ status: "passed", limitation: null });
    expect(await output(root, browser!)).toBe("browser");
  }, 20000);

  test("failed diff lookup keeps all planned suites", async () => {
    const { root, run: validation } = await onDemandFixture();
    const final = await run(root, validation, "origin/nonexistent");
    expect(final.results.map((result) => result.status)).toEqual(["passed", "passed", "passed"]);
    expect(await output(root, final.results[0]!)).toBe("full");
  }, 20000);

  for (const succeeds of [true, false]) {
    test(`replacement coverage and dependents preserve ${succeeds ? "success" : "failure"}`, async () => {
      const replacement = succeeds ? "printf replacement" : "exit 1";
      const context = await fixture([
        command("full", "printf full"),
        command("duplicate", replacement),
        command("covered", "printf covered"),
        command("after", "printf after", { dependsOn: ["covered"] }),
        command("skipped", "printf optional"),
        command("after-skipped", "printf unsafe", { dependsOn: ["skipped"] }),
      ]);
      context.git("update-ref", "refs/remotes/origin/main", "HEAD");
      await writeFile(
        path.join(context.root, ".orkestrator-test-scheduler.json"),
        JSON.stringify({
          version: 1,
          cooperativeCommands: [],
          commandProfiles: {
            "printf full": { onDemand: { when: ["docker/**"], instead: replacement } },
            [replacement]: { covers: ["printf covered"] },
            "printf optional": { onDemand: { when: ["docker/**"] } },
          },
        }),
      );
      context.git("add", ".");
      context.git("commit", "-m", "policy");
      context.run.plan.headRef = context.git("rev-parse", "HEAD");
      const final = await run(context.root, context.run, "origin/main");
      expect(final.results.map((result) => result.status)).toEqual(
        succeeds
          ? ["passed", "skipped", "skipped", "passed", "skipped", "skipped"]
          : ["failed", "incomplete", "incomplete", "skipped", "skipped", "skipped"],
      );
      expect(final.results[0]!.limitation).toContain("in its place");
      expect(final.results[5]!.limitation).toBe("A prerequisite did not pass");
    }, 20000);
  }

  test("without a target ref every command runs as planned", async () => {
    const { root, run: validation } = await onDemandFixture();
    const final = await run(root, validation);
    expect(final.results.map((result) => result.status)).toEqual(["passed", "passed", "passed"]);
    expect(await output(root, final.results[0]!)).toBe("full");
  }, 20000);
});
