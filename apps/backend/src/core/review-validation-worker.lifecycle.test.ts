// Review validation worker: overlap, resources, cancellation, stop, timeouts and watchdogs, and artifact evidence.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getPriority } from "node:os";
import path from "node:path";
import {
  newReviewValidationRun,
  isReviewValidationRun,
  parseReviewValidationPlan,
} from "@orkestrator/protocol/review-workflow";
import { WORKLOAD_NICE } from "./process-priority.js";
import { verifyValidationArtifacts } from "./review-validation-artifacts.js";
import type { Environment } from "./models.js";
import { validationPreparation } from "./review-validation-service.js";
import { parseReviewPreparationValidation } from "./commands-review.js";
import {
  fixture,
  control,
  observeUntil,
  completed,
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

test.if(process.platform !== "win32")(
  "commands run at the workload priority; the supervisor does not",
  async () => {
    const { root, run } = await fixture([
      command(
        "priority",
        'ps -o ni= -p $$ > .orkestrator/nice; ps -o ni= -p "$PPID" > .orkestrator/worker-nice',
      ),
    ]);
    const result = await completed(root, run);
    expect(result.results[0]!.status).toBe("passed");
    const baseline = getPriority();
    const nice = Number(await readFile(path.join(root, ".orkestrator/nice"), "utf8"));
    const workerNice = Number(await readFile(path.join(root, ".orkestrator/worker-nice"), "utf8"));
    expect(nice).toBeGreaterThanOrEqual(Math.max(baseline, WORKLOAD_NICE));
    expect(workerNice).toBe(baseline);
  },
);

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

test("cancellation terminates children and a cancelled launch cannot start commands", async () => {
  const { root, run } = await fixture([
    command("slow", "sleep 10; touch .orkestrator/unexpected", { weight: 2 }),
    // Several commands may run at once, so only a dependency keeps this one waiting.
    command("never-after-slow", "touch .orkestrator/unexpected-after-slow", {
      dependsOn: ["slow"],
    }),
  ]);
  await control(root, run);
  const runningDeadline = Date.now() + 3_000;
  let running = await control(root, run, "status");
  while (running.results[0]!.status !== "running" && Date.now() < runningDeadline) {
    await Bun.sleep(20);
    running = await control(root, run, "status");
  }
  expect(running.results[0]!.status).toBe("running");
  const cancelled = await control(root, run, "cancel");
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.results[1]).toMatchObject({
    status: "incomplete",
    exitCode: null,
    limitation: "Validation was cancelled before this command started",
  });
  expect(
    parseReviewPreparationValidation(
      validationPreparation(cancelled, { allowCancelled: true }).validation,
      cancelled.id,
    )[1]!.status,
  ).toBe("incomplete");
  expect((await control(root, run)).status).toBe("cancelled");
  expect(existsSync(path.join(root, ".orkestrator", "review-artifacts", ".validation-lock"))).toBe(
    false,
  );
  // The child was killed mid-flight, so it never reached its trailing command.
  expect(existsSync(path.join(root, ".orkestrator", "unexpected"))).toBe(false);
  expect(existsSync(path.join(root, ".orkestrator", "unexpected-after-slow"))).toBe(false);
  const early = await fixture([command("never", "touch .orkestrator/unexpected")]);
  await control(early.root, early.run, "cancel");
  const earlyDone = await completed(early.root, early.run);
  expect(earlyDone.status).toBe("cancelled");
  expect(earlyDone.results[0]).toMatchObject({
    status: "incomplete",
    exitCode: null,
    stdoutPath: null,
    stderrPath: null,
    limitation: "Validation was cancelled before this command started",
  });
  expect(
    parseReviewPreparationValidation(
      validationPreparation(earlyDone, { allowCancelled: true }).validation,
      earlyDone.id,
    )[0],
  ).toMatchObject({ status: "incomplete", exitCode: null });
  // A cancelled launch must not start the command that was never dispatched.
  expect(existsSync(path.join(early.root, ".orkestrator", "unexpected"))).toBe(false);
});

test("stopping one command keeps its partial output and lets the rest of the run finish", async () => {
  const { root, run } = await fixture([
    command("slow", "printf 'partial output'; sleep 10; touch .orkestrator/slow-finished", {
      resources: ["workspace:exclusive"],
      timeoutMs: 60_000,
    }),
    command("after-slow", "touch .orkestrator/after-slow", { dependsOn: ["slow"] }),
    command("blocked", "touch .orkestrator/blocked-ran", { resources: ["workspace:exclusive"] }),
    command("independent", "printf independent"),
  ]);
  await control(root, run);
  await observeUntil(root, run, (next) => next.results[0]!.status === "running", 3_000);
  await observeUntil(root, run, (next) => next.results[3]!.status === "passed", 3_000);

  // The command waiting behind the slow one is skipped before it starts.
  const skipped = await control(root, run, "stop-command", {}, "blocked");
  expect(skipped.results[2]).toMatchObject({
    status: "incomplete",
    stdoutPath: null,
    limitation: "Stopped by the user before it started; validation is incomplete",
  });
  expect(skipped.results[0]!.status).toBe("running");

  const stopped = await control(root, run, "stop-command", {}, "slow");
  expect(stopped.results[0]).toMatchObject({
    status: "incomplete",
    limitation: "Stopped by the user before it completed; validation is incomplete",
  });
  const final = await completed(root, run);
  expect(final.status).toBe("completed");
  expect(final.results.map((result) => result.status)).toEqual([
    "incomplete",
    "skipped",
    "incomplete",
    "passed",
  ]);
  expect(await readFile(path.join(root, final.results[0]!.stdoutPath!), "utf8")).toBe(
    "partial output",
  );
  expect(existsSync(path.join(root, ".orkestrator", "slow-finished"))).toBe(false);
  expect(existsSync(path.join(root, ".orkestrator", "after-slow"))).toBe(false);
  expect(existsSync(path.join(root, ".orkestrator", "blocked-ran"))).toBe(false);
  const evidence = parseReviewPreparationValidation(
    validationPreparation(final).validation,
    final.id,
  );
  expect(evidence.map((entry) => entry.status)).toEqual([
    "incomplete",
    "skipped",
    "incomplete",
    "passed",
  ]);

  // A settled command is left alone; unknown commands are rejected.
  expect(await control(root, run, "stop-command", {}, "independent")).toEqual(final);
  await expect(control(root, run, "stop-command", {}, "missing")).rejects.toThrow(
    "Validation control failed",
  );
});

test("stopping a running cooperative command preserves incomplete evidence", async () => {
  const { root, run } = await cooperativeFixture(
    [
      command("cooperative", "bun cooperative.ts", { timeoutMs: 30_000 }),
      command("dependent", "touch .orkestrator/dependent-ran", { dependsOn: ["cooperative"] }),
      command("independent", "printf independent"),
    ],
    {
      "cooperative.ts": `const fs = require("node:fs");
const publish = () => fs.writeFileSync(process.env.ORKESTRATOR_VALIDATION_SCHEDULER_STATE, JSON.stringify({ version: 1, state: "running", heartbeat: Date.now(), executionMs: 0, queuedMs: 0 }));
publish(); const heartbeat = setInterval(publish, 100);
console.log("partial cooperative output");
await Bun.sleep(20_000);
clearInterval(heartbeat);`,
    },
  );
  await control(root, run);
  // The worker marks a command running before its child has started. Wait for
  // captured output before stopping it so this tests partial-artifact retention.
  await observeUntil(
    root,
    run,
    (next) => next.results[0]?.status === "running" && next.results[0].lastOutputAt !== undefined,
    5_000,
  );
  const stopped = await control(root, run, "stop-command", {}, "cooperative");
  expect(stopped.results[0]).toMatchObject({ status: "incomplete" });
  const done = await completed(root, run);
  expect(done.results.map((result) => result.status)).toEqual(["incomplete", "skipped", "passed"]);
  expect(done.results[0]!.limitation).toContain("Stopped by the user");
  expect(await readFile(path.join(root, done.results[0]!.stdoutPath!), "utf8")).toContain(
    "partial cooperative output",
  );
  expect(existsSync(path.join(root, ".orkestrator/dependent-ran"))).toBe(false);
});

test("a covered command can be stopped while its covering command runs", async () => {
  // The covering command runs until the test releases it after the stop, so
  // the stop always lands while it is running. The wait is bounded, and an
  // unreleased gate fails the command.
  const release = ".orkestrator/covering-release";
  const covering = `i=0; while [ ! -e ${release} ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done; test -e ${release}`;
  const { root, run } = await fixture([
    command("covered", "touch .orkestrator/covered-ran"),
    command("covering", covering),
  ]);
  await writeFile(
    path.join(root, ".orkestrator-test-scheduler.json"),
    JSON.stringify({
      version: 1,
      cooperativeCommands: [],
      commandProfiles: { [covering]: { covers: ["touch .orkestrator/covered-ran"] } },
    }),
  );
  await control(root, run);
  await observeUntil(root, run, (next) => next.results[1]?.status === "running", 3_000);
  const stopped = await control(root, run, "stop-command", {}, "covered");
  expect(stopped.results[0]).toMatchObject({
    status: "incomplete",
    limitation: "Stopped by the user before it started; validation is incomplete",
  });
  await mkdir(path.join(root, ".orkestrator"), { recursive: true });
  await writeFile(path.join(root, release), "");
  const done = await completed(root, run);
  expect(done.results.map((result) => result.status)).toEqual(["incomplete", "passed"]);
  expect(existsSync(path.join(root, ".orkestrator/covered-ran"))).toBe(false);
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
  expect(await verifyValidationArtifacts(environment, runner, result.results)).toEqual({
    artifacts: 2,
    bytes: 5,
  });
  const artifact = path.join(root, result.results[0]!.stdoutPath!);
  await chmod(artifact, 0o600);
  await writeFile(artifact, "other");
  expect(verifyValidationArtifacts(environment, runner, result.results)).rejects.toThrow(
    "SHA-256 changed",
  );
});

test("container artifact verification hashes at the source and reports sizes", async () => {
  const environment = { environmentType: "containerized" } as Environment;
  const digest = "a".repeat(64);
  const entries = [
    { stdoutPath: "out.log", stderrPath: null, stdoutSha256: digest },
    { stdoutPath: null, stderrPath: "err.log", stderrSha256: digest },
  ];
  const calls: string[][] = [];
  const sizes: Record<string, string> = {
    "/workspace/out.log": "12\n",
    "/workspace/err.log": "30",
  };
  const runner = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const target = args.at(-1)!;
    if (command === "realpath") return `${target}\n`;
    if (command === "stat") return sizes[target]!;
    return `${digest}  ${target}\n`;
  };
  expect(await verifyValidationArtifacts(environment, runner, entries)).toEqual({
    artifacts: 2,
    bytes: 42,
  });
  expect(calls.map((call) => call[0])).toEqual([
    "realpath",
    "stat",
    "sha256sum",
    "realpath",
    "stat",
    "sha256sum",
  ]);
  // The validation worker's per-stream bound holds in containers too.
  sizes["/workspace/out.log"] = String(32 * 1024 * 1024 + 1);
  await expect(verifyValidationArtifacts(environment, runner, entries)).rejects.toThrow(
    "exceeds its limit",
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
